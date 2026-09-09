/**
 * NDEF message encoding and decoding.
 *
 * A message is a sequence of records where the first carries `MB`, the last
 * carries `ME`, and a run of records joined by `CF` forms one logical payload.
 * This layer enforces those rules and resolves chunking, so everything above it
 * sees a flat list of complete records and never has to think about `CF` again.
 *
 * The validation is strict on purpose. A decoder that shrugs at a missing `MB`
 * or at trailing bytes will happily return a half-parsed message, and the caller
 * has no way to tell that from a real one.
 */

import { ByteReader, ByteWriter, concatBytes } from './bytes';
import {
  Tnf,
  decodeRecord,
  encodeRecord,
  encodedRecordLength,
  type NdefRecord,
  type RawRecord,
} from './record';
import { ndefMalformed } from '../errors';

/**
 * A decoded NDEF message: records in order, chunking already resolved.
 *
 * A plain array rather than a wrapper object, because that is what callers
 * actually want to map and destructure.
 */
export type NdefMessage = readonly NdefRecord[];

/* -------------------------------------------------------------------------- */
/* Decoding                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Decodes a complete NDEF message.
 *
 * Zero-length input decodes to an empty message rather than an error: that is
 * what a formatted but never-written tag reads back as, and treating a blank tag
 * as corrupt would be actively unhelpful.
 */
export function decodeMessage(bytes: Uint8Array): NdefMessage {
  if (bytes.length === 0) {
    return [];
  }

  const reader = new ByteReader(bytes);
  const records: NdefRecord[] = [];

  /** Head of the chunk chain currently being assembled, if any. */
  let chunkHead: NdefRecord | undefined;
  let chunkPayloads: Uint8Array[] = [];
  let sawMessageEnd = false;
  let index = 0;

  while (!reader.exhausted) {
    if (sawMessageEnd) {
      throw ndefMalformed(
        `${reader.remaining} trailing byte(s) after the record carrying the Message End flag.`,
      );
    }

    const raw = decodeRecord(reader);
    validateFlags(raw, index, chunkHead !== undefined);

    if (chunkHead === undefined) {
      if (raw.flags.chunked) {
        // Opens a chain: this record supplies the TNF, type and ID for the whole
        // reassembled payload.
        chunkHead = raw.record;
        chunkPayloads = [raw.record.payload];
      } else {
        records.push(raw.record);
      }
    } else {
      chunkPayloads.push(raw.record.payload);

      if (!raw.flags.chunked) {
        // Closes the chain.
        records.push({
          tnf: chunkHead.tnf,
          type: chunkHead.type,
          id: chunkHead.id,
          payload: concatBytes(...chunkPayloads),
        });
        chunkHead = undefined;
        chunkPayloads = [];
      }
    }

    if (raw.flags.messageEnd) {
      sawMessageEnd = true;
    }
    index += 1;
  }

  if (chunkHead !== undefined) {
    throw ndefMalformed(
      'Message ends inside a chunked record: the final chunk must clear the Chunk Flag.',
    );
  }
  if (!sawMessageEnd) {
    throw ndefMalformed('Message has no record carrying the Message End flag.');
  }

  return records;
}

/**
 * Checks the flag combinations the specification forbids.
 *
 * `inChunk` means a chain is open, so this record must be a continuation.
 */
function validateFlags(raw: RawRecord, index: number, inChunk: boolean): void {
  const { flags, record } = raw;
  const position = `record ${index}`;

  if (index === 0 && !flags.messageBegin) {
    throw ndefMalformed('First record does not carry the Message Begin flag.');
  }
  if (index > 0 && flags.messageBegin) {
    throw ndefMalformed(`${position} carries the Message Begin flag but is not the first record.`);
  }
  if (flags.chunked && flags.messageEnd) {
    throw ndefMalformed(
      `${position} sets both the Chunk Flag and Message End; a chunk chain cannot end a message.`,
    );
  }

  if (inChunk) {
    // Continuation records exist only to carry payload bytes.
    if (record.tnf !== Tnf.Unchanged) {
      throw ndefMalformed(
        `${position} continues a chunked record and must use TNF 0x06 (Unchanged), not 0x0${record.tnf}.`,
      );
    }
    if (record.type.length > 0) {
      throw ndefMalformed(`${position} continues a chunked record and must have an empty type.`);
    }
    if (flags.hasId) {
      throw ndefMalformed(`${position} continues a chunked record and must not carry an ID.`);
    }
    return;
  }

  if (record.tnf === Tnf.Unchanged) {
    throw ndefMalformed(
      `${position} uses TNF 0x06 (Unchanged) without an open chunked record to continue.`,
    );
  }
  if (record.tnf === Tnf.Empty && (record.type.length > 0 || record.payload.length > 0)) {
    throw ndefMalformed(`${position} uses TNF 0x00 (Empty) but carries a type or payload.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* -------------------------------------------------------------------------- */

export interface EncodeMessageOptions {
  /**
   * Forces every record to use the 4-byte payload length form.
   *
   * Only useful for exercising that path in tests; real writes should let the
   * encoder pick the short form, which is what every reader expects.
   */
  readonly forceLongRecords?: boolean;
}

/**
 * Encodes records into a complete NDEF message.
 *
 * An empty list encodes to the canonical empty message -- a single record with
 * TNF 0x00 -- which is what erasing a tag writes. Producing zero bytes instead
 * would leave whatever was previously on the tag partially readable.
 *
 * The encoder never emits chunked records. Chunking exists so a writer can
 * stream a payload whose length it does not yet know, which never applies when
 * the payload is already a `Uint8Array` in memory; emitting chunks would only
 * add bytes and risk tripping readers that mishandle `CF`. Chunked input is
 * still decoded, because other stacks do produce it.
 */
export function encodeMessage(
  records: NdefMessage,
  options: EncodeMessageOptions = {},
): Uint8Array {
  const forceLongRecord = options.forceLongRecords === true;

  if (records.length === 0) {
    const writer = new ByteWriter(3);
    encodeRecord(
      writer,
      {
        tnf: Tnf.Empty,
        type: new Uint8Array(0),
        id: new Uint8Array(0),
        payload: new Uint8Array(0),
      },
      { messageBegin: true, messageEnd: true },
    );
    return writer.toBytes();
  }

  const writer = new ByteWriter(encodedMessageLength(records, forceLongRecord));

  records.forEach((record, index) => {
    encodeRecord(writer, record, {
      messageBegin: index === 0,
      messageEnd: index === records.length - 1,
      forceLongRecord,
    });
  });

  return writer.toBytes();
}

/**
 * Byte length the encoded message will occupy.
 *
 * Used to check a message against a tag's usable NDEF capacity before starting a
 * write, so the failure is `ndefCapacityExceeded` up front instead of a partial
 * write that leaves the tag in an undefined state.
 */
export function encodedMessageLength(records: NdefMessage, forceLongRecords = false): number {
  if (records.length === 0) {
    return 3;
  }

  let total = 0;
  for (const record of records) {
    total += encodedRecordLength(record, forceLongRecords);
  }
  return total;
}
