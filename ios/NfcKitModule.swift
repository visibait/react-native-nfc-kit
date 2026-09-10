import ExpoModulesCore
import UIKit
@preconcurrency import CoreNFC

/// Bumped together with `CONTRACT_VERSION` in `src/native/contract.ts`.
private let contractVersion = 1

/// Mirrors `NativeSessionOptions`. The Android fields are accepted and ignored.
internal struct SessionOptions: Record {
  @Field var techs: [String] = []
  @Field var iosPollingOptions: [String]?
  @Field var iosAlertMessage: String?
  @Field var iosInvalidateAfterFirstRead: Bool = false
  @Field var iosSelectIdentifiers: [String]?
  @Field var iosFelicaSystemCodes: [String]?
  @Field var androidSkipNdefCheck: Bool = false
  @Field var androidNoPlatformSounds: Bool = false
  @Field var androidPresenceCheckDelayMs: Int?
}

public final class NfcKitModule: Module {
  /// Created lazily so the event sink can capture `self` safely.
  private var coordinatorStorage: NfcSessionCoordinator?

  private func coordinator() -> NfcSessionCoordinator {
    if let coordinatorStorage {
      return coordinatorStorage
    }
    let created = NfcSessionCoordinator { [weak self] name, body in
      self?.sendEvent(name, body)
    }
    coordinatorStorage = created
    return created
  }

  public func definition() -> ModuleDefinition {
    Name("NfcKit")

    Constant("contractVersion") { contractVersion }

    Constant("capabilities") {
      [
        "platform": "ios",
        "osVersion": UIDevice.current.systemVersion,
        // What CoreNFC can reach. MIFARE Classic is absent because Crypto-1 is
        // not implemented on iOS at any OS version, and raw NfcA/NfcB are absent
        // because CoreNFC offers no framing at that level. Saying so here is what
        // makes tag.is('mifareClassic') honestly false rather than a method that
        // exists and then fails.
        "techs": ["ndef", "isoDep", "iso15693", "felica", "mifareUltralight"],
        // iOS reports no tag-removal callback at all.
        "nativeTagLost": false,
        // iOS 26.4 can narrow AIDs and FeliCa system codes per session. Adopting
        // it needs a build SDK that has NFCTagReaderSession.Configuration, so
        // this stays false until that lands rather than implying narrowing that
        // does not happen.
        "perSessionConfig": false,
        "hce": false,
        "backgroundReading": false
      ] as [String: Any]
    }

    Events("onTagDiscovered", "onTagLost", "onSessionInvalidated", "onAvailabilityChanged")

    /* -- Availability ---------------------------------------------------- */

    AsyncFunction("isSupported") { () -> Bool in
      NFCTagReaderSession.readingAvailable
    }

    AsyncFunction("isEnabled") { () -> Bool in
      // iOS has no user-facing NFC toggle, so "enabled" means the same as
      // "supported". Reporting true unconditionally, as the previous library
      // did, claims a working radio on an iPad.
      NFCTagReaderSession.readingAvailable
    }

    AsyncFunction("openSettings") { () -> Void in
      throw NfcException(
        NfcErrorCode.unsupportedPlatform,
        "iOS has no NFC settings screen and no way to link to one. NFC is always on when the "
          + "device supports it."
      )
    }

    /* -- Session lifecycle ----------------------------------------------- */

    AsyncFunction("startSession") { (sessionId: String, options: SessionOptions) in
      try await self.coordinator().start(
        sessionId: sessionId,
        techs: options.techs,
        alertMessage: options.iosAlertMessage
      )
    }

    AsyncFunction("closeSession") { (sessionId: String) in
      await self.coordinator().close(sessionId: sessionId)
    }

    AsyncFunction("setSessionAlert") { (sessionId: String, message: String) in
      await self.coordinator().setAlert(sessionId: sessionId, message: message)
    }

    /* -- Tag operations --------------------------------------------------- */

    AsyncFunction("releaseTag") { (handleId: String) in
      await self.coordinator().releaseTag(handleId)
    }

    AsyncFunction("readNdef") { (handleId: String) -> Data in
      try await self.coordinator().handle(handleId).readNdef()
    }

    AsyncFunction("writeNdef") { (handleId: String, message: Data) in
      try await self.coordinator().handle(handleId).writeNdef(message)
    }

    AsyncFunction("getNdefStatus") { (handleId: String) -> [String: Any?] in
      try await self.coordinator().handle(handleId).ndefStatusPayload()
    }

    AsyncFunction("makeNdefReadOnly") { (handleId: String) in
      try await self.coordinator().handle(handleId).makeNdefReadOnly()
    }

    AsyncFunction("formatNdef") { (_: String, _: Data) in
      // CoreNFC has no formatting API: a tag arrives either NDEF-capable or not.
      throw NfcException(
        NfcErrorCode.unsupportedPlatform,
        "CoreNFC cannot format a tag for NDEF. Format it on Android, or with a tag writer, and "
          + "iOS will then read and write it."
      )
    }

    AsyncFunction("transceive") { (handleId: String, tech: String, data: Data) -> Data in
      try await self.coordinator().handle(handleId).transceive(tech: tech, data: data)
    }

    AsyncFunction("getMaxTransceiveLength") { (handleId: String, tech: String) -> Int in
      try await self.coordinator().handle(handleId).maxTransceiveLength(tech: tech)
    }

    AsyncFunction("setTechTimeout") { (_: String, _: String, _: Int) in
      throw NfcException(
        NfcErrorCode.unsupportedPlatform,
        "CoreNFC does not expose per-technology timeouts. Guard this call with tag.android."
      )
    }

    AsyncFunction("getTechTimeout") { (_: String, _: String) -> Int in
      throw NfcException(
        NfcErrorCode.unsupportedPlatform,
        "CoreNFC does not expose per-technology timeouts. Guard this call with tag.android."
      )
    }

    AsyncFunction("takeLaunchTag") { () -> [String: Any?]? in
      // Background NDEF hand-off lands in a later milestone. Reporting nil is
      // accurate today; inventing a tag would not be.
      nil
    }

    /* -- Lifecycle -------------------------------------------------------- */

    OnDestroy {
      // A session outliving the module would leave the system sheet up with
      // nothing behind it.
      if let coordinator = self.coordinatorStorage {
        Task { await coordinator.closeAny() }
      }
    }
  }
}
