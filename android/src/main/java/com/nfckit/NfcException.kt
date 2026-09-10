package com.nfckit

import expo.modules.kotlin.exception.CodedException

/**
 * Error codes, mirroring `NfcErrorCode` in TypeScript.
 *
 * These strings are the contract. JavaScript validates every incoming code
 * against its own list and reports anything unrecognised as `internalError`
 * rather than guessing, so a typo here surfaces as a clear diagnostic instead of
 * a silently mis-handled failure.
 */
object NfcErrorCode {
  const val USER_CANCELLED = "userCancelled"
  const val SESSION_TIMEOUT = "sessionTimeout"
  const val SESSION_CLOSED = "sessionClosed"
  const val SYSTEM_BUSY = "systemBusy"

  const val NFC_UNSUPPORTED = "nfcUnsupported"
  const val NFC_DISABLED = "nfcDisabled"
  const val NO_ACTIVITY = "noActivity"
  const val NOT_AUTHORIZED = "notAuthorized"

  const val TAG_LOST = "tagLost"
  const val TAG_CONNECTION_FAILED = "tagConnectionFailed"
  const val TECH_UNAVAILABLE = "techUnavailable"
  const val TAG_NOT_SUPPORTED = "tagNotSupported"

  const val IO_ERROR = "ioError"
  const val TRANSCEIVE_FAILED = "transceiveFailed"
  const val TRANSCEIVE_TOO_LONG = "transceiveTooLong"
  const val AUTHENTICATION_FAILED = "authenticationFailed"

  const val NDEF_NOT_SUPPORTED = "ndefNotSupported"
  const val NDEF_READ_ONLY = "ndefReadOnly"
  const val NDEF_CAPACITY_EXCEEDED = "ndefCapacityExceeded"
  const val NDEF_MALFORMED = "ndefMalformed"

  const val HCE_UNSUPPORTED = "hceUnsupported"
  const val HCE_NOT_ELIGIBLE = "hceNotEligible"

  const val INVALID_ARGUMENT = "invalidArgument"
  const val UNSUPPORTED_PLATFORM = "unsupportedPlatform"
  const val INTERNAL_ERROR = "internalError"
}

/**
 * The single exception type crossing the boundary.
 *
 * A rejection carries only `code` and `message` through Expo's promise -- there is
 * no slot for a structured `nativeCode` the way there is in an event payload. So
 * the originating exception's class name goes into the message instead, in
 * parentheses, where it is still the first thing a bug report shows. That is
 * deliberately not something JavaScript parses back out: the code is already
 * structured, and re-deriving error identity from a formatted string is exactly
 * what made the previous generation of this library impossible to handle
 * programmatically.
 */
class NfcException(
  code: String,
  message: String,
  cause: Throwable? = null,
) : CodedException(code, message, cause) {

  companion object {
    /** Builds an exception whose message names the underlying platform failure. */
    fun from(code: String, what: String, cause: Throwable): NfcException {
      val detail = cause.javaClass.name
      val reason = cause.message?.takeIf { it.isNotBlank() }
      val suffix = if (reason == null) "($detail)" else "($detail: $reason)"
      return NfcException(code, "$what $suffix", cause)
    }
  }
}
