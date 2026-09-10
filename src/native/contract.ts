/**
 * The TypeScript side of the native contract.
 *
 * This file is the single description of what the native modules expose. Nothing
 * above `src/native` talks to the native module directly, and nothing in the
 * native module is called from anywhere else, so this is the one place where a
 * rename has to be kept in sync.
 *
 * Expo Modules have no code generation, which is the real cost of choosing them:
 * these declarations can drift from the Swift and Kotlin they describe. Three
 * things guard against that -- `CONTRACT_VERSION` below, a runtime contract test
 * that walks the actual native module and compares it against this shape, and
 * `expo-type-information` in CI.
 *
 * Two conventions worth stating explicitly, because both exist for a reason:
 *
 * 1. **Events never carry raw bytes.** Small identifiers travel as lowercase hex
 *    strings; bulk binary is fetched with a function call. Android has a
 *    long-standing bug where a `ByteArray` in an event payload arrives as an
 *    opaque string id instead of a `Uint8Array` (expo/expo#29566), and returning
 *    bytes from a function has always worked. Even with the bug fixed, keeping
 *    the rule means a discovery event does not serialise a payload the caller may
 *    never look at.
 *
 * 2. **Every operation is addressed by an opaque id**, never by a native object
 *    handed to JS. Sessions and tags are `string` ids; native owns the lifetime.
 *    Nothing in JS can hold a reference that outlives the tag.
 */

/**
 * Bumped whenever the native surface changes in a way that requires a rebuild.
 *
 * JS compares this against what the installed binary reports. A mismatch is the
 * `contractMismatch` error, whose message says to rebuild the development client
 * -- which is the single most common support question for any native library, and
 * it should not require asking.
 *
 * Bumping this is a minor release, and the changelog marks it.
 */
export const CONTRACT_VERSION = 4;

/** Native module name, as registered by both platforms. */
export const NATIVE_MODULE_NAME = 'NfcKit';

/* -------------------------------------------------------------------------- */
/* Technology names                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Wire names for tag technologies. Deliberately identical on both platforms.
 *
 * The library being replaced silently rewrote `NfcA` to `mifare` and `NfcV` to
 * `iso15693` on iOS only, so the same constant meant different things depending
 * on where it ran. Here a name means one thing, and a technology a platform
 * cannot reach simply never appears in a tag's `techs`.
 */
export const TAG_TECH_NAMES = [
  'ndef',
  'ndefFormatable',
  'isoDep',
  'iso15693',
  'felica',
  'mifareUltralight',
  'mifareClassic',
  'nfcA',
  'nfcB',
  'nfcBarcode',
] as const;

export type TagTech = (typeof TAG_TECH_NAMES)[number];

const TAG_TECH_SET: ReadonlySet<string> = new Set(TAG_TECH_NAMES);

export function isTagTech(value: string): value is TagTech {
  return TAG_TECH_SET.has(value);
}

/* -------------------------------------------------------------------------- */
/* Payloads crossing the boundary                                             */
/* -------------------------------------------------------------------------- */

/** Platform-specific tag metadata from Android. */
export interface NativeAndroidTagInfo {
  /** Raw `Tag.getTechList()` entries, for diagnostics and bug reports. */
  readonly techList: readonly string[];
  readonly maxTransceiveLength: number | null;
  /** `IsoDep.getHiLayerResponse()`, when the tag is ISO-DEP. */
  readonly hiLayerResponseHex: string | null;
  /** `IsoDep.getHistoricalBytes()`, when the tag is ISO-DEP over NFC-A. */
  readonly historicalBytesHex: string | null;
}

/** Platform-specific tag metadata from iOS CoreNFC. */
export interface NativeIosTagInfo {
  /** Which CoreNFC tag case the tag arrived as. */
  readonly coreNfcType: string;
  readonly historicalBytesHex: string | null;
  readonly applicationDataHex: string | null;
  /** The AID CoreNFC selected, for an ISO 7816 tag. */
  readonly initialSelectedAid: string | null;
  /** FeliCa manufacture id. */
  readonly idmHex: string | null;
  /** FeliCa system code. */
  readonly systemCodeHex: string | null;
  readonly icManufacturerCode: number | null;
}

/**
 * A discovered tag, as native reports it.
 *
 * `idHex` rather than bytes: see the events convention at the top of this file.
 */
export interface NativeTagInfo {
  /** Opaque handle for addressing operations on this tag. */
  readonly handleId: string;
  /** UID as lowercase hex, or `null` when the platform does not expose one. */
  readonly idHex: string | null;
  readonly techs: readonly string[];
  readonly android: NativeAndroidTagInfo | null;
  readonly ios: NativeIosTagInfo | null;
}

