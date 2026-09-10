/**
 * The public entry point.
 *
 * Three ways to read a tag, in the order you should reach for them:
 *
 * 1. `nfc.withTag(options, work)` -- scoped. The session closes on every path out,
 *    so it cannot be left holding the radio. Use this unless you have a reason not
 *    to.
 * 2. `nfc.openSession(options)` -- for reading several tags with your own UI in
 *    between. Implements `AsyncDisposable`, so `await using` still cleans up.
 * 3. `nfc.onTag(options, listener)` -- continuous reading, for a kiosk or a door.
 *    The session lives as long as somebody is listening.
 */

import { NfcError, type NfcPlatform } from '../errors.js';
import {
  isTagTech,
  type NativeCapabilities,
  type TagLostReporting,
  type TagTech,
} from '../native/contract.js';
import { callNative } from '../native/errors.js';
import { getNativeModule, platform, tryGetNativeModule } from '../native/module.js';
import {
  onBackgroundTag as onBackgroundTagWith,
  withLaunchTag as withLaunchTagWith,
  type BackgroundTagOptions,
} from './background.js';
import { Listeners, type Subscription } from './subscription.js';
import {
  openSession as openSessionWith,
  withTag as withTagWith,
  type NfcSession,
  type ScanOptions,
  type SessionDependencies,
} from './session.js';
import type { Tag } from './tag.js';

/* -------------------------------------------------------------------------- */
/* Capabilities and availability                                              */
/* -------------------------------------------------------------------------- */

/**
 * What this device and OS version can actually do.
 *
 * Reported by native rather than inferred from the platform, because most of these
 * are neither: MIFARE Classic depends on the NFC controller, tag-removal delivery
 * on the Android API level, per-session polling configuration on iOS 26.4.
 */
export interface NfcCapabilities {
  readonly platform: NfcPlatform;
  readonly osVersion: string;
  /** Technologies reachable here. Chipset-dependent on Android. */
  readonly techs: readonly TagTech[];
  /**
   * How tag removal reaches `tag.onLost`.
   *
   * `none` on iOS, where CoreNFC has no removal callback at all. `polled` or
   * `native` on Android, which differ only in latency: a poll interval against
   * effectively none.
   */
  readonly tagLost: TagLostReporting;
  /** iOS 26.4 and later can narrow AIDs and FeliCa system codes per session. */
  readonly perSessionConfig: boolean;
  readonly hce: boolean;
  /**
   * Whether an emulated card can be held silent while a reader polls.
   *
   * Android 15 and later, plus controller support. `false` on iOS.
   */
  readonly observeMode: boolean;
  /** Whether a reader's polling loop frames reach the app. Android 15 and later. */
  readonly pollingFrames: boolean;
  readonly backgroundReading: boolean;
}

export interface NfcAvailability {
  /** Whether the device has usable NFC hardware. */
  readonly supported: boolean;
  /** Whether NFC is switched on. Always true on iOS, which has no such setting. */
  readonly enabled: boolean;
  readonly capabilities: NfcCapabilities | null;
}

const UNAVAILABLE: NfcAvailability = { supported: false, enabled: false, capabilities: null };

function toCapabilities(native: NativeCapabilities): NfcCapabilities {
  return {
    platform: native.platform,
    osVersion: native.osVersion,
    // A native binary newer than this bundle may report a technology with no
    // capability type here; dropping it beats surfacing a name no guard matches.
    techs: native.techs.filter(isTagTech),
    tagLost: native.tagLost,
    perSessionConfig: native.perSessionConfig,
    hce: native.hce,
    observeMode: native.observeMode,
    pollingFrames: native.pollingFrames,
    backgroundReading: native.backgroundReading,
  };
}

/* -------------------------------------------------------------------------- */
/* Continuous reading                                                         */
/* -------------------------------------------------------------------------- */

export interface TagStreamOptions extends ScanOptions {
  /**
   * Called when the stream fails.
   *
   * Without this, a failure would be silent: `onTag` returns a subscription, not a
   * promise, so there is nothing for a rejection to reach.
   */
  readonly onError?: (error: NfcError) => void;
}

/* -------------------------------------------------------------------------- */
/* The facade                                                                 */
/* -------------------------------------------------------------------------- */

