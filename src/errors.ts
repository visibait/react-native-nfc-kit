/**
 * The single error type for the whole library.
 *
 * Every rejected promise, on every platform and in every layer, is an
 * `NfcError`. That is a deliberate constraint: the alternative -- a mix of raw
 * strings, bare `Error`s and a hierarchy of empty subclasses -- is what makes
 * NFC failures impossible to handle programmatically. Callers switch on `code`,
 * show `message`, and quote `nativeCode` in bug reports.
 *
 * This module is a leaf: it imports nothing, so both the pure codec layers and
 * the native boundary can depend on it without creating a cycle.
 */

/**
 * Machine-readable failure reason. Stable across versions: adding a member is a
 * minor release, changing the meaning of an existing one is a major.
 *
 * Consumers should always handle the `default` case, because new codes appear in
 * minor releases as more platform APIs get covered.
 */
export type NfcErrorCode =
  // Session lifecycle
  /** The user dismissed the iOS system scanning sheet, or cancelled explicitly. */
  | 'userCancelled'
  /** The platform ended the session by itself. On iOS this is the 60s limit. */
  | 'sessionTimeout'
  /** The session was already closed when the operation was attempted. */
  | 'sessionClosed'
  /** Another NFC session owns the radio. iOS allows exactly one system-wide. */
  | 'systemBusy'
  /** An `AbortSignal` fired. Deliberately distinct from `userCancelled`. */
  | 'aborted'
  /** The caller's own `timeoutMs` elapsed, as opposed to a platform limit. */
  | 'timeout'

  // Hardware, permissions, configuration
  /** No NFC hardware, or the OS/device cannot do what was asked. */
  | 'nfcUnsupported'
  /** NFC hardware exists but is switched off. Android can offer settings. */
  | 'nfcDisabled'
  /** Android reader mode needs a foreground Activity and there was none. */
  | 'noActivity'
  /** An iOS entitlement or Info.plist key required for this call is missing. */
  | 'entitlementMissing'
  /** The OS refused the operation for a reason other than a missing entitlement. */
  | 'notAuthorized'
  /** The JS bundle expects a native contract the installed binary does not have. */
  | 'contractMismatch'

  // Tag
  /** The tag left the field. Usually recoverable by presenting it again. */
  | 'tagLost'
  /** The tag was detected but could not be connected to. */
  | 'tagConnectionFailed'
  /** This tag does not support the requested technology on this platform. */
  | 'techUnavailable'
  /** The tag responded, but not in a way this library can interpret. */
  | 'tagNotSupported'

  // I/O
  /** Generic transport failure while talking to the tag. */
  | 'ioError'
  /** A transceive exchange failed. `nativeCode` carries the platform detail. */
  | 'transceiveFailed'
  /** The payload exceeded the tag's maximum transceive length. */
  | 'transceiveTooLong'
  /** Authentication against the tag failed, e.g. a wrong MIFARE sector key. */
  | 'authenticationFailed'

  // NDEF
  /** The tag is not NDEF capable and cannot be formatted as such. */
  | 'ndefNotSupported'
  /** The tag holds NDEF data but is permanently or currently read-only. */
  | 'ndefReadOnly'
  /** The message is larger than the tag's usable NDEF capacity. */
  | 'ndefCapacityExceeded'
  /** The bytes are not a well-formed NDEF message. */
  | 'ndefMalformed'

  // Host card emulation
  /** Card emulation is not available on this device or OS version. */
  | 'hceUnsupported'
  /** iOS `CardSession` requires an EEA account and device; this one is not. */
  | 'hceNotEligible'
  /** The platform's emulation time limit elapsed. iOS caps a session at 60s. */
  | 'hceMaxDurationReached'

  // Programming errors
  /** The caller passed something invalid. Always a bug in the calling code. */
  | 'invalidArgument'
  /** The call has no meaning on this platform and should have been guarded. */
  | 'unsupportedPlatform'
  /** A failure with no better classification. Always worth a bug report. */
  | 'internalError';

/**
 * Every {@link NfcErrorCode} as a runtime value.
 *
 * Needed because a code arriving from native is just a string and has to be
 * validated before it is trusted. The union above carries the documentation; this
 * array carries the values, and the two are kept in agreement by the compiler:
 * `satisfies` rejects an entry that is not a real code, and the assertion below
 * rejects a code that was added to the union but not listed here.
 */