export interface NativeNdefStatus {
  readonly writable: boolean;
  /** Usable capacity in bytes for the NDEF message. */
  readonly capacity: number;
  readonly canMakeReadOnly: boolean;
  /** NFC Forum type name when the platform reports one, e.g. `NFC Forum Type 2`. */
  readonly typeName: string | null;
}

export const TAG_LOST_REPORTING = ['none', 'polled', 'native'] as const;

export type TagLostReporting = (typeof TAG_LOST_REPORTING)[number];

/** What native reports it can actually do on this device and OS version. */
export interface NativeCapabilities {
  readonly platform: 'ios' | 'android';
  readonly osVersion: string;
  /** Technologies reachable on this device. Chipset-dependent on Android. */
  readonly techs: readonly string[];
  /**
   * How tag removal reaches `tag.onLost`.
   *
   * - `none` -- not reported at all. CoreNFC has no removal callback, so a tag
   *   leaving the field on iOS surfaces as the next operation failing.
   * - `polled` -- reported by polling the tag's presence, so removal is noticed
   *   within roughly the poll interval rather than immediately.
   * - `native` -- the platform reports it directly.
   *
   * A three-state value rather than a boolean because both halves matter and a
   * boolean can only carry one of them: whether removal is reported at all, and
   * whether the latency is a poll interval or nothing.
   */
  readonly tagLost: TagLostReporting;
  /** iOS 26.4+ narrows AIDs and FeliCa system codes per session. */
  readonly perSessionConfig: boolean;
  readonly hce: boolean;
  /**
   * Whether the controller can hold an emulated card silent while a reader polls.
   *
   * Android 15 and later, and a hardware capability on top of that: plenty of
   * API 35 devices answer `false`. iOS has no equivalent.
   */
  readonly observeMode: boolean;
  /**
   * Whether the app can see a reader's polling loop frames.
   *
   * Android 15 and later. Only the platform matters here, not the controller: the
   * callback that carries them is on the emulation service.
   */
  readonly pollingFrames: boolean;
  readonly backgroundReading: boolean;
}

export interface NativeSessionOptions {
  readonly techs: readonly string[];
  /**
   * iOS: `NFCTagReaderSession.PollingOption` names to enable.
   *
   * `null` lets native derive them from `techs`, which is what almost every
   * caller wants; the override exists for a reader that needs an option no
   * technology in the list implies, such as `pace`.
   */
  readonly iosPollingOptions: readonly string[] | null;
  /** iOS: text shown in the system scanning sheet. */
  readonly iosAlertMessage: string | null;
  readonly iosInvalidateAfterFirstRead: boolean;
  /** iOS 26.4+: subset of the AIDs declared in Info.plist. */
  readonly iosSelectIdentifiers: readonly string[] | null;
  readonly iosFelicaSystemCodes: readonly string[] | null;
  /** Android: `FLAG_READER_SKIP_NDEF_CHECK`, faster ISO-DEP discovery. */
  readonly androidSkipNdefCheck: boolean;
  /** Android: `FLAG_READER_NO_PLATFORM_SOUNDS`. */
  readonly androidNoPlatformSounds: boolean;
  /**
   * Android: `EXTRA_READER_PRESENCE_CHECK_DELAY`, in milliseconds.
   *
   * The platform default is 125 ms, which several crypto sequences exceed --
   * DESFire authentication and GlobalPlatform key derivation both do -- and the
   * OS then declares the tag lost part-way through. `null` keeps the default.
   */
  readonly androidPresenceCheckDelayMs: number | null;
}

/* -------------------------------------------------------------------------- */
/* Card emulation                                                             */
/* -------------------------------------------------------------------------- */

/** Why the terminal stopped talking to the emulated card. */
export const HCE_DEACTIVATION_REASONS = ['linkLoss', 'deselected'] as const;

export type HceDeactivationReason = (typeof HCE_DEACTIVATION_REASONS)[number];

/**
 * One polling loop frame pattern the emulation service wants delivered.
 *
 * A reader polls before it selects anything, and the frames it sends often
 * identify it. Registering a filter is how a service asks to see them.
 */
export interface NativePollingLoopFilter {
  /**
   * Hexadecimal prefix, or a regular expression over hexadecimal when
   * `isPattern` is set.
   */
  readonly pattern: string;
  readonly isPattern: boolean;
  /**
   * Whether the platform should leave observe mode by itself on a match.
   *
   * The low-latency route for a reader the app already trusts, at the cost of the
   * confirmation step observe mode exists to allow.
   */
  readonly autoTransact: boolean;
}

