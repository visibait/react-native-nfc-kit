@preconcurrency import CoreNFC
import Foundation

/**
 Reading an Apple Wallet pass over NFC, with `NFCVASReaderSession`.

 This is the merchant side of Value Added Service: a terminal — here, an iPhone —
 asks a nearby iPhone or Watch for a pass of a particular type, and gets back the
 pass's data and a mobile token. It is how a loyalty card or a ticket in Wallet is
 read at a till.

 **It needs an entitlement Apple grants case by case.** Apple's own documentation
 says so and does not publish the key: "Using NFCVASReaderSession requires an
 entitlement from Apple." When it is granted, Apple provides the key and it appears
 in the App ID's capabilities, so an app that has been through that process knows
 what to add — and one that has not gets a session that invalidates immediately.
 That is why nothing here pretends to check for it: the only way to find out is to
 try, and the failure is reported as `entitlementMissing` rather than as something
 vague.

 Every declaration used here was taken from the CoreNFC header rather than
 recalled: `VASMode` is `URLOnly = 0` / `Normal = 1`, and the status words in
 `VASErrorCode` are real APDU values, `0x9000` for success down to `0x6340` for an
 unsupported application version.
 */

/// One `GET VAS DATA` command, as JavaScript describes it.
internal struct VasConfiguration: Sendable {
  let mode: String
  let passTypeIdentifier: String
  let url: String?
}

/// Turns a VAS status word into a name, so JavaScript never sees a bare integer.
internal func vasStatusName(_ status: Int) -> String {
  switch status {
  case 0x9000: return "success"
  case 0x6A83: return "dataNotFound"
  case 0x6287: return "dataNotActivated"
  case 0x6B00: return "wrongParameters"
  case 0x6700: return "wrongLength"
  case 0x6984: return "userIntervention"
  case 0x6A80: return "incorrectData"
  case 0x6340: return "unsupportedApplicationVersion"
  default: return "unknown"
  }
}

/**
 Owns one VAS session.

 Separate from the tag coordinator in code but not in effect: iOS allows a single
 reader session across the whole system, so [NfcSessionCoordinator] is asked
 whether one is open before this starts. Two objects that each believed they could
 own "the" session would produce a `SystemIsBusy` from CoreNFC with nothing in the
 app able to explain it.
 */
internal actor VasSessionCoordinator {
  private var session: NFCVASReaderSession?
  private var delegate: VasSessionDelegate?
  private var pending: OneShotContinuation<[[String: Any]]>?

  /// CoreNFC delivers on this queue, never the main one.
  private let nfcQueue = DispatchQueue(label: "com.nfckit.vas", qos: .userInitiated)

  var isOpen: Bool { session != nil }

  func read(
    configurations: [VasConfiguration],
    alertMessage: String?
  ) async throws -> [[String: Any]] {
    guard NFCReaderSession.readingAvailable else {
      throw NfcException(
        NfcErrorCode.nfcUnsupported,
        "This device cannot read NFC, so it cannot read a Wallet pass. Reading needs an iPhone 7 "
          + "or later, and never works in the Simulator."
      )
    }
    guard session == nil else {
      throw NfcException(
        NfcErrorCode.systemBusy,
        "A Wallet pass read is already in progress. iOS allows one reader session at a time."
      )
    }
    guard !configurations.isEmpty else {
      throw NfcException(
        NfcErrorCode.invalidArgument,
        "At least one pass type identifier is required; a session with none would ask for nothing."
      )
    }

    let commands = try configurations.map { configuration -> NFCVASCommandConfiguration in
      let mode: NFCVASCommandConfiguration.Mode
      switch configuration.mode {
      case "urlOnly": mode = .urlOnly
      case "normal": mode = .normal
      default:
        throw NfcException(
          NfcErrorCode.invalidArgument,
          "\"\(configuration.mode)\" is not a VAS mode; use \"normal\" or \"urlOnly\"."
        )
      }

      // A URL-only configuration without a URL asks the pass to open nothing,
      // which is a configuration that cannot do its job.
      if mode == .urlOnly, configuration.url == nil {
        throw NfcException(
          NfcErrorCode.invalidArgument,
          "The \"urlOnly\" mode needs a url; that mode exists to hand one to the pass."
        )
      }

      return NFCVASCommandConfiguration(
        vasMode: mode,
        passTypeIdentifier: configuration.passTypeIdentifier,
        url: configuration.url.flatMap(URL.init(string:))
      )
    }

    let sessionDelegate = VasSessionDelegate(coordinator: self)
    let created = NFCVASReaderSession(
      vasCommandConfigurations: commands,
      delegate: sessionDelegate,
      queue: nfcQueue
    )
    guard let created else {
      throw NfcException(
        NfcErrorCode.internalError,
        "CoreNFC refused to create the Wallet pass session."
      )
    }

    if let alertMessage {
      created.alertMessage = alertMessage
    }

    self.session = created
    self.delegate = sessionDelegate

    return try await withOneShot { oneShot in
      self.pending = oneShot
      created.begin()
    }
  }

  /// Ends the session, whether it produced anything or not.
  func teardown() {
    session?.invalidate()
    session = nil
    delegate = nil
    pending = nil
  }

  func handle(responses: [NFCVASResponse]) {
    let mapped = responses.map { response -> [String: Any] in
      let status = response.status.rawValue
      return [
        "status": status,
        "statusName": vasStatusName(status),
        // Hex rather than `Data` nested in a dictionary: bytes returned at the top
        // level of a function are known to convert, and inside a structure they
        // are the case this project has deliberately never relied on. A pass
        // payload is small, so the cost is a single decode in TypeScript.
        "vasDataHex": Hex.encode(response.vasData),
        "mobileTokenHex": Hex.encode(response.mobileToken)
      ]
    }

    let oneShot = pending
    pending = nil
    // Invalidated here rather than left to the delegate: the session has done its
    // one job, and leaving it open holds the system sheet up with nothing behind it.
    session?.invalidate()
    session = nil
    delegate = nil

    Task { await oneShot?.resume(returning: mapped) }
  }

  func handle(error: Error) {
    let oneShot = pending
    pending = nil
    session = nil
    delegate = nil

    Task {
      await oneShot?.resume(
        throwing: NfcException.exception(from: error, whileDoing: "reading a Wallet pass")
      )
    }
  }
}

/**
 The delegate CoreNFC talks to.

 A separate object because `NFCVASReaderSessionDelegate` is an `NSObjectProtocol`
 and an actor cannot conform to one. Everything it receives is handed straight
 into the actor, so nothing outside the actor ever touches session state.
 */
internal final class VasSessionDelegate: NSObject, NFCVASReaderSessionDelegate {
  private let coordinator: VasSessionCoordinator

  init(coordinator: VasSessionCoordinator) {
    self.coordinator = coordinator
  }

  func readerSession(_ session: NFCVASReaderSession, didReceive responses: [NFCVASResponse]) {
    Task { await coordinator.handle(responses: responses) }
  }

  func readerSession(_ session: NFCVASReaderSession, didInvalidateWithError error: Error) {
    Task { await coordinator.handle(error: error) }
  }
}
