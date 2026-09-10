/**
 * The native boundary, on the web.
 *
 * Metro resolves this file instead of `module.ts` for a web bundle, which is the
 * whole trick: the contract in `contract.ts` is already session-based and
 * addresses everything by opaque id, so implementing it over Web NFC gives the
 * entire public API — `withTag`, tags, errors, the React hooks — without any of
 * them knowing a browser is underneath.
 *
 * What a browser can actually do is much less than a phone, and none of it is
 * papered over:
 *
 * - **NDEF only.** Web NFC exposes no transceive, no technology-specific
 *   commands, no card emulation. Everything else rejects `unsupportedPlatform`
 *   with a message saying so.
 * - **Chrome on Android only**, at the time of writing. No Safari, no desktop.
 * - **Writing is not aimed at a tag.** `NDEFReader.write` writes to whichever tag
 *   is next in the field, not to the one a handle refers to. In practice that is
 *   the same tag, and the difference is documented rather than hidden.
 * - **A tag's writability and capacity are not reported at all**, so
 *   `getNdefStatus` rejects rather than inventing numbers a caller would then
 *   check against.
 */

import { NfcError, type NfcPlatform } from '../errors.js';
import { encodeMessage } from '../ndef/message.js';
import { fromWebRecords, toWebRecords, type WebNdefRecord } from '../web/records.js';
import {
  CONTRACT_VERSION,
  type NativeCapabilities,
  type NativeEventMap,
  type NativeEventName,
  type NativeHceOptions,
  type NativeHceStarted,
  type NativeNdefStatus,
  type NativeNfcAntennaInfo,
  type NativeNfcKitModule,
  type NativeSessionOptions,
  type NativeSubscription,
  type NativeTagInfo,
  type NativeVasOptions,
  type NativeVasResponse,
} from './contract.js';

export const platform: NfcPlatform = 'web';

/** Whether this platform can host the native module at all. */
export const isNativePlatform = false;

/* -------------------------------------------------------------------------- */
/* Web NFC's own shapes                                                       */
/* -------------------------------------------------------------------------- */

interface WebNdefMessage {
  readonly records: readonly WebNdefRecord[];
}

interface WebNdefReadingEvent {
  readonly serialNumber?: string;
  readonly message: WebNdefMessage;
}

interface WebNdefReader {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  write(
    message: { records: unknown[] } | string | BufferSource,
    options?: { signal?: AbortSignal; overwrite?: boolean },
  ): Promise<void>;
  makeReadOnly?: (options?: { signal?: AbortSignal }) => Promise<void>;
  onreading: ((event: WebNdefReadingEvent) => void) | null;
  onreadingerror: ((event: Event) => void) | null;
}

type WebNdefReaderConstructor = new () => WebNdefReader;