export interface NativeHceOptions {
  /**
   * How long native waits for JavaScript to answer one command, in milliseconds.
   *
   * The deadline belongs in native because the thing with a deadline is the radio
   * link, and JavaScript is exactly what might be too busy to notice. When it
   * elapses native answers the terminal itself with `timeoutStatus`: a definite
   * refusal reaches the terminal as "this card cannot do that", whereas silence
   * makes it wait for its own timeout and then report a hardware fault.
   */
  readonly timeoutMs: number;
  /** Status word native sends when the deadline elapses, e.g. `0x6f00`. */
  readonly timeoutStatus: number;
  /**
   * AIDs to register for the app's HCE service, replacing the manifest's.
   *
   * `null` leaves the statically declared ones alone. Registering at runtime is
   * what makes an AID change not require a rebuild, which is the whole reason it
   * is here.
   */
  readonly aids: readonly string[] | null;
  /**
   * Whether to ask the platform to route taps here while the app is in front.
   *
   * Without it the user's default wallet keeps the tap, and the platform will not
   * let the app control observe mode or see polling frames.
   */
  readonly preferSelf: boolean;
  /** Whether to start with the card held silent. */
  readonly observeMode: boolean;
  readonly pollingLoopFilters: readonly NativePollingLoopFilter[] | null;
}

/** What `startHce` actually managed to arrange. */
export interface NativeHceStarted {
  /** Whether the platform routed taps to this app. Needs a foreground activity. */
  readonly preferred: boolean;
  /** Whether the card is being held silent. */
  readonly observeMode: boolean;
}

/** Error shape native attaches to an event, mirroring `NfcError`. */
export interface NativeErrorPayload {
  /** Must be a value of `NfcErrorCode`; validated on arrival. */
  readonly code: string;
  readonly message: string;
  readonly nativeCode: string | null;
  readonly recoverable: boolean | null;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export interface NativeTagDiscoveredEvent {
  readonly sessionId: string;
  readonly tag: NativeTagInfo;
}

export interface NativeTagLostEvent {
  readonly sessionId: string;
  readonly handleId: string;
}

export interface NativeSessionInvalidatedEvent {
  readonly sessionId: string;
  /** `null` when the session ended because JS closed it. */
  readonly error: NativeErrorPayload | null;
}

export interface NativeAvailabilityEvent {
  readonly supported: boolean;
  readonly enabled: boolean;
}

/**
 * A tag that arrived through an intent rather than through a reading session.
 *
 * Deliberately its own event rather than `onTagDiscovered` with a made-up
 * session id: a background tag has no session, no `tech` filter behind it and a
 * lifetime the app did not choose, and papering over that would make the two
 * indistinguishable in exactly the cases where the difference matters.
 */
export interface NativeBackgroundTagEvent {
  readonly tag: NativeTagInfo;
}

/**
 * One command APDU from a terminal, awaiting an answer.
 *
 * The APDU travels as hex rather than bytes, deliberately. Events carrying a
 * `ByteArray` have a history of arriving on Android as an opaque string id
 * (expo/expo#29566), and this is the one path where a second round trip to fetch
 * the bytes would cost real latency -- a terminal is holding the link open. A
 * command APDU is at most a few hundred bytes, so hex is cheap here in a way it
 * would not be for a tag payload.
 */
export interface NativeHceCommandEvent {
  readonly requestId: string;
  readonly commandHex: string;
}

export interface NativeHceDeactivatedEvent {
  /** One of `HCE_DEACTIVATION_REASONS`; validated on arrival. */
  readonly reason: string;
}

/** Frame types the platform distinguishes. `on` and `off` are the field itself. */
export const POLLING_FRAME_TYPES = ['a', 'b', 'f', 'on', 'off', 'unknown'] as const;

export type PollingFrameType = (typeof POLLING_FRAME_TYPES)[number];

export interface NativePollingFrame {
  /** One of `POLLING_FRAME_TYPES`; validated on arrival. */
  readonly type: string;
  /** The frame's bytes, as lowercase hex. Polling frames are a few bytes long. */
  readonly dataHex: string;
  /**
   * Vendor-specific field strength, or `-1` when the controller does not report it.
   *
   * Not comparable between devices, and not a distance.
   */
  readonly gain: number;
  /**
   * The platform's own monotonic value for when the frame was seen.
   *
   * Sound only for ordering frames and measuring the gap between them.
   */
  readonly timestamp: number;
  readonly triggeredAutoTransact: boolean;
}

export interface NativePollingFramesEvent {
  readonly frames: readonly NativePollingFrame[];
}

export interface NativeEventMap {
  readonly onTagDiscovered: (event: NativeTagDiscoveredEvent) => void;
  readonly onBackgroundTag: (event: NativeBackgroundTagEvent) => void;
  readonly onTagLost: (event: NativeTagLostEvent) => void;
  readonly onSessionInvalidated: (event: NativeSessionInvalidatedEvent) => void;
  readonly onAvailabilityChanged: (event: NativeAvailabilityEvent) => void;
  readonly onHceCommand: (event: NativeHceCommandEvent) => void;
  readonly onHceDeactivated: (event: NativeHceDeactivatedEvent) => void;
  readonly onPollingFrames: (event: NativePollingFramesEvent) => void;
}

export type NativeEventName = keyof NativeEventMap;

export const NATIVE_EVENT_NAMES = [
  'onTagDiscovered',
  'onBackgroundTag',
  'onTagLost',
  'onSessionInvalidated',
  'onAvailabilityChanged',
  'onHceCommand',
  'onHceDeactivated',
  'onPollingFrames',
] as const satisfies readonly NativeEventName[];

/* -------------------------------------------------------------------------- */
/* The module                                                                 */
/* -------------------------------------------------------------------------- */

export interface NativeSubscription {
  remove(): void;
}

/**
 * The native module surface.
 *
 * Every method is async and rejects with a coded error native produced. Nothing
 * here returns a native object; tags and sessions are opaque string ids so their
 * lifetime stays owned by native.
 */
export interface NativeNfcKitModule {
  /** Contract version the installed binary implements. */
  readonly contractVersion: number;
  readonly capabilities: NativeCapabilities;