export const NFC_ERROR_CODES = [
  'userCancelled',
  'sessionTimeout',
  'sessionClosed',
  'systemBusy',
  'aborted',
  'timeout',
  'nfcUnsupported',
  'nfcDisabled',
  'noActivity',
  'entitlementMissing',
  'notAuthorized',
  'contractMismatch',
  'tagLost',
  'tagConnectionFailed',
  'techUnavailable',
  'tagNotSupported',
  'ioError',
  'transceiveFailed',
  'transceiveTooLong',
  'authenticationFailed',
  'ndefNotSupported',
  'ndefReadOnly',
  'ndefCapacityExceeded',
  'ndefMalformed',
  'hceUnsupported',
  'hceNotEligible',
  'hceMaxDurationReached',
  'invalidArgument',
  'unsupportedPlatform',
  'internalError',
] as const satisfies readonly NfcErrorCode[];

// Fails to compile if a code exists in the union but is missing from the array
// above. The error message names the missing members.
type MissingErrorCodes = Exclude<NfcErrorCode, (typeof NFC_ERROR_CODES)[number]>;
const _everyErrorCodeIsListed: [MissingErrorCodes] extends [never] ? true : MissingErrorCodes =
  true;
void _everyErrorCodeIsListed;

const NFC_ERROR_CODE_SET: ReadonlySet<string> = new Set(NFC_ERROR_CODES);

/** Whether an arbitrary string is a known error code. */
export function isNfcErrorCode(value: string): value is NfcErrorCode {
  return NFC_ERROR_CODE_SET.has(value);
}

/** Where an error originated. */
export type NfcPlatform = 'ios' | 'android' | 'web' | 'js';

/**
 * Codes for which retrying the same operation is a reasonable thing to do,
 * typically after asking the user to present the tag again.
 *
 * Everything absent from this set is either a permanent platform limitation or a
 * bug in the calling code, and retrying it only burns battery.
 */
const RECOVERABLE_CODES: ReadonlySet<NfcErrorCode> = new Set<NfcErrorCode>([
  'sessionTimeout',
  'systemBusy',
  'timeout',
  'tagLost',
  'tagConnectionFailed',
  'ioError',
  'transceiveFailed',
]);

export interface NfcErrorInit {
  code: NfcErrorCode;
  message: string;
  platform?: NfcPlatform;
  /**
   * The platform's own identifier, never discarded. On iOS this is
   * `"<NSError domain>:<code>"`; on Android the exception class name.
   */
  nativeCode?: string;
  /** The underlying error, when there is one. */
  cause?: unknown;
  /** Overrides the default derived from {@link NfcErrorCode}. */
  recoverable?: boolean;
}

export class NfcError extends Error {
  override readonly name = 'NfcError';

  readonly code: NfcErrorCode;
  readonly platform: NfcPlatform;
  readonly nativeCode: string | undefined;

  /**
   * Whether presenting the tag again is worth trying. Derived from `code` unless
   * explicitly overridden.
   */
  readonly recoverable: boolean;

  constructor(init: NfcErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });

    this.code = init.code;
    this.platform = init.platform ?? 'js';
    this.nativeCode = init.nativeCode;
    this.recoverable = init.recoverable ?? RECOVERABLE_CODES.has(init.code);

    // Restores the prototype chain when the output is downlevelled, so
    // `instanceof NfcError` holds regardless of the consumer's build target.
    Object.setPrototypeOf(this, NfcError.prototype);
  }

  /**
   * Type guard, optionally narrowing to a specific code.
   *
   * Prefer this over `instanceof` at module boundaries: it keeps working when two
   * copies of the package end up in one bundle, which `instanceof` does not.
   */
  static is(value: unknown, code?: NfcErrorCode): value is NfcError {
    if (!(value instanceof Error) || (value as Partial<NfcError>).name !== 'NfcError') {
      return false;
    }
    return code === undefined || (value as NfcError).code === code;
  }

  /** A plain object suitable for logging or crash reporting. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      platform: this.platform,
      nativeCode: this.nativeCode,
      recoverable: this.recoverable,
    };
  }
}

/** Shorthand for the `invalidArgument` case, which the codec raises a lot. */
export function invalidArgument(message: string): NfcError {
  return new NfcError({ code: 'invalidArgument', message });
}

/** Shorthand for the `ndefMalformed` case. */
export function ndefMalformed(message: string, cause?: unknown): NfcError {
  return new NfcError(
    cause === undefined
      ? { code: 'ndefMalformed', message }
      : { code: 'ndefMalformed', message, cause },
  );
}
