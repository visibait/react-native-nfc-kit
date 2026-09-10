/**
 * Sessions.
 *
 * A session owns the radio: reader mode on Android, an `NFCReaderSession` on iOS.
 * Leaving one open is the single most common bug when working with NFC from React
 * Native, and it is not a benign one -- on iOS the system sheet stays up and the
 * next scan fails with `systemBusy`, and on Android the app keeps exclusive
 * control of the NFC controller so nothing else on the phone can read a tag.
 *
 * So the default entry point is scoped:
 *
 * ```ts
 * const uid = await nfc.withTag({ tech: ['ndef'] }, async (tag) => {
 *   if (!tag.is('ndef')) throw new Error('not an NDEF tag');
 *   return (await tag.readNdef())[0]?.id;
 * });
 * // the session is closed here, whatever happened inside
 * ```
 *
 * `withTag` closes on every path out: success, a throw from the callback, an
 * abort, a timeout, or the platform invalidating the session underneath it. There
 * is no way to forget.
 *
 * `openSession` exists for flows the scoped form cannot express -- reading several
 * tags with your own UI in between -- and implements `AsyncDisposable` so
 * `await using` still cleans up. `nfc.onTag` covers continuous reading, where the
 * session lives as long as somebody is listening.
 */

import { NfcError, type NfcPlatform } from '../errors.js';
import type {
  NativeNfcKitModule,
  NativeSessionOptions,
  NativeSubscription,
  NativeTagInfo,
  TagTech,
} from '../native/contract.js';
import { callNative, fromNativeErrorPayload } from '../native/errors.js';
import { Deferred, abortedError, runWithDeadline, type Deadline } from './async.js';
import { Listeners, type Subscription } from './subscription.js';
import { createTag, type Tag, type TagRuntime } from './tag.js';

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Per-session polling configuration.
 *
 * A configuration object rather than a flat bitmask, because iOS 26.4 introduced
 * `NFCTagReaderSession.Configuration` and deprecated the old initialiser: AIDs and
 * FeliCa system codes can now be narrowed per session instead of only globally in
 * the entitlements. Below 26.4 the narrowing fields are ignored and the values
 * from Info.plist apply -- reported through `capabilities.perSessionConfig` rather
 * than left to be discovered.
 */
export interface SessionConfig {
  /**
   * iOS polling options. Derived from the requested technologies when omitted,
   * which is what almost every caller wants.
   */
  readonly polling?: readonly ('iso14443' | 'iso15693' | 'iso18092' | 'pace')[];
  /** iOS: a subset of the AIDs declared in Info.plist. */
  readonly iso7816SelectIdentifiers?: readonly string[];
  /** iOS: a subset of the FeliCa system codes declared in Info.plist. */
  readonly feliCaSystemCodes?: readonly string[];
}

export interface IosScanOptions {
  /** Text shown in the system scanning sheet. */
  readonly alertMessage?: string;
  /**
   * Ends the session as soon as one tag has been read.
   *
   * Leave it off for `openSession`, which exists precisely to read more than one.
   */
  readonly invalidateAfterFirstRead?: boolean;
}

export interface AndroidScanOptions {
  /**
   * Skips the platform's NDEF probe on discovery.
   *
   * Materially faster for ISO-DEP work, noticeably so on Samsung devices. Leave it
   * off if you want `tag.is('ndef')` to be accurate.
   */
  readonly skipNdefCheck?: boolean;
  /** Suppresses the system discovery sound. */
  readonly noPlatformSounds?: boolean;
  /**
   * How long the platform waits before deciding the tag has gone, in
   * milliseconds. The platform default is 125 ms.
   *
   * Raise it for long crypto sequences: DESFire authentication and GlobalPlatform
   * key derivation both routinely exceed 125 ms, and the OS then declares the tag
   * lost part-way through an exchange that was going fine.
   */
  readonly presenceCheckDelayMs?: number;
}

export interface ScanOptions extends Deadline {
  /** Technologies to poll for. At least one is required. */
  readonly tech: readonly TagTech[];
  readonly config?: SessionConfig;
  readonly ios?: IosScanOptions;
  readonly android?: AndroidScanOptions;
}