  addListener<E extends NativeEventName>(event: E, listener: NativeEventMap[E]): NativeSubscription;

  // Availability
  isSupported(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  /** Android: opens the system NFC settings. Rejects `unsupportedPlatform` on iOS. */
  openSettings(): Promise<void>;

  // Session lifecycle. `sessionId` is minted by JS so the start call and the
  // events that follow can be correlated without a round trip.
  startSession(sessionId: string, options: NativeSessionOptions): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  /** iOS: updates the system sheet text. A no-op on Android. */
  setSessionAlert(sessionId: string, message: string): Promise<void>;

  // Tag operations. Native connects the required technology lazily and keeps at
  // most one connected at a time, which is what the hardware allows anyway.
  releaseTag(handleId: string): Promise<void>;

  readNdef(handleId: string): Promise<Uint8Array>;
  writeNdef(handleId: string, message: Uint8Array): Promise<void>;
  getNdefStatus(handleId: string): Promise<NativeNdefStatus>;
  makeNdefReadOnly(handleId: string): Promise<void>;
  formatNdef(handleId: string, message: Uint8Array): Promise<void>;

  transceive(handleId: string, tech: string, data: Uint8Array): Promise<Uint8Array>;
  getMaxTransceiveLength(handleId: string, tech: string): Promise<number>;
  /** Android only; rejects `unsupportedPlatform` on iOS. */
  setTechTimeout(handleId: string, tech: string, timeoutMs: number): Promise<void>;
  /** Android only; rejects `unsupportedPlatform` on iOS. */
  getTechTimeout(handleId: string, tech: string): Promise<number>;

  /** The tag that launched the app, consumed once. */
  takeLaunchTag(): Promise<NativeTagInfo | null>;

  // Card emulation. Android only; every one of these rejects
  // `unsupportedPlatform` on iOS.

  /** Whether this device can emulate a card at all. */
  isHceSupported(): Promise<boolean>;
  /** Whether this controller can hold an emulated card silent. */
  isObserveModeSupported(): Promise<boolean>;
  isObserveModeEnabled(): Promise<boolean>;
  /**
   * Holds the card silent, or lets it answer again.
   *
   * Resolves `false` when the platform refused -- it grants this only to the
   * service it currently prefers -- rather than reporting success for something
   * that did not happen.
   */
  setObserveModeEnabled(enabled: boolean): Promise<boolean>;
  startHce(options: NativeHceOptions): Promise<NativeHceStarted>;
  stopHce(): Promise<void>;
  /**
   * Answers one command.
   *
   * Resolves `false` when the command had already been answered -- because the
   * deadline elapsed first, or because the terminal went away. Not an error: it
   * is a race the caller cannot avoid and does not need to handle.
   */
  respondToHce(requestId: string, response: Uint8Array): Promise<boolean>;
}
