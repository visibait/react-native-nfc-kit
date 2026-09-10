import Foundation
@preconcurrency import CoreNFC

/**
 Converts between `NFCNDEFMessage` and raw NDEF bytes.

 The write direction is free: `NFCNDEFMessage(data:)` exists. The read direction
 is not -- `NFCNDEFMessage` exposes `records` and `length` but no way to get the
 encoded bytes back out -- so the encoder below exists to fill that gap.

 That is a deliberate, contained duplication of the record header layout, and it
 is worth being explicit about why it is here rather than avoided:

 - The alternative is returning parsed records across the boundary, which means a
   `Uint8Array` inside a record inside an array. That is the least-exercised
   conversion path in Expo Modules, and Android has a standing bug in the closely
   related event path (expo/expo#29566). A single `Uint8Array` return is the
   best-trodden path there is.
 - Keeping raw bytes as the contract means the *decoding* happens once, in
   TypeScript, identically on both platforms. Chunk reassembly, UTF-16 text
   records and malformed-input handling then behave the same everywhere instead of
   inheriting whatever each platform's own NDEF parser does. The TypeScript
   decoder is covered at 100% of branches; a second parser would not be.

 So the duplication is 40 lines of header assembly, not a second parser, and it
 produces input for a decoder that is already thoroughly tested.

 Header layout, for reference:

 ```
  7   6   5   4   3   2 1 0
 +---+---+---+---+---+-------+
 |MB |ME |CF |SR |IL |  TNF  |
 +---+---+---+---+---+-------+
 ```
 */
internal enum NdefBytes {
  private static let flagMessageBegin: UInt8 = 0x80
  private static let flagMessageEnd: UInt8 = 0x40
  private static let flagShortRecord: UInt8 = 0x10
  private static let flagIdLength: UInt8 = 0x08

  /// The largest payload a short record can express.
  private static let shortRecordMaxPayload = 0xff

  /// Encodes a message into the bytes a tag would hold.
  static func encode(_ message: NFCNDEFMessage) -> Data {
    let records = message.records

    // An empty message is written as the canonical single empty record, which is
    // what erasing a tag stores. Emitting nothing would leave a reader unable to
    // tell "erased" from "unreadable".
    guard !records.isEmpty else {
      return Data([0xd0, 0x00, 0x00])
    }

    var out = Data()
    for (index, record) in records.enumerated() {
      appendRecord(
        record,
        isFirst: index == 0,
        isLast: index == records.count - 1,
        to: &out
      )
    }
    return out
  }

  private static func appendRecord(
    _ record: NFCNDEFPayload,
    isFirst: Bool,
    isLast: Bool,
    to out: inout Data
  ) {
    let type = record.type
    let identifier = record.identifier
    let payload = record.payload

    let useShortRecord = payload.count <= shortRecordMaxPayload
    let hasIdentifier = !identifier.isEmpty

    var header = record.typeNameFormat.rawValue & 0x07
    if isFirst { header |= flagMessageBegin }
    if isLast { header |= flagMessageEnd }
    if useShortRecord { header |= flagShortRecord }
    if hasIdentifier { header |= flagIdLength }

    out.append(header)
    out.append(UInt8(truncatingIfNeeded: type.count))

    if useShortRecord {
      out.append(UInt8(truncatingIfNeeded: payload.count))
    } else {
      let length = UInt32(payload.count)
      out.append(UInt8(truncatingIfNeeded: length >> 24))
      out.append(UInt8(truncatingIfNeeded: length >> 16))
      out.append(UInt8(truncatingIfNeeded: length >> 8))
      out.append(UInt8(truncatingIfNeeded: length))
    }

    if hasIdentifier {
      out.append(UInt8(truncatingIfNeeded: identifier.count))
    }

    out.append(type)
    out.append(identifier)
    out.append(payload)
  }

  /// Parses raw bytes into a message CoreNFC can write.
  static func decode(_ data: Data) throws -> NFCNDEFMessage {
    guard let message = NFCNDEFMessage(data: data) else {
      throw NfcException(
        NfcErrorCode.ndefMalformed,
        "These \(data.count) byte(s) are not a well-formed NDEF message, so CoreNFC will not write them."
      )
    }
    return message
  }
}
