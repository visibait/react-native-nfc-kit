import Foundation
@preconcurrency import CoreNFC

/**
 A tag CoreNFC has connected, and the operations it actually supports.

 The technology list is worked out once, at connect time, and it is deliberately
 honest: `nfcA` and `nfcB` never appear, because CoreNFC offers no raw framing at
 that level, and `mifareClassic` never appears, because Crypto-1 is not
 implemented on iOS at any OS version. A caller narrowing with
 `tag.is('mifareClassic')` therefore gets `false` here rather than a method that
 exists and then fails.

 NDEF support is determined by asking the tag rather than assuming: every CoreNFC
 tag case conforms to `NFCNDEFTag`, so assuming would make `tag.is('ndef')` true
 for tags that hold no NDEF data at all. One `queryNDEFStatus` at connect time
 costs a single exchange and makes the answer true.
 */
internal final class IosTagHandle: @unchecked Sendable {
  let id: String
  let tag: NFCTag

  private(set) var techs: [String] = []
  private(set) var ndefStatus: NFCNDEFStatus = .notSupported
  private(set) var ndefCapacity: Int = 0

  init(id: String, tag: NFCTag) {
    self.id = id
    self.tag = tag
  }

  /* ---------------------------------------------------------------------- */
  /* Identity                                                               */
  /* ---------------------------------------------------------------------- */

  /// The UID, where CoreNFC exposes one.
  var identifier: Data? {
    switch tag {
    case .iso7816(let tag): return tag.identifier
    case .miFare(let tag): return tag.identifier
    case .iso15693(let tag): return tag.identifier
    case .feliCa: return nil  // FeliCa has an IDm rather than a UID.
    @unknown default: return nil
    }
  }

  /// Which CoreNFC case this arrived as, for diagnostics.
  var coreNfcType: String {
    switch tag {
    case .iso7816: return "iso7816"
    case .miFare: return "miFare"
    case .iso15693: return "iso15693"
    case .feliCa: return "feliCa"
    @unknown default: return "unknown"
    }
  }

  var historicalBytes: Data? {
    switch tag {
    case .iso7816(let tag): return tag.historicalBytes
    case .miFare(let tag): return tag.historicalBytes
    default: return nil
    }
  }

  var applicationData: Data? {
    if case .iso15693 = tag { return nil }
    if case .iso7816(let tag) = tag { return tag.applicationData }
    return nil
  }

  var initialSelectedAid: String? {
    if case .iso7816(let tag) = tag { return tag.initialSelectedAID }
    return nil
  }

  var felicaIdm: Data? {
    if case .feliCa(let tag) = tag { return tag.currentIDm }
    return nil
  }

  var felicaSystemCode: Data? {
    if case .feliCa(let tag) = tag { return tag.currentSystemCode }
    return nil
  }

  var icManufacturerCode: Int? {
    if case .iso15693(let tag) = tag { return tag.icManufacturerCode }
    return nil
  }

  /* ---------------------------------------------------------------------- */
  /* Capability discovery                                                   */
  /* ---------------------------------------------------------------------- */

  /// Works out what this tag supports. Called once, right after connecting.
  func discoverCapabilities() async {
    var found: [String] = []

    switch tag {
    case .iso7816:
      // An ISO 7816 tag speaks ISO-DEP by definition.
      found.append("isoDep")
    case .miFare(let mifare):
      switch mifare.mifareFamily {
      case .ultralight:
        found.append("mifareUltralight")
      case .desfire, .plus:
        // Both are ISO 14443-4, so APDUs are the right way to talk to them.
        found.append("isoDep")
      case .unknown:
        break
      @unknown default:
        break
      }
    case .iso15693:
      found.append("iso15693")
    case .feliCa:
      found.append("felica")
    @unknown default:
      break
    }

    if let ndefTag = ndefTag {
      let status = await queryNdefStatus(ndefTag)
      ndefStatus = status.0
      ndefCapacity = status.1
      if status.0 != .notSupported {
        found.append("ndef")
      }
    }

    techs = found
  }

  private var ndefTag: (any NFCNDEFTag)? {
    switch tag {
    case .iso7816(let tag): return tag
    case .miFare(let tag): return tag
    case .iso15693(let tag): return tag
    case .feliCa(let tag): return tag
    @unknown default: return nil
    }
  }

  private func queryNdefStatus(_ ndefTag: any NFCNDEFTag) async -> (NFCNDEFStatus, Int) {
    await withCheckedContinuation { continuation in
      ndefTag.queryNDEFStatus { status, capacity, _ in
        continuation.resume(returning: (status, capacity))
      }
    }
  }

  private func requireTech(_ tech: String, _ operation: String) throws {
    guard techs.contains(tech) else {
      throw NfcException(
        NfcErrorCode.techUnavailable,
        "\(operation) requires the \"\(tech)\" technology, which this tag does not support on iOS. "
          + "Available: \(techs.isEmpty ? "none" : techs.joined(separator: ", "))."
      )
    }
  }

