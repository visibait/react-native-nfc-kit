import Foundation
@preconcurrency import CoreNFC

/// How the coordinator reports things JavaScript needs to know about.
internal typealias NfcEventSink = @Sendable (_ name: String, _ body: [String: Any?]) -> Void

/**
 Owns everything about an open reading session.

 All mutable state lives in this actor, which is the point. The library this
 replaces kept two mutually exclusive session variables plus four loose flags on
 one Objective-C object, created both sessions on the main queue, and guarded
 access with hand-written null checks copy-pasted about thirty times. The result
 was a class of bug -- callbacks firing twice, state read from the wrong thread --
 that it never fully closed.

 CoreNFC delegates cannot be actor-isolated, so [TagSessionDelegate] is a small
 `NSObject` whose only job is to hop into this actor. Nothing else touches the
 state.

 The session is created with its own serial queue rather than the main queue.
 CoreNFC will happily deliver on whichever queue it is given, and radio I/O can
 block for hundreds of milliseconds; running that on the main thread is why the
 previous library made scanning feel like the app had frozen.
 */
internal actor NfcSessionCoordinator {
  private let events: NfcEventSink

  private var sessionId: String?
  private var session: NFCTagReaderSession?
  private var delegate: TagSessionDelegate?
  private var handles: [String: IosTagHandle] = [:]
  private var handleCounter = 0

  /// CoreNFC delivers on this queue; it is never the main queue.
  private let nfcQueue = DispatchQueue(label: "com.nfckit.session", qos: .userInitiated)

  init(events: @escaping NfcEventSink) {
    self.events = events
  }

  var isOpen: Bool { session != nil }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  func start(sessionId: String, techs: [String], alertMessage: String?) throws {
    guard NFCTagReaderSession.readingAvailable else {
      throw NfcException(
        NfcErrorCode.nfcUnsupported,
        "This device cannot read NFC tags. Reading needs an iPhone 7 or later, and never works in "
          + "the Simulator."
      )
    }
    guard session == nil else {
      throw NfcException(
        NfcErrorCode.systemBusy,
        "An NFC session is already open. iOS allows only one at a time."
      )
    }

    let delegate = TagSessionDelegate(coordinator: self)
    // Deprecated in iOS 26.4 in favour of the Configuration initialiser, which
    // also allows narrowing AIDs and FeliCa system codes per session. Adopting
    // that needs a build SDK that has the type, so it is a follow-up; until then
    // capabilities reports perSessionConfig as false rather than implying
    // narrowing that does not happen.
    guard
      let created = NFCTagReaderSession(
        pollingOption: Self.pollingOptions(for: techs),
        delegate: delegate,
        queue: nfcQueue
      )
    else {
      throw NfcException(
        NfcErrorCode.invalidArgument,
        "iOS refused to create a reader session for the requested technologies "
          + "(\(techs.joined(separator: ", "))). At least one must map to a polling option."
      )
    }

    if let alertMessage, !alertMessage.isEmpty {
      created.alertMessage = alertMessage
    }

    self.sessionId = sessionId
    self.session = created
    self.delegate = delegate
    created.begin()
  }

  func close(sessionId: String) {
    guard self.sessionId == sessionId else {
      // Closing a session that already ended is not an error: JavaScript closes
      // in a finally block, which can run after iOS already invalidated it.
      return
    }
    session?.invalidate()
    reset()
  }

  /// Closes whatever session is open, whichever it is. For module teardown.
  func closeAny() {
    session?.invalidate()
    reset()
  }

  func setAlert(sessionId: String, message: String) {
    guard self.sessionId == sessionId, let session else {
      return
    }
    session.alertMessage = message
  }

  private func reset() {
    session = nil
    delegate = nil
    sessionId = nil
    handles.removeAll()
  }

  /* ---------------------------------------------------------------------- */
  /* Delegate callbacks                                                     */
  /* ---------------------------------------------------------------------- */

  fileprivate func handleDetected(_ tags: [NFCTag]) async {
    guard let session, let sessionId, let first = tags.first else {
      return
    }

    do {
      try await connect(session: session, to: first)
    } catch {
      // Reconnecting rather than failing the session: a tag that did not connect
      // is usually one the user moved too quickly, and the sheet is still up.
      session.restartPolling()
      return
    }

    handleCounter += 1
    let handle = IosTagHandle(id: "\(sessionId)-t\(handleCounter)", tag: first)
    await handle.discoverCapabilities()
    handles[handle.id] = handle

    events(
      "onTagDiscovered",
      [
        "sessionId": sessionId,
        "tag": [
          "handleId": handle.id,
          "idHex": handle.identifier.map(Hex.encode),
          "techs": handle.techs,
          "android": nil,
          "ios": [
            "coreNfcType": handle.coreNfcType,
            "historicalBytesHex": handle.historicalBytes.map(Hex.encode),
            "applicationDataHex": handle.applicationData.map(Hex.encode),
            "initialSelectedAid": handle.initialSelectedAid,
            "idmHex": handle.felicaIdm.map(Hex.encode),
            "systemCodeHex": handle.felicaSystemCode.map(Hex.encode),
            "icManufacturerCode": handle.icManufacturerCode
          ]
        ]
      ]
    )
  }

  private func connect(session: NFCTagReaderSession, to tag: NFCTag) async throws {
    let _: Bool = try await withOneShot { oneShot in
      session.connect(to: tag) { error in
        Task {
          if let error {
            await oneShot.resume(
              throwing: NfcErrorMapping.exception(from: error, whileDoing: "connecting to the tag")
            )
          } else {
            await oneShot.resume(returning: true)
          }
        }
      }
    }
  }

  fileprivate func handleInvalidated(_ error: Error) {
    guard let sessionId else {
      return
    }
    let mapped = NfcErrorMapping.exception(from: error, whileDoing: "the scanning session")

    events(
      "onSessionInvalidated",
      [
        "sessionId": sessionId,
        "error": [
          "code": mapped.code,
          "message": mapped.description,
          "nativeCode": (error as NSError).domain + ":" + String((error as NSError).code),
          "recoverable": nil
        ]
      ]
    )
    reset()
  }

  /* ---------------------------------------------------------------------- */
  /* Tag access                                                             */
  /* ---------------------------------------------------------------------- */

  func handle(_ handleId: String) throws -> IosTagHandle {
    guard let handle = handles[handleId] else {
      throw NfcException(
        NfcErrorCode.sessionClosed,
        "This tag is no longer available: its session has been closed."
      )
    }
    return handle
  }

  func releaseTag(_ handleId: String) {
    handles.removeValue(forKey: handleId)
  }

  /* ---------------------------------------------------------------------- */
  /* Polling                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   Turns requested technologies into CoreNFC polling options.

   NDEF is a data format rather than an RF technology, so asking for it polls
   everything that can carry one.
   */
  static func pollingOptions(for techs: [String]) -> NFCTagReaderSession.PollingOption {
    var options: NFCTagReaderSession.PollingOption = []

    for tech in techs {
      switch tech {
      case "ndef", "ndefFormatable":
        options.insert(.iso14443)
        options.insert(.iso15693)
        options.insert(.iso18092)
      case "isoDep", "mifareUltralight", "mifareClassic", "nfcA", "nfcB":
        options.insert(.iso14443)
      case "iso15693":
        options.insert(.iso15693)
      case "felica":
        options.insert(.iso18092)
      default:
        break
      }
    }

    // An empty option set makes the initialiser fail, and "poll for the common
    // case" is a better outcome than refusing to scan.
    if options.isEmpty {
      options.insert(.iso14443)
    }
    return options
  }
}

/**
 Bridges CoreNFC's delegate callbacks into the actor.

 Deliberately thin: it holds no state and makes no decisions, so there is nothing
 here to race.
 */
internal final class TagSessionDelegate: NSObject, NFCTagReaderSessionDelegate, @unchecked Sendable {
  private let coordinator: NfcSessionCoordinator

  init(coordinator: NfcSessionCoordinator) {
    self.coordinator = coordinator
  }

  func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {
    // Nothing to do: JavaScript already knows the session was started, and the
    // system sheet is what tells the user.
  }

  func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
    Task { await coordinator.handleDetected(tags) }
  }

  func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
    Task { await coordinator.handleInvalidated(error) }
  }
}

/// Hex helpers, matching the Android side. Small identifiers travel as hex.
internal enum Hex {
  static func encode(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }
}
