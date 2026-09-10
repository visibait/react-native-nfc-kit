import ExpoModulesCore
import UIKit
@preconcurrency import CoreNFC

/// Bumped together with `CONTRACT_VERSION` in `src/native/contract.ts`.
private let contractVersion = 5

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

/** Mirrors `NativeVasConfiguration`. */
internal struct VasConfigurationOptions: Record {
  @Field var mode: String = "normal"
  @Field var passTypeIdentifier: String = ""
  @Field var url: String?
}

/** Mirrors `NativeVasOptions`. */
internal struct VasOptions: Record {
  @Field var configurations: [VasConfigurationOptions] = []
  @Field var alertMessage: String?
}

/**
 The iOS module.

 Every asynchronous entry point takes an explicit `Promise` and does its work in a
 `Task`, rather than using the `async` closure overload of `AsyncFunction`. That
 is the pattern Expo's own modules use, and it is the deliberate choice here for
 two reasons: the `async` overload requires a `@Sendable` closure, which fights
 with capturing the module, and having both overloads in scope makes resolution
 depend on inference in a way that is easy to get subtly wrong. The `Promise` form
 is unambiguous and compiles the same in either Swift language mode.

 Marked `@unchecked Sendable` because the module is confined to its own queue and
 all mutable NFC state lives in `NfcSessionCoordinator`, which is an actor.
 */
public final class NfcKitModule: Module, @unchecked Sendable {
  /// Created lazily so the event sink can capture the module safely.
  private var coordinatorStorage: NfcSessionCoordinator?
  private var vasStorage: VasSessionCoordinator?

  private func vas() -> VasSessionCoordinator {
    if let vasStorage {
      return vasStorage
    }
    let created = VasSessionCoordinator()
    vasStorage = created
    return created
  }

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

  /// Runs asynchronous work that produces a value, and settles the promise.
  private func perform<T>(
    _ promise: Promise,
    _ what: String,
    _ work: @escaping () async throws -> T
  ) {
    Task {
      do {
        promise.resolve(try await work())
      } catch {
        promise.reject(NfcErrorMapping.exception(from: error, whileDoing: what))
      }
    }
  }