function readerConstructor(): WebNdefReaderConstructor | null {
  const candidate = (globalThis as { NDEFReader?: WebNdefReaderConstructor }).NDEFReader;
  return typeof candidate === 'function' ? candidate : null;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

function unsupported(what: string, because: string): NfcError {
  return new NfcError({
    code: 'unsupportedPlatform',
    message: `${what} is not available through Web NFC: ${because}`,
    platform,
  });
}

/**
 * Maps a DOM exception onto this library's codes.
 *
 * Web NFC reports failures as `DOMException` names rather than as anything
 * NFC-specific, so this is the only place the difference between "the user said
 * no" and "the tag went away" can be recovered.
 */
function fromDomError(error: unknown, what: string): NfcError {
  if (NfcError.is(error)) {
    return error;
  }

  const name = (error as { name?: string })?.name ?? '';
  const message = (error as { message?: string })?.message ?? String(error);

  const code = (() => {
    switch (name) {
      case 'NotAllowedError':
        // Either the permission prompt was declined, or there was no user
        // gesture behind the call, which Web NFC requires.
        return 'notAuthorized' as const;
      case 'NotSupportedError':
        return 'nfcUnsupported' as const;
      case 'AbortError':
        return 'aborted' as const;
      case 'NotReadableError':
        return 'nfcDisabled' as const;
      case 'NetworkError':
        return 'tagLost' as const;
      case 'InvalidStateError':
        return 'systemBusy' as const;
      default:
        return 'internalError' as const;
    }
  })();

  return new NfcError({ code, message: `${what} failed: ${message}`, platform, cause: error });
}

/* -------------------------------------------------------------------------- */
/* The module                                                                 */
/* -------------------------------------------------------------------------- */

const CAPABILITIES: NativeCapabilities = {
  platform: 'web',
  osVersion: 'web',
  // NDEF and nothing else. A browser cannot reach a technology directly, so
  // every other guard is honestly false rather than a method that throws.
  techs: ['ndef'],
  tagLost: 'none',
  perSessionConfig: false,
  hce: false,
  observeMode: false,
  pollingFrames: false,
  backgroundReading: false,
  vas: false,
  // A page is given interpreted records and nothing about the hardware
  // underneath -- not where the antenna is, and not what the NFC settings say.
  antennaInfo: false,
  secureNfc: false,
};

class WebNfcModule implements NativeNfcKitModule {
  readonly contractVersion = CONTRACT_VERSION;
  readonly capabilities = CAPABILITIES;

  private readonly listeners = new Map<NativeEventName, Set<(event: never) => void>>();

  /** The reader for the open session, and how to stop it. */
  private session: { id: string; reader: WebNdefReader; abort: AbortController } | null = null;

  /**
   * What the browser reported, per handle.
   *
   * The reader is kept alongside the records rather than looked up from the open
   * session: a write then goes through the reader that discovered the tag, and
   * there is no second piece of state to keep consistent with the first.
   */
  private readonly tags = new Map<
    string,
    { records: readonly WebNdefRecord[]; reader: WebNdefReader }
  >();
  private handleCounter = 0;

  /* -- Events ------------------------------------------------------------- */

  addListener<E extends NativeEventName>(
    event: E,
    listener: NativeEventMap[E],
  ): NativeSubscription {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (event: never) => void);

    return {
      remove: () => {
        this.listeners.get(event)?.delete(listener as (event: never) => void);
      },
    };
  }

  private emit<E extends NativeEventName>(
    event: E,
    payload: Parameters<NativeEventMap[E]>[0],
  ): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      (listener as (value: typeof payload) => void)(payload);
    }
  }

  /* -- Availability -------------------------------------------------------- */

  async isSupported(): Promise<boolean> {
    return readerConstructor() !== null;
  }

  async isEnabled(): Promise<boolean> {
    // A browser has no separate "NFC is switched off" state to report: either the
    // API is there or it is not.
    return readerConstructor() !== null;
  }

  async openSettings(): Promise<void> {
    throw unsupported('Opening the NFC settings', 'a page cannot open system settings.');
  }

  async getAntennaInfo(): Promise<NativeNfcAntennaInfo | null> {
    // Null rather than a rejection: Web NFC describes no hardware at all, and a
    // caller drawing a "hold the card here" hint already has to cope with a
    // device that does not say.
    return null;
  }

  async isSecureNfcEnabled(): Promise<boolean> {
    // A browser has no such setting to report.
    return false;
  }

  /* -- Sessions ------------------------------------------------------------ */

  async startSession(sessionId: string, options: NativeSessionOptions): Promise<void> {
    const Reader = readerConstructor();
    if (Reader === null) {
      throw new NfcError({
        code: 'nfcUnsupported',
        message:
          'This browser has no Web NFC. It is available in Chrome on Android and nowhere else at ' +
          'the time of writing, and only on a page served over HTTPS.',
        platform,
      });
    }
    if (this.session !== null) {
      throw new NfcError({
        code: 'systemBusy',
        message: 'A scan is already running. Close it before starting another.',
        platform,
      });
    }
    // Asking for a technology a browser cannot reach is a mistake worth naming
    // at the point of the call rather than at the point of the first operation.
    const unreachable = options.techs.filter((tech) => tech !== 'ndef');
    if (unreachable.length > 0) {
      throw unsupported(
        `The ${unreachable.join(', ')} technology`,
        'a browser can only read and write NDEF. Ask for ["ndef"].',
      );
    }

    const reader = new Reader();
    const abort = new AbortController();

    reader.onreading = (event: WebNdefReadingEvent) => {
      this.handleCounter += 1;
      const handleId = `${sessionId}-t${this.handleCounter}`;
      this.tags.set(handleId, { records: event.message.records, reader });

      this.emit('onTagDiscovered', {
        sessionId,
        tag: {
          handleId,
          // Chrome reports the serial number with colons; the rest of this
          // library speaks plain lowercase hex.
          idHex: event.serialNumber?.replace(/:/g, '').toLowerCase() ?? null,
          techs: ['ndef'],
          android: null,
          ios: null,
        } satisfies NativeTagInfo,
      });
    };

    reader.onreadingerror = () => {
      this.emit('onSessionInvalidated', {
        sessionId,
        error: {
          code: 'ndefMalformed',
          message:
            'The browser could not read the tag. It may be unformatted or of a type Web NFC does not handle.',
          nativeCode: null,
          recoverable: true,
        },
      });
    };

    try {
      await reader.scan({ signal: abort.signal });
    } catch (error) {
      throw fromDomError(error, 'Starting the scan');
    }

    this.session = { id: sessionId, reader, abort };
  }

  async closeSession(sessionId: string): Promise<void> {
    if (this.session?.id !== sessionId) {
      // Closing an already-closed session is not an error: JavaScript closes in a
      // finally block, which can run after the scan has already ended.
      return;
    }
    this.session.abort.abort();
    this.session = null;
    this.tags.clear();
  }

  async setSessionAlert(): Promise<void> {
    // A browser shows no sheet of its own, and the page owns its UI. A no-op
    // rather than an error, so cross-platform code does not have to branch.
  }

  async releaseTag(handleId: string): Promise<void> {
    this.tags.delete(handleId);
  }

  /* -- NDEF ---------------------------------------------------------------- */

  private tagFor(handleId: string): { records: readonly WebNdefRecord[]; reader: WebNdefReader } {
    const tag = this.tags.get(handleId);
    if (tag === undefined) {
      throw new NfcError({
        code: 'sessionClosed',
        message: 'This tag is no longer available: its scan has ended.',
        platform,
      });
    }
    return tag;
  }

  async readNdef(handleId: string): Promise<Uint8Array> {
    // The browser already read the tag and handed over interpreted records, so
    // this re-encodes them rather than going back to the radio -- which Web NFC
    // gives no way to do anyway.
    return encodeMessage(fromWebRecords(this.tagFor(handleId).records));
  }

  async writeNdef(handleId: string, message: Uint8Array): Promise<void> {
    const { reader } = this.tagFor(handleId);

    try {
      // Aimed at whichever tag is next in the field rather than at this handle:
      // Web NFC has no way to address a specific tag. In practice it is the tag
      // still being held against the phone.
      await reader.write({ records: toWebRecords(message) }, { overwrite: true });
    } catch (error) {
      throw fromDomError(error, 'Writing the tag');
    }
  }

  async getNdefStatus(): Promise<NativeNdefStatus> {
    throw unsupported(
      'Reading a tag',
      'Web NFC reports neither whether a tag is writable nor how much room it has, and inventing ' +
        'those numbers would only move the failure to the write.',
    );
  }

  async makeNdefReadOnly(handleId: string): Promise<void> {
    const { reader } = this.tagFor(handleId);
    if (reader.makeReadOnly === undefined) {
      throw unsupported('Locking a tag', 'this browser does not implement makeReadOnly.');
    }

    try {
      await reader.makeReadOnly();
    } catch (error) {
      throw fromDomError(error, 'Locking the tag');
    }
  }

  async formatNdef(): Promise<void> {
    throw unsupported('Formatting a tag', 'a browser cannot reach a tag below the NDEF layer.');
  }

  /* -- Everything a browser cannot reach ----------------------------------- */

  async transceive(): Promise<Uint8Array> {
    throw unsupported(
      'Exchanging raw commands with a tag',
      'a browser is given interpreted NDEF records and never the radio itself.',
    );
  }

  async getMaxTransceiveLength(): Promise<number> {
    throw unsupported('The maximum exchange length', 'there is no exchange to size.');
  }

  async setTechTimeout(): Promise<void> {
    throw unsupported('A per-technology timeout', 'a browser exposes no technologies.');
  }

  async getTechTimeout(): Promise<number> {
    throw unsupported('A per-technology timeout', 'a browser exposes no technologies.');
  }

  async takeLaunchTag(): Promise<NativeTagInfo | null> {
    // A page is not launched by a tag. Null rather than an error, so a startup
    // path can call it unconditionally on every platform.
    return null;
  }

  async isHceSupported(): Promise<boolean> {
    return false;
  }

  async isObserveModeSupported(): Promise<boolean> {
    return false;
  }

  async isObserveModeEnabled(): Promise<boolean> {
    return false;
  }

  async setObserveModeEnabled(): Promise<boolean> {
    return false;
  }

  async startHce(_options: NativeHceOptions): Promise<NativeHceStarted> {
    throw unsupported('Card emulation', 'no browser exposes it.');
  }

  async stopHce(): Promise<void> {
    // Nothing was ever started, and a cleanup path should not have to branch.
  }

  async respondToHce(): Promise<boolean> {
    return false;
  }

  async isVasSupported(): Promise<boolean> {
    return false;
  }

  async readVas(_options: NativeVasOptions): Promise<readonly NativeVasResponse[]> {
    throw unsupported('Reading an Apple Wallet pass', 'it is a CoreNFC feature.');
  }
}

/* -------------------------------------------------------------------------- */
/* The same surface `module.ts` exposes                                       */
/* -------------------------------------------------------------------------- */

let injected: NativeNfcKitModule | null | undefined;
let resolved: WebNfcModule | null = null;

function resolveModule(): NativeNfcKitModule | null {
  if (injected !== undefined) {
    return injected;
  }
  resolved ??= new WebNfcModule();
  return resolved;
}

export function getNativeModule(): NativeNfcKitModule {
  const module = resolveModule();
  if (module === null) {
    throw new NfcError({
      code: 'unsupportedPlatform',
      message: 'NFC is not available here.',
      platform,
    });
  }
  return module;
}

export function tryGetNativeModule(): NativeNfcKitModule | null {
  return resolveModule();
}

export function setNativeModuleForTests(module: NativeNfcKitModule | null | undefined): void {
  injected = module;
}

/**
 * Drops the singleton so a test starts from a clean page.
 *
 * One instance per page is correct in production -- a page has one NFC controller
 * and one scan -- which means the instance carries session state across tests
 * unless it is thrown away. The same seam exists in `core/session.ts` and
 * `hce/session.ts` for the same reason.
 */
export function resetWebModuleForTests(): void {
  injected = undefined;
  resolved = null;
}
