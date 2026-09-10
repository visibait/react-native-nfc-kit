import ExpoModulesCore
import UIKit
@preconcurrency import CoreNFC

/// Bumped together with `CONTRACT_VERSION` in `src/native/contract.ts`.
private let contractVersion = 2

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
        "backgroundReading": false
      ] as [String: Any]
    }

    Events(
      "onTagDiscovered",
      "onBackgroundTag",
      "onTagLost",
      "onSessionInvalidated",
      "onAvailabilityChanged"
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