function toNativeOptions(options: ScanOptions): NativeSessionOptions {
  const { config, ios, android } = options;

  return {
    techs: options.tech,
    iosPollingOptions: config?.polling ?? null,
    iosAlertMessage: ios?.alertMessage ?? null,
    iosInvalidateAfterFirstRead: ios?.invalidateAfterFirstRead ?? false,
    iosSelectIdentifiers: config?.iso7816SelectIdentifiers ?? null,
    iosFelicaSystemCodes: config?.feliCaSystemCodes ?? null,
    androidSkipNdefCheck: android?.skipNdefCheck ?? false,
    androidNoPlatformSounds: android?.noPlatformSounds ?? false,
    androidPresenceCheckDelayMs: android?.presenceCheckDelayMs ?? null,
  };
}

function validateOptions(options: ScanOptions): void {
  if (options.tech.length === 0) {
    throw new NfcError({
      code: 'invalidArgument',
      message: 'At least one technology must be requested; received an empty list.',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Session ids                                                                */
/* -------------------------------------------------------------------------- */

let sessionCounter = 0;

/**
 * Mints a session id in JavaScript rather than having native return one.
 *
 * The id exists before the start call, so the events that follow can be
 * correlated without waiting for a round trip -- native can emit a discovery
 * before `startSession` has resolved, and with a native-assigned id that event
 * would arrive with nothing to match it against.
 */
function nextSessionId(): string {
  sessionCounter += 1;
  return `s${sessionCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* The session                                                                */
/* -------------------------------------------------------------------------- */

export type NextTagOptions = Deadline;

export interface NfcSession {
  readonly id: string;
  readonly closed: boolean;

  /**
   * Waits for the next tag.
   *
   * Rejects if the session ends first -- `userCancelled` when the user dismisses
   * the iOS sheet, `sessionTimeout` at the platform's own limit.
   */
  nextTag(options?: NextTagOptions): Promise<Tag>;

  /** iOS: updates the text in the system sheet. A no-op elsewhere. */
  setAlert(message: string): Promise<void>;

  /** Closes the session. Safe to call more than once. */
  close(): Promise<void>;

  /** Fires when the platform ends the session on its own. */
  onInvalidated(listener: (error: NfcError | null) => void): Subscription;
}

/**
 * Enforces one session at a time.
 *
 * iOS allows exactly one `NFCReaderSession` system-wide -- a second `begin()`
 * fails with `SystemIsBusy` and further sessions queue behind it -- and on Android
 * reader mode belongs to the foreground Activity, so the situation is the same in
 * practice. Rejecting in JavaScript means the caller gets an error that says what
 * happened, instead of a platform code and a sheet that never appears.
 */
let activeSession: SessionImpl | null = null;

/** Test seam: which session, if any, currently owns the radio. */
export function getActiveSessionIdForTests(): string | null {
  return activeSession?.id ?? null;
}

/**
 * Test seam: forgets the active session without closing it.
 *
 * Module-level state outlives a test file, so a test that deliberately leaves a
 * session open would make every later test fail with `systemBusy`.
 */
export function resetActiveSessionForTests(): void {
  activeSession = null;
}

class SessionImpl implements NfcSession {
  readonly id = nextSessionId();

  private closing: Promise<void> | undefined;
  private isClosed = false;
  private invalidationError: NfcError | null = null;

  /** Waiters for `nextTag`, in call order. */
  private readonly waiters: Deferred<Tag>[] = [];
  /** Tags already discovered but not yet handed to a waiter. */
  private readonly queued: Tag[] = [];

  private readonly invalidated = new Listeners<[NfcError | null]>();
  private readonly lostByHandle = new Map<string, Listeners<[]>>();
  private readonly releasedHandles = new Set<string>();
  private readonly subscriptions: NativeSubscription[] = [];

  constructor(
    private readonly native: NativeNfcKitModule,
    private readonly platform: NfcPlatform,
  ) {}

  get closed(): boolean {
    return this.isClosed;
  }

  /** Subscribes to native events, then asks native to start. */
  async start(options: ScanOptions): Promise<void> {
    // Listeners go on before the start call: native may deliver a discovery
    // before startSession resolves, and that event must not be dropped.
    this.subscriptions.push(
      this.native.addListener('onTagDiscovered', (event) => {
        if (event.sessionId === this.id) {
          this.handleTagDiscovered(event.tag);
        }
      }),
      this.native.addListener('onTagLost', (event) => {
        if (event.sessionId === this.id) {
          this.handleTagLost(event.handleId);
        }
      }),
      this.native.addListener('onSessionInvalidated', (event) => {
        if (event.sessionId === this.id) {
          this.handleInvalidated(
            event.error === null ? null : fromNativeErrorPayload(event.error, this.platform),
          );
        }
      }),
    );

    try {
      await callNative(this.platform, 'startSession', () =>
        this.native.startSession(this.id, toNativeOptions(options)),
      );
    } catch (error) {
      // Never leave listeners attached for a session that never began.
      this.teardown();
      throw error;
    }
  }

  nextTag(options: NextTagOptions = {}): Promise<Tag> {
    const queuedTag = this.queued.shift();
    if (queuedTag !== undefined) {
      return Promise.resolve(queuedTag);
    }

    if (this.isClosed) {
      return Promise.reject(this.closedError());
    }

    const waiter = new Deferred<Tag>();
    this.waiters.push(waiter);

    return runWithDeadline(() => waiter.promise, options, 'nextTag').finally(() => {
      const index = this.waiters.indexOf(waiter);
      if (index !== -1) {
        this.waiters.splice(index, 1);
      }
    });
  }

  setAlert(message: string): Promise<void> {
    if (this.isClosed) {
      return Promise.reject(this.closedError());
    }
    return callNative(this.platform, 'setSessionAlert', () =>
      this.native.setSessionAlert(this.id, message),
    );
  }

  /**
   * Closes the session.
   *
   * Idempotent, and concurrent calls share one close: `withTag` closing in its
   * `finally` while the caller also called `close()` must not send two
   * `closeSession` calls to native.
   */
  close(): Promise<void> {
    this.closing ??= this.performClose();
    return this.closing;
  }

  onInvalidated(listener: (error: NfcError | null) => void): Subscription {
    return this.invalidated.add(listener);
  }

  private async performClose(): Promise<void> {
    const alreadyClosed = this.isClosed;
    this.markClosed(null);

    try {
      if (!alreadyClosed) {
        await callNative(this.platform, 'closeSession', () => this.native.closeSession(this.id));
      }
    } finally {
      this.teardown();
    }
  }

  private closedError(): NfcError {
    return (
      this.invalidationError ??
      new NfcError({
        code: 'sessionClosed',
        message: 'The NFC session is closed.',
        platform: this.platform,
      })
    );
  }

  private markClosed(error: NfcError | null): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.invalidationError = error;

    if (activeSession === this) {
      activeSession = null;
    }

    // Anything still waiting for a tag will never get one.
    const rejection = error ?? this.closedError();
    for (const waiter of [...this.waiters]) {
      waiter.reject(rejection);
    }
    this.waiters.length = 0;
    this.queued.length = 0;
  }

  private teardown(): void {
    for (const subscription of this.subscriptions) {
      subscription.remove();
    }
    this.subscriptions.length = 0;

    for (const listeners of this.lostByHandle.values()) {
      listeners.clear();
    }
    this.lostByHandle.clear();
    this.invalidated.clear();
  }

  private handleTagDiscovered(info: NativeTagInfo): void {
    if (this.isClosed) {
      return;
    }

    const tag = createTag(this.tagRuntime(info));

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(tag);
    } else {
      // Discovered before anyone asked. Keeping it means a caller that starts a
      // session and then awaits does not miss a tag presented in between.
      this.queued.push(tag);
    }
  }

  private handleTagLost(handleId: string): void {
    this.releasedHandles.add(handleId);
    this.lostByHandle.get(handleId)?.emit();
  }

  private handleInvalidated(error: NfcError | null): void {
    this.markClosed(error);
    this.invalidated.emit(error);
    this.teardown();
  }

  private tagRuntime(info: NativeTagInfo): TagRuntime {
    return {
      native: this.native,
      platform: this.platform,
      info,
      assertUsable: () => {
        if (this.isClosed) {
          throw this.closedError();
        }
        if (this.releasedHandles.has(info.handleId)) {
          throw new NfcError({
            code: 'tagLost',
            message: 'The tag has left the field.',
            platform: this.platform,
          });
        }
      },
      isReleased: () => this.isClosed || this.releasedHandles.has(info.handleId),
      addLostListener: (listener) => {
        let listeners = this.lostByHandle.get(info.handleId);
        if (listeners === undefined) {
          listeners = new Listeners<[]>();
          this.lostByHandle.set(info.handleId, listeners);
        }
        return listeners.add(listener);
      },
    };
  }
}

/**
 * The symbol `await using` looks for.
 *
 * `Symbol.asyncDispose` is not everywhere yet: it is missing on Node 20 and 22,
 * and on Hermes, which is the engine most React Native apps actually run. So
 * defining the disposer only when the native symbol exists would mean
 * `await using` silently doing nothing for most users -- a session left open,
 * which is the exact failure this API exists to prevent.
 *
 * `Symbol.for('Symbol.asyncDispose')` is the documented fallback: it is what
 * TypeScript's downlevelled `await using` helper looks up when the native symbol
 * is absent, so registering under it makes the syntax work on those engines too.
 */
const ASYNC_DISPOSE: symbol =
  (Symbol as { asyncDispose?: symbol }).asyncDispose ?? Symbol.for('Symbol.asyncDispose');

/** Adds the disposer so `await using` closes the session. */
function makeDisposable(session: NfcSession): NfcSession {
  Object.defineProperty(session, ASYNC_DISPOSE, {
    value: () => session.close(),
    enumerable: false,
    configurable: true,
  });
  return session;
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

export interface SessionDependencies {
  readonly native: NativeNfcKitModule;
  readonly platform: NfcPlatform;
}

/**
 * Opens a session and hands it to the caller to manage.
 *
 * Prefer `withTag` unless you genuinely need to read several tags with your own
 * UI in between. Use `await using`, or close it in a `finally`.
 */
export async function openSession(
  deps: SessionDependencies,
  options: ScanOptions,
): Promise<NfcSession> {
  validateOptions(options);

  // Checked before anything else touches the radio. A session that opens and
  // immediately closes still raises the iOS sheet for a frame and still takes
  // Android's controller, so "already aborted" has to mean "nothing happened".
  if (options.signal?.aborted === true) {
    throw abortedError('Opening the session');
  }

  if (activeSession !== null && !activeSession.closed) {
    throw new NfcError({
      code: 'systemBusy',
      message:
        'An NFC session is already open. Close it before starting another: the platform ' +
        'allows only one at a time, and on iOS a second session queues behind the first.',
      platform: deps.platform,
    });
  }

  const session = new SessionImpl(deps.native, deps.platform);
  activeSession = session;

  try {
    await session.start(options);
  } catch (error) {
    activeSession = null;
    throw error;
  }

  return makeDisposable(session);
}

/**
 * Opens a session, waits for one tag, runs `work`, and always closes.
 *
 * The session is closed before this resolves or rejects, on every path: `work`
 * returning, `work` throwing, the deadline elapsing, the signal firing, or the
 * platform ending the session underneath. A tag handed to `work` must not be used
 * after it returns; operations on it reject with `sessionClosed`.
 */
export async function withTag<T>(
  deps: SessionDependencies,
  options: ScanOptions,
  work: (tag: Tag) => Promise<T> | T,
): Promise<T> {
  const session = await openSession(deps, options);

  try {
    const tag = await session.nextTag({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return await work(tag);
  } finally {
    // Deliberately not awaited-and-swallowed separately: a close failure must not
    // mask the original error, but it must also not be silently dropped.
    await session.close().catch((error: unknown) => {
      console.error('[react-native-nfc-kit] Closing the NFC session failed:', error);
    });
  }
}