  /// The same, for work that produces nothing.
  ///
  /// A separate overload rather than a runtime check for `Void`: resolving a
  /// promise with `()` would hand JavaScript something meaningless, and testing a
  /// generic value's type at runtime to decide is exactly the kind of cleverness
  /// that reads fine and then behaves oddly.
  private func performVoid(
    _ promise: Promise,
    _ what: String,
    _ work: @escaping () async throws -> Void
  ) {
    Task {
      do {
        try await work()
        promise.resolve()
      } catch {
        promise.reject(NfcErrorMapping.exception(from: error, whileDoing: what))
      }
    }
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
        // CoreNFC has no tag-removal callback at any iOS version, so a card that
        // has gone is only discovered by the next operation failing.
        "tagLost": "none",
        // iOS 26.4 can narrow AIDs and FeliCa system codes per session. Adopting
        // it needs a build SDK that has NFCTagReaderSession.Configuration, so this
        // stays false until that lands rather than implying narrowing that does
        // not happen.
        "perSessionConfig": false,
        "hce": false,
        // Both are card emulation features, and card emulation is not available
        // here, so there is nothing for them to apply to.
        "observeMode": false,
        "pollingFrames": false,
        // The API is available from iOS 13 and the device can read NFC; whether
        // Apple has granted the entitlement is not something that can be asked,
        // only attempted. `readVas` reports entitlementMissing when it has not.
        "vas": NFCReaderSession.readingAvailable,
        "backgroundReading": false
      ] as [String: Any]
    }

    Events(
      "onTagDiscovered",
      "onBackgroundTag",
      "onTagLost",
      "onSessionInvalidated",
      "onAvailabilityChanged",
      "onHceCommand",
      "onHceDeactivated",
      "onPollingFrames"
    )

    /* -- Availability ---------------------------------------------------- */

    AsyncFunction("isSupported") { () -> Bool in
      NFCTagReaderSession.readingAvailable
    }

    AsyncFunction("isEnabled") { () -> Bool in
      // iOS has no user-facing NFC toggle, so "enabled" means the same as
      // "supported". Reporting true unconditionally, as the previous library did,
      // claims a working radio on an iPad.
      NFCTagReaderSession.readingAvailable
    }

    AsyncFunction("openSettings") { () throws -> Void in
      throw NfcException(
        NfcErrorCode.unsupportedPlatform,
        "iOS has no NFC settings screen and no way to link to one. NFC is always on when the "
          + "device supports it."
      )
    }

    /* -- Session lifecycle ----------------------------------------------- */

    AsyncFunction("startSession") { (sessionId: String, options: SessionOptions, promise: Promise) in
      self.performVoid(promise, "starting the session") {
        try await self.coordinator().start(
          sessionId: sessionId,
          techs: options.techs,
          alertMessage: options.iosAlertMessage
        )
      }
    }

    AsyncFunction("closeSession") { (sessionId: String, promise: Promise) in
      self.performVoid(promise, "closing the session") {
        await self.coordinator().close(sessionId: sessionId)
      }
    }

    AsyncFunction("setSessionAlert") { (sessionId: String, message: String, promise: Promise) in
      self.performVoid(promise, "updating the scanning sheet") {
        await self.coordinator().setAlert(sessionId: sessionId, message: message)
      }
    }

    /* -- Tag operations --------------------------------------------------- */

    AsyncFunction("releaseTag") { (handleId: String, promise: Promise) in
      self.performVoid(promise, "releasing the tag") {
        await self.coordinator().releaseTag(handleId)
      }
    }

    AsyncFunction("readNdef") { (handleId: String, promise: Promise) in
      self.perform(promise, "reading the NDEF message") {
        try await self.coordinator().handle(handleId).readNdef()
      }
    }

    AsyncFunction("writeNdef") { (handleId: String, message: Data, promise: Promise) in
      self.performVoid(promise, "writing the NDEF message") {
        try await self.coordinator().handle(handleId).writeNdef(message)
      }
    }

    AsyncFunction("getNdefStatus") { (handleId: String, promise: Promise) in
      self.perform(promise, "reading the NDEF status") {
        try await self.coordinator().handle(handleId).ndefStatusPayload()
      }
    }

    AsyncFunction("makeNdefReadOnly") { (handleId: String, promise: Promise) in
      self.performVoid(promise, "locking the tag read-only") {
        try await self.coordinator().handle(handleId).makeNdefReadOnly()
      }
    }

    AsyncFunction("formatNdef") { (_: String, _: Data) throws -> Void in
      // CoreNFC has no formatting API: a tag arrives either NDEF-capable or not.
      // The JavaScript guard already prevents this, since iOS never reports the
      // ndefFormatable technology; this is the backstop for an untyped caller.
      throw NfcException(
        NfcErrorCode.unsupportedPlatform,
        "CoreNFC cannot format a tag for NDEF. Format it on Android, or with a tag writer, and iOS "
          + "will then read and write it."
      )
    }

    AsyncFunction("transceive") { (handleId: String, tech: String, data: Data, promise: Promise) in
      self.perform(promise, "the exchange with the tag") {
        try await self.coordinator().handle(handleId).transceive(tech: tech, data: data)
      }
    }

    AsyncFunction("getMaxTransceiveLength") { (handleId: String, tech: String, promise: Promise) in
      self.perform(promise, "reading the maximum exchange length") {
        try await self.coordinator().handle(handleId).maxTransceiveLength(tech: tech)
      }
    }

    AsyncFunction("setTechTimeout") { (_: String, _: String, _: Int) throws -> Void in
      throw NfcException(
        NfcErrorCode.unsupportedPlatform,
        "CoreNFC does not expose per-technology timeouts. Guard this call with tag.android."
      )
    }

    AsyncFunction("getTechTimeout") { (_: String, _: String) throws -> Int in
      throw NfcException(
        NfcErrorCode.unsupportedPlatform,
        "CoreNFC does not expose per-technology timeouts. Guard this call with tag.android."
      )
    }

    AsyncFunction("takeLaunchTag") { () -> [String: Any]? in
      // Always nil, and this is the final answer rather than a placeholder. iOS
      // reads NDEF tags in the background itself, without involving the app: a
      // URI record opens its link, which reaches the app as a universal link if
      // the domain is yours. There is no CoreNFC surface that hands the app the
      // tag, so nothing here could return one.
      nil
    }

    /* -- Card emulation --------------------------------------------------- */

    AsyncFunction("isHceSupported") { () -> Bool in
      // Not a placeholder. iOS has had CardSession since 17.4, but it needs the
      // com.apple.developer.nfc.hce entitlement, which Apple grants case by case
      // after a request describing the use, and it works only in the EEA. An app
      // that has been through that process is not served by a library guessing;
      // reporting false is what lets `hce.isSupported()` be trusted.
      false
    }

    AsyncFunction("isObserveModeSupported") { () -> Bool in
      // Observe mode holds an emulated card silent, and there is no emulated card
      // here to hold.
      false
    }

    AsyncFunction("isObserveModeEnabled") { () -> Bool in
      false
    }

    AsyncFunction("setObserveModeEnabled") { (_: Bool) -> Bool in
      // False rather than a throw: this is the shape of "the platform refused",
      // which is a case every caller already handles, and a cleanup path should
      // not have to branch on the platform.
      false
    }

    AsyncFunction("startHce") { (_: [String: Any]) throws -> [String: Any] in
      throw NfcException(
        NfcErrorCode.unsupportedPlatform,
        "Card emulation is not available on iOS through this library. CoreNFC's CardSession "
          + "(iOS 17.4+) requires an Apple-granted entitlement and is limited to the EEA, so it "
          + "cannot be offered as a general capability. Guard with hce.isSupported()."
      )
    }

    AsyncFunction("stopHce") { () -> Void in
      // Stopping something that was never started is not an error, and a cleanup
      // path in a `finally` should not have to branch on the platform.
    }

    AsyncFunction("respondToHce") { (_: String, _: Data) -> Bool in
      // No command can have arrived, so there is nothing this could answer.
      false
    }

    /* -- Wallet passes ---------------------------------------------------- */

    AsyncFunction("isVasSupported") { () -> Bool in
      NFCReaderSession.readingAvailable
    }

    AsyncFunction("readVas") { (options: VasOptions, promise: Promise) in
      self.perform(promise, "reading a Wallet pass") {
        // iOS allows one reader session across the whole system, so the tag
        // coordinator is asked first. Two objects each believing they own "the"
        // session produces a SystemIsBusy from CoreNFC with nothing in the app
        // able to explain it.
        if await self.coordinator().isOpen {
          throw NfcException(
            NfcErrorCode.systemBusy,
            "A tag session is open. Close it before reading a Wallet pass: iOS allows one reader "
              + "session at a time."
          )
        }

        return try await self.vas().read(
          configurations: options.configurations.map {
            VasConfiguration(
              mode: $0.mode,
              passTypeIdentifier: $0.passTypeIdentifier,
              url: $0.url
            )
          },
          alertMessage: options.alertMessage
        )
      }
    }

    /* -- Lifecycle -------------------------------------------------------- */

    OnDestroy {
      // A session outliving the module would leave the system sheet up with
      // nothing behind it.
      if let coordinator = self.coordinatorStorage {
        Task { await coordinator.closeAny() }
      }
      if let vas = self.vasStorage {
        Task { await vas.teardown() }
      }
    }
  }
}
