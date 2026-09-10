import ExpoModulesCore
@preconcurrency import CoreNFC

/**
 Error codes, mirroring `NfcErrorCode` in TypeScript and `NfcErrorCode` in Kotlin.

 These strings are the contract. JavaScript validates every incoming code against
 its own list and reports anything unrecognised as `internalError` rather than
 guessing, so a typo here surfaces as a clear diagnostic instead of a silently
 mis-handled failure.
 */
internal enum NfcErrorCode {
  static let userCancelled = "userCancelled"
  static let sessionTimeout = "sessionTimeout"
  static let sessionClosed = "sessionClosed"
  static let systemBusy = "systemBusy"

  static let nfcUnsupported = "nfcUnsupported"
  static let entitlementMissing = "entitlementMissing"
  static let notAuthorized = "notAuthorized"

  static let tagLost = "tagLost"
  static let tagConnectionFailed = "tagConnectionFailed"
  static let techUnavailable = "techUnavailable"
  static let tagNotSupported = "tagNotSupported"

  static let ioError = "ioError"
  static let transceiveFailed = "transceiveFailed"
  static let transceiveTooLong = "transceiveTooLong"
  static let authenticationFailed = "authenticationFailed"

  static let ndefNotSupported = "ndefNotSupported"
  static let ndefReadOnly = "ndefReadOnly"
  static let ndefCapacityExceeded = "ndefCapacityExceeded"
  static let ndefMalformed = "ndefMalformed"

  static let invalidArgument = "invalidArgument"
  static let unsupportedPlatform = "unsupportedPlatform"
  static let internalError = "internalError"
}

/**
 The single exception type crossing the boundary from iOS.

 `Exception` derives its `code` from the class name unless one is supplied, so a
 single class with an explicit code keeps the contract in one place rather than
 spreading it across twenty subclasses.
 */
internal final class NfcException: Exception, @unchecked Sendable {
  init(_ code: String, _ reason: String) {
    super.init(name: "NfcException", description: reason, code: code)
  }
}

/**
 Maps CoreNFC's errors onto the shared codes.

 The identifying `NSError` domain and code go into the message rather than being
 discarded. They cannot travel as a separate field -- a rejection carries only a
 code and a message -- but they are the first thing a bug report needs, and they
 are deliberately not something JavaScript parses back out: the code is already
 structured, and re-deriving error identity from a formatted string is exactly
 what made the previous generation of this library impossible to handle
 programmatically.
 */
internal enum NfcErrorMapping {
  static func exception(from error: Error, whileDoing what: String) -> NfcException {
    if let nfcException = error as? NfcException {
      return nfcException
    }

    let nsError = error as NSError
    let origin = "\(nsError.domain):\(nsError.code)"

    guard let readerError = error as? NFCReaderError else {
      return NfcException(
        NfcErrorCode.internalError,
        "\(what) failed: \(nsError.localizedDescription) (\(origin))"
      )
    }

    let code = self.code(for: readerError.code)
    return NfcException(code, "\(describe(readerError, whileDoing: what)) (\(origin))")
  }

  private static func code(for reason: NFCReaderError.Code) -> String {
    switch reason {
    case .readerSessionInvalidationErrorUserCanceled:
      return NfcErrorCode.userCancelled
    case .readerSessionInvalidationErrorSessionTimeout:
      return NfcErrorCode.sessionTimeout
    case .readerSessionInvalidationErrorSystemIsBusy:
      return NfcErrorCode.systemBusy
    case .readerSessionInvalidationErrorSessionTerminatedUnexpectedly,
         .readerSessionInvalidationErrorFirstNDEFTagRead:
      return NfcErrorCode.sessionClosed
    case .readerTransceiveErrorTagConnectionLost,
         .readerTransceiveErrorTagResponseError,
         .readerTransceiveErrorSessionInvalidated:
      return NfcErrorCode.tagLost
    case .readerTransceiveErrorRetryExceeded,
         .readerTransceiveErrorPacketTooLong:
      return NfcErrorCode.ioError
    case .readerErrorUnsupportedFeature:
      return NfcErrorCode.techUnavailable
    case .readerErrorSecurityViolation:
      // Almost always a missing entitlement or Info.plist key rather than
      // anything the user did, so the message says where to look.
      return NfcErrorCode.entitlementMissing
    case .readerErrorInvalidParameter,
         .readerErrorInvalidParameterLength,
         .readerErrorParameterOutOfBound:
      return NfcErrorCode.invalidArgument
    case .readerErrorRadioDisabled:
      return NfcErrorCode.nfcUnsupported
    case .ndefReaderSessionErrorTagNotWritable:
      return NfcErrorCode.ndefReadOnly
    case .ndefReaderSessionErrorTagSizeTooSmall:
      return NfcErrorCode.ndefCapacityExceeded
    case .ndefReaderSessionErrorTagUpdateFailure:
      return NfcErrorCode.ioError
    case .ndefReaderSessionErrorZeroLengthMessage:
      return NfcErrorCode.ndefMalformed
    case .readerTransceiveErrorTagNotConnected:
      return NfcErrorCode.sessionClosed
    @unknown default:
      // A CoreNFC error this build has never seen. Reporting it as internal with
      // the domain and code intact beats mapping it to something plausible.
      return NfcErrorCode.internalError
    }
  }

  private static func describe(_ error: NFCReaderError, whileDoing what: String) -> String {
    switch error.code {
    case .readerSessionInvalidationErrorUserCanceled:
      return "The user cancelled the scan."
    case .readerSessionInvalidationErrorSessionTimeout:
      return "The scanning session reached the system's 60 second limit."
    case .readerSessionInvalidationErrorSystemIsBusy:
      return "Another NFC session already owns the radio. iOS allows only one at a time."
    case .readerTransceiveErrorTagConnectionLost:
      return "The tag left the field during \(what)."
    case .readerErrorSecurityViolation:
      return
        "iOS refused the NFC session. This usually means a missing entitlement or Info.plist key: "
        + "check com.apple.developer.nfc.readersession.formats, and that "
        + "NFCReaderUsageDescription is present and not empty."
    case .readerErrorUnsupportedFeature:
      return "This device or iOS version does not support what \(what) requires."
    default:
      return "\(what) failed: \(error.localizedDescription)"
    }
  }
}