  private func requireNdefTag() throws -> any NFCNDEFTag {
    try requireTech("ndef", "the NDEF operation")
    guard let ndefTag else {
      throw NfcException(NfcErrorCode.ndefNotSupported, "This tag does not expose an NDEF interface.")
    }
    return ndefTag
  }

  /* ---------------------------------------------------------------------- */
  /* NDEF                                                                   */
  /* ---------------------------------------------------------------------- */

  func readNdef() async throws -> Data {
    let ndefTag = try requireNdefTag()

    return try await withOneShot { oneShot in
      ndefTag.readNDEF { message, error in
        Task {
          if let error {
            // A tag that is NDEF-capable but empty reports an error rather than
            // an empty message. That is not a failure: an erased tag genuinely
            // holds nothing, and reporting it as broken would be wrong.
            if (error as NSError).code == NFCReaderError.ndefReaderSessionErrorZeroLengthMessage.rawValue {
              await oneShot.resume(returning: Data())
              return
            }
            await oneShot.resume(
              throwing: NfcErrorMapping.exception(from: error, whileDoing: "reading the NDEF message")
            )
            return
          }
          guard let message else {
            await oneShot.resume(returning: Data())
            return
          }
          await oneShot.resume(returning: NdefBytes.encode(message))
        }
      }
    }
  }

  func writeNdef(_ bytes: Data) async throws {
    let ndefTag = try requireNdefTag()

    guard ndefStatus == .readWrite else {
      throw NfcException(
        NfcErrorCode.ndefReadOnly,
        "This tag is read-only, so its NDEF message cannot be replaced."
      )
    }
    // Checked before writing: a tag that runs out of room part-way is left
    // holding a partial message, which is worse than not writing at all.
    guard bytes.count <= ndefCapacity else {
      throw NfcException(
        NfcErrorCode.ndefCapacityExceeded,
        "The message is \(bytes.count) bytes but this tag holds at most \(ndefCapacity)."
      )
    }

    let message = try NdefBytes.decode(bytes)

    let _: Bool = try await withOneShot { oneShot in
      ndefTag.writeNDEF(message) { error in
        Task {
          if let error {
            await oneShot.resume(
              throwing: NfcErrorMapping.exception(from: error, whileDoing: "writing the NDEF message")
            )
          } else {
            await oneShot.resume(returning: true)
          }
        }
      }
    }
  }

  func ndefStatusPayload() throws -> [String: Any?] {
    try requireTech("ndef", "reading the NDEF status")
    return [
      "writable": ndefStatus == .readWrite,
      "capacity": ndefCapacity,
      // CoreNFC has no query for this; the lock either succeeds or reports why.
      "canMakeReadOnly": ndefStatus == .readWrite,
      "typeName": nil
    ]
  }

