/**
 * NDEF record encoding and decoding (NFC Forum NDEF 1.0).
 *
 * A record header is one byte of flags plus a TNF:
 *
 * ```
 *  7   6   5   4   3   2 1 0
 * +---+---+---+---+---+-------+
 * |MB |ME |CF |SR |IL |  TNF  |
 * +---+---+---+---+---+-------+
 * ```
 *
 * - `MB` / `ME` mark the first and last record of a message.
 * - `SR` selects a 1-byte payload length instead of a 4-byte one.
 * - `IL` says an ID field is present.
 * - `CF` marks a chunked record, whose payload continues in following records.
 *
 * Chunking is the part almost every JavaScript implementation skips -- the
 * library this one replaces literally carries a `// chunkFlag TODO implement`.
 * Real tags written by other stacks do contain chunks, and a decoder that
 * ignores `CF` does not fail loudly; it returns a truncated payload that looks
 * plausible. That is the worst possible outcome, so it is handled here.
 */

import { ByteReader, ByteWriter, EMPTY_BYTES } from './bytes.js';
import { invalidArgument, ndefMalformed } from '../errors.js';

/**
 * Type Name Format: how to interpret a record's `type` field.
 *
 * A frozen object rather than a TypeScript `enum`, because an `enum` in a
 * declaration file with a plain object at runtime is a lie the compiler cannot
 * catch -- and that is exactly what the previous generation of this library
 * shipped.
 */
export const Tnf = {
  /** No type, ID or payload. */
  Empty: 0x00,
  /** NFC Forum well-known type, e.g. `T` for text or `U` for a URI. */
  WellKnown: 0x01,
  /** A MIME type per RFC 2046. */
  MimeMedia: 0x02,
  /** An absolute URI per RFC 3986, in the `type` field. */
  AbsoluteUri: 0x03,
  /** An NFC Forum external type, e.g. `android.com:pkg`. */
  ExternalType: 0x04,
  /** Payload type is unknown; the type field is empty. */
  Unknown: 0x05,
  /** Marks a chunk continuation. Never appears on a reassembled record. */
  Unchanged: 0x06,
  /** Reserved by the specification. Valid to parse, meaningless to act on. */
  Reserved: 0x07,
} as const;

export type Tnf = (typeof Tnf)[keyof typeof Tnf];

const TNF_VALUES: ReadonlySet<number> = new Set(Object.values(Tnf));

export function isTnf(value: number): value is Tnf {
  return TNF_VALUES.has(value);
}

/** Header bit masks. */
const FLAG_MB = 0x80;
const FLAG_ME = 0x40;
const FLAG_CF = 0x20;
const FLAG_SR = 0x10;
const FLAG_IL = 0x08;
const MASK_TNF = 0x07;

/** The largest payload a short record can express. */
export const SHORT_RECORD_MAX_PAYLOAD = 0xff;

/**
 * A single NDEF record, with chunking already resolved.
 *
 * All three byte fields are always present; absent ones are zero-length rather
 * than `undefined`, so callers never have to null-check before reading `.length`.
 */
export interface NdefRecord {
  readonly tnf: Tnf;
  /** Type identifier, interpreted according to {@link NdefRecord.tnf}. */
  readonly type: Uint8Array;
  /** Optional record ID. Zero-length when the `IL` flag was not set. */
  readonly id: Uint8Array;
  readonly payload: Uint8Array;
}

/** Header flags of a record as it appeared on the wire. */
export interface RecordFlags {
  /** Message Begin. */
  readonly messageBegin: boolean;
  /** Message End. */
  readonly messageEnd: boolean;
  /** Chunk Flag: this record's payload continues in the next record. */
  readonly chunked: boolean;
  /** Short Record: the payload length was encoded in one byte. */
  readonly shortRecord: boolean;
  /** ID Length present. */
  readonly hasId: boolean;
}