function deps(): SessionDependencies {
  return { native: getNativeModule(), platform };
}

/** Current capabilities, or `null` when NFC is unavailable here. */
function currentCapabilities(): NfcCapabilities | null {
  const native = tryGetNativeModule();
  return native === null ? null : toCapabilities(native.capabilities);
}

/** Listeners for availability changes, attached to native only while in use. */
let availabilitySubscription: { remove(): void } | null = null;

const availabilityListeners = new Listeners<[NfcAvailability]>({
  onFirstListener: () => {
    const native = tryGetNativeModule();
    if (native === null) {
      return;
    }
    availabilitySubscription = native.addListener('onAvailabilityChanged', (event) => {
      availabilityListeners.emit({
        supported: event.supported,
        enabled: event.enabled,
        capabilities: toCapabilities(native.capabilities),
      });
    });
  },
  onLastListenerRemoved: () => {
    availabilitySubscription?.remove();
    availabilitySubscription = null;
  },
});

export const nfc = {
  /* ── Availability ──────────────────────────────────────────────────────── */

  /**
   * Whether NFC hardware is present and usable.
   *
   * Answers `false` rather than throwing when the native module is missing, so a
   * screen can hide its NFC affordance without a try/catch. Every other call
   * throws `contractMismatch` in that situation, with instructions.
   */
  async isSupported(): Promise<boolean> {
    const native = tryGetNativeModule();
    if (native === null) {
      return false;
    }
    return callNative(platform, 'isSupported', () => native.isSupported());
  },

  /** Whether NFC is switched on. Always true on iOS, which has no such setting. */
  async isEnabled(): Promise<boolean> {
    const native = tryGetNativeModule();
    if (native === null) {
      return false;
    }
    return callNative(platform, 'isEnabled', () => native.isEnabled());
  },

  /** Support, enablement and per-device capabilities in one call. */
  async getAvailability(): Promise<NfcAvailability> {
    const native = tryGetNativeModule();
    if (native === null) {
      return UNAVAILABLE;
    }

    const [supported, enabled] = await Promise.all([
      callNative(platform, 'isSupported', () => native.isSupported()),
      callNative(platform, 'isEnabled', () => native.isEnabled()),
    ]);

    return { supported, enabled, capabilities: toCapabilities(native.capabilities) };
  },

  /**
   * What this device and OS version can do, or `null` when NFC is unavailable.
   *
   * Synchronous: native reports it as a constant, so there is no round trip.
   */
  get capabilities(): NfcCapabilities | null {
    return currentCapabilities();
  },

  /**
   * Whether a technology is reachable on this device.
   *
   * Reads module state rather than `this`, so `const { supports } = nfc` keeps
   * working -- destructuring a facade is a normal thing to do.
   */
  supports(tech: TagTech): boolean {
    return currentCapabilities()?.techs.includes(tech) ?? false;
  },

  /**
   * Opens the system NFC settings, so the user can switch NFC on.
   *
   * Android only. Rejects `unsupportedPlatform` on iOS, which has no such screen
   * and no way to link to one.
   */
  async openSettings(): Promise<void> {
    const native = getNativeModule();
    return callNative(platform, 'openSettings', () => native.openSettings());
  },

  /** Fires when NFC is switched on or off. Android only in practice. */
  onAvailabilityChange(listener: (availability: NfcAvailability) => void): Subscription {
    return availabilityListeners.add(listener);
  },

  /* ── Reading ───────────────────────────────────────────────────────────── */

  /**
   * Opens a session, waits for one tag, runs `work`, and always closes.
   *
   * ```ts
   * const message = await nfc.withTag({ tech: ['ndef'], timeoutMs: 20_000 }, async (tag) => {
   *   if (!tag.is('ndef')) throw new Error('Not an NDEF tag');
   *   return tag.readNdef();
   * });
   * ```
   *
   * The tag is only valid inside `work`. Using it afterwards rejects with
   * `sessionClosed`.
   */
  withTag<T>(options: ScanOptions, work: (tag: Tag) => Promise<T> | T): Promise<T> {
    return withTagWith(deps(), options, work);
  },

  /**
   * Opens a session you manage yourself.
   *
   * Prefer `withTag`. Reach for this only to read several tags with your own UI in
   * between, and then use `await using` or a `finally`:
   *
   * ```ts
   * await using session = await nfc.openSession({ tech: ['ndef'] });
   * const first = await session.nextTag();
   * await session.setAlert('Now the second card');
   * const second = await session.nextTag();
   * ```
   */
  openSession(options: ScanOptions): Promise<NfcSession> {
    return openSessionWith(deps(), options);
  },

  /**
   * Reads tags continuously for as long as the subscription is alive.
   *
   * For a kiosk or a door reader:
   *
   * ```ts
   * const subscription = nfc.onTag(
   *   { tech: ['isoDep'], android: { presenceCheckDelayMs: 500 } },
   *   async (tag) => { if (tag.is('isoDep')) await validate(tag); },
   * );
   * // later
   * subscription.remove();
   * ```
   *
   * This is really an Android feature. Android reader mode stays active
   * indefinitely, so the loop runs until you unsubscribe. iOS caps a reader session
   * at 60 seconds and shows a system sheet throughout, so the stream ends with
   * `sessionTimeout` and `onError` is called -- restarting it is the caller's
   * decision, because on iOS it means putting the sheet back up.
   *
   * The listener is awaited before the next tag is taken, so slow work cannot
   * cause overlapping reads on the same hardware.
   */
  onTag(options: TagStreamOptions, listener: (tag: Tag) => void | Promise<void>): Subscription {
    let stopped = false;
    let session: NfcSession | null = null;

    const report = (error: unknown): void => {
      if (stopped) {
        return;
      }
      const nfcError = NfcError.is(error)
        ? error
        : new NfcError({
            code: 'internalError',
            message: 'The tag stream failed.',
            platform,
            cause: error,
          });

      if (options.onError !== undefined) {
        options.onError(nfcError);
      } else {
        console.error(
          '[react-native-nfc-kit] Tag stream failed with no onError handler:',
          nfcError,
        );
      }
    };

    void (async () => {
      try {
        session = await openSessionWith(deps(), options);

        while (!stopped && !session.closed) {
          const tag = await session.nextTag(
            options.signal === undefined ? {} : { signal: options.signal },
          );
          if (stopped) {
            return;
          }
          // Awaited on purpose: overlapping work on one tag reader is never what
          // the caller meant, and on Android it would interleave exchanges.
          await listener(tag);
        }
      } catch (error) {
        // A session closed by unsubscribing is the expected way out, not a failure.
        if (!stopped) {
          report(error);
        }
      } finally {
        await session?.close().catch(() => {
          // Already reported, or the session was never opened.
        });
      }
    })();

    return {
      remove: () => {
        if (stopped) {
          return;
        }
        stopped = true;
        void session?.close().catch(() => {
          // Nothing useful to do: the caller has already stopped listening.
        });
      },
    };
  },

  /* ── Background tags ───────────────────────────────────────────────────── */

  /**
   * Runs `work` with the tag that launched the app, if one did.
   *
   * ```ts
   * const ticket = await nfc.withLaunchTag(async (tag) =>
   *   tag.is('ndef') ? decodeMessage(await tag.readNdef()) : null,
   * );
   * ```
   *
   * Resolves to `null` on a normal launch, so it is safe to call unconditionally
   * on startup. The tag is consumed: a second call answers `null`, which is also
   * what stops a screen rotation from replaying a tap from minutes ago.
   *
   * Android only in practice, and it needs intent filters in the manifest --
   * see `docs/setup/background-reading.md`. On iOS the system reads background
   * NDEF tags itself without involving the app, so this is always `null` there.
   */
  withLaunchTag<T>(work: (tag: Tag) => Promise<T> | T): Promise<T | null> {
    return withLaunchTagWith(deps(), work);
  },

  /**
   * Delivers tags the system dispatches while the app is running.
   *
   * For a tag tapped while the app is in the background or on another screen.
   * Reader mode -- `withTag`, `openSession`, `onTag` -- does not come through
   * here, and needs none of the manifest configuration this does.
   */
  onBackgroundTag(
    listener: (tag: Tag) => void | Promise<void>,
    options?: BackgroundTagOptions,
  ): Subscription {
    return onBackgroundTagWith(deps(), listener, options);
  },
};