  func makeNdefReadOnly() async throws {
    let ndefTag = try requireNdefTag()

    let _: Bool = try await withOneShot { oneShot in
      ndefTag.writeLock { error in
        Task {
          if let error {
            await oneShot.resume(
              throwing: NfcErrorMapping.exception(from: error, whileDoing: "locking the tag read-only")
            )
          } else {
            await oneShot.resume(returning: true)
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Raw exchange                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   Sends bytes and returns the response.

   For ISO-DEP the response includes the two status-word bytes, exactly as
   Android's `IsoDep.transceive` does, so the same JavaScript splits them off on
   both platforms. The library this replaces returned `[...bytes, sw1, sw2]` on
   iOS and raw bytes on Android for this same call.
   */
  func transceive(tech: String, data: Data) async throws -> Data {
    try requireTech(tech, "transceive")

    switch tech {
    case "isoDep":
      return try await sendApdu(data)
    case "mifareUltralight":
      guard case .miFare(let mifare) = tag else {
        throw NfcException(NfcErrorCode.techUnavailable, "This tag is not a MIFARE tag.")
      }
      return try await sendMifare(mifare, data)
    case "felica":
      guard case .feliCa(let felica) = tag else {
        throw NfcException(NfcErrorCode.techUnavailable, "This tag is not a FeliCa tag.")
      }
      return try await sendFelica(felica, data)
    case "iso15693":
      guard case .iso15693(let iso15693) = tag else {
        throw NfcException(NfcErrorCode.techUnavailable, "This tag is not an ISO 15693 tag.")
      }
      return try await sendIso15693(iso15693, data)
    default:
      throw NfcException(
        NfcErrorCode.techUnavailable,
        "CoreNFC offers no raw exchange for the \"\(tech)\" technology."
      )
    }
  }

  private func sendApdu(_ data: Data) async throws -> Data {
    guard let apdu = NFCISO7816APDU(data: data) else {
      throw NfcException(
        NfcErrorCode.invalidArgument,
        "These \(data.count) byte(s) are not a well-formed ISO 7816 APDU."
      )
    }

    switch tag {
    case .iso7816(let iso7816):
      return try await withOneShot { oneShot in
        iso7816.sendCommand(apdu: apdu) { response, sw1, sw2, error in
          Task { await Self.settleApdu(oneShot, response, sw1, sw2, error) }
        }
      }
    case .miFare(let mifare):
      return try await withOneShot { oneShot in
        mifare.sendMiFareISO7816Command(apdu) { response, sw1, sw2, error in
          Task { await Self.settleApdu(oneShot, response, sw1, sw2, error) }
        }
      }
    default:
      throw NfcException(NfcErrorCode.techUnavailable, "This tag does not accept APDUs.")
    }
  }

  private static func settleApdu(
    _ oneShot: OneShotContinuation<Data>,
    _ response: Data,
    _ sw1: UInt8,
    _ sw2: UInt8,
    _ error: Error?
  ) async {
    if let error {
      await oneShot.resume(throwing: NfcErrorMapping.exception(from: error, whileDoing: "the APDU exchange"))
      return
    }
    var full = response
    full.append(sw1)
    full.append(sw2)
    await oneShot.resume(returning: full)
  }

  private func sendMifare(_ mifare: any NFCMiFareTag, _ data: Data) async throws -> Data {
    try await withOneShot { oneShot in
      mifare.sendMiFareCommand(commandPacket: data) { response, error in
        Task {
          if let error {
            await oneShot.resume(
              throwing: NfcErrorMapping.exception(from: error, whileDoing: "the MIFARE exchange")
            )
          } else {
            await oneShot.resume(returning: response)
          }
        }
      }
    }
  }

  private func sendFelica(_ felica: any NFCFeliCaTag, _ data: Data) async throws -> Data {
    try await withOneShot { oneShot in
      felica.sendFeliCaCommandPacket(commandPacket: data) { response, error in
        Task {
          if let error {
            await oneShot.resume(
              throwing: NfcErrorMapping.exception(from: error, whileDoing: "the FeliCa exchange")
            )
          } else {
            await oneShot.resume(returning: response)
          }
        }
      }
    }
  }

  /**
   ISO 15693 has no raw transceive in CoreNFC, only structured requests.

   The first two bytes of `data` are taken as the request flags and the command
   code, matching the wire order an ISO 15693 command actually has, so a caller
   who knows the protocol can send the same bytes they would on Android.

   The catch, and it is a real one: CoreNFC exposes a typed method per standard
   command and `customCommand` only for the custom range. So a standard command
   code cannot go through here at all, and the limitation is reported plainly
   rather than handed to `customCommand` to fail with something opaque. Routing
   standard codes to their typed CoreNFC methods needs additions to the native
   contract and is a follow-up.
   */
  private func sendIso15693(_ tag: any NFCISO15693Tag, _ data: Data) async throws -> Data {
    guard data.count >= 2 else {
      throw NfcException(
        NfcErrorCode.invalidArgument,
        "An ISO 15693 request needs at least a flags byte and a command code; received \(data.count)."
      )
    }

    let flags = NFCISO15693RequestFlag(rawValue: data[data.startIndex])
    let commandCode = Int(data[data.startIndex + 1])
    let parameters = Data(data.dropFirst(2))

    // The ISO 15693 custom command range. Anything outside it is a standard
    // command, which CoreNFC only offers through its own typed methods.
    guard (0xa0...0xdf).contains(commandCode) else {
      throw NfcException(
        NfcErrorCode.techUnavailable,
        String(
          format:
            "CoreNFC cannot send the standard ISO 15693 command 0x%02X. It exposes a typed method "
            + "per standard command and a raw path only for the custom range 0xA0-0xDF, so this "
            + "works on Android but not on iOS. Guard it with tag.android, or use a custom command.",
          commandCode
        )
      )
    }

    return try await withOneShot { oneShot in
      tag.customCommand(requestFlags: flags, customCommandCode: commandCode, customRequestParameters: parameters) { response, error in
        Task {
          if let error {
            await oneShot.resume(
              throwing: NfcErrorMapping.exception(from: error, whileDoing: "the ISO 15693 exchange")
            )
          } else {
            await oneShot.resume(returning: response)
          }
        }
      }
    }
  }

  /**
   The largest single exchange this tag accepts.

   CoreNFC does not report one, unlike Android's `getMaxTransceiveLength`. Rather
   than invent a number, this reports the ISO 14443-4 maximum frame size, which is
   the practical ceiling for APDU work, and the documentation says the value is
   advisory on iOS.
   */
  func maxTransceiveLength(tech: String) throws -> Int {
    try requireTech(tech, "maxTransceiveLength")
    return 253
  }
}