/** A decoded record together with the flags it carried. */
export interface RawRecord {
  readonly record: NdefRecord;
  readonly flags: RecordFlags;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

export interface NdefRecordInit {
  tnf: Tnf;
  type?: Uint8Array;
  id?: Uint8Array;
  payload?: Uint8Array;
}

/**
 * Builds a record, validating the combinations the specification forbids.
 *
 * Rejecting these at construction time rather than at write time means the error
 * points at the code that built the record, not at a tag write three functions
 * away.
 */
export function createRecord(init: NdefRecordInit): NdefRecord {
  if (!isTnf(init.tnf)) {
    throw invalidArgument(`Invalid TNF value ${init.tnf}; expected 0..7.`);
  }

  const type = init.type ?? EMPTY_BYTES;
  const id = init.id ?? EMPTY_BYTES;
  const payload = init.payload ?? EMPTY_BYTES;

  if (init.tnf === Tnf.Empty && (type.length > 0 || id.length > 0 || payload.length > 0)) {
    throw invalidArgument('An Empty record (TNF 0x00) must have no type, ID or payload.');
  }
  if (init.tnf === Tnf.Unknown && type.length > 0) {
    throw invalidArgument('An Unknown record (TNF 0x05) must have an empty type.');
  }
  if (init.tnf === Tnf.Unchanged) {
    throw invalidArgument(
      'TNF 0x06 (Unchanged) only marks a chunk continuation and cannot be constructed directly; ' +
        'the encoder produces it when chunking.',
    );
  }
  if (type.length > 0xff) {
    throw invalidArgument(`Record type is ${type.length} bytes; the maximum is 255.`);
  }
  if (id.length > 0xff) {
    throw invalidArgument(`Record ID is ${id.length} bytes; the maximum is 255.`);
  }

  return { tnf: init.tnf, type, id, payload };
}

/** The canonical empty record: a single record with TNF 0x00 and nothing else. */
export function createEmptyRecord(): NdefRecord {
  return { tnf: Tnf.Empty, type: EMPTY_BYTES, id: EMPTY_BYTES, payload: EMPTY_BYTES };
}

/* -------------------------------------------------------------------------- */
/* Decoding                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads one record from `reader`, without interpreting chunking.
 *
 * Chunk reassembly needs to see several records at once and therefore belongs to
 * the message layer; this function stays a faithful single-record parser.
 */
export function decodeRecord(reader: ByteReader): RawRecord {
  const header = reader.u8('record header');

  // Masking with 0x07 can only yield 0..7, and every one of those is a defined
  // TNF including Reserved, so no validation is possible or needed here. The
  // assertion documents that rather than adding an unreachable branch.
  const tnfValue = (header & MASK_TNF) as Tnf;

  const flags: RecordFlags = {
    messageBegin: (header & FLAG_MB) !== 0,
    messageEnd: (header & FLAG_ME) !== 0,
    chunked: (header & FLAG_CF) !== 0,
    shortRecord: (header & FLAG_SR) !== 0,
    hasId: (header & FLAG_IL) !== 0,
  };

  const typeLength = reader.u8('type length');
  const payloadLength = flags.shortRecord
    ? reader.u8('payload length')
    : reader.u32be('payload length');
  const idLength = flags.hasId ? reader.u8('ID length') : 0;

  // Type and ID are read first so that a truncation in either is reported
  // against that field rather than blamed on the payload.
  const type = reader.copy(typeLength, 'record type');
  const id = reader.copy(idLength, 'record ID');

  // A corrupted 4-byte length can claim gigabytes. Checking before the read
  // means the error names the impossible length instead of surfacing as an
  // allocation failure with no context.
  if (payloadLength > reader.remaining) {
    throw ndefMalformed(
      `Record claims a ${payloadLength}-byte payload but only ${reader.remaining} byte(s) remain.`,
    );
  }

  const payload = reader.copy(payloadLength, 'record payload');

  return { record: { tnf: tnfValue, type, id, payload }, flags };
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* -------------------------------------------------------------------------- */

export interface EncodeRecordOptions {
  readonly messageBegin: boolean;
  readonly messageEnd: boolean;
  /** Forces a 4-byte payload length even when a short record would fit. */
  readonly forceLongRecord?: boolean;
}

/**
 * Appends one record to `writer`.
 *
 * The short-record form is chosen automatically whenever the payload fits, which
 * is what every other implementation expects to read back;
 * `forceLongRecord` exists for round-trip tests and for deliberately exercising
 * the 4-byte length path.
 */
export function encodeRecord(
  writer: ByteWriter,
  record: NdefRecord,
  options: EncodeRecordOptions,
): void {
  const useShortRecord =
    options.forceLongRecord !== true && record.payload.length <= SHORT_RECORD_MAX_PAYLOAD;
  const hasId = record.id.length > 0;

  let header = record.tnf;
  if (options.messageBegin) {
    header |= FLAG_MB;
  }
  if (options.messageEnd) {
    header |= FLAG_ME;
  }
  if (useShortRecord) {
    header |= FLAG_SR;
  }
  if (hasId) {
    header |= FLAG_IL;
  }

  writer.u8(header);
  writer.u8(record.type.length);

  if (useShortRecord) {
    writer.u8(record.payload.length);
  } else {
    writer.u32be(record.payload.length);
  }

  if (hasId) {
    writer.u8(record.id.length);
  }

  writer.bytes(record.type);
  writer.bytes(record.id);
  writer.bytes(record.payload);
}

/** Byte length this record will occupy once encoded. */
export function encodedRecordLength(record: NdefRecord, forceLongRecord = false): number {
  const useShortRecord = !forceLongRecord && record.payload.length <= SHORT_RECORD_MAX_PAYLOAD;
  const hasId = record.id.length > 0;

  return (
    1 + // header
    1 + // type length
    (useShortRecord ? 1 : 4) +
    (hasId ? 1 : 0) +
    record.type.length +
    record.id.length +
    record.payload.length
  );
}
