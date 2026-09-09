/**
 * TLV framing used by NFC Forum Type 2 tags (NTAG, MIFARE Ultralight) and by
 * MIFARE Classic tags formatted for NDEF.
 *
 * On those tags the NDEF message is not stored bare: it sits inside a
 * tag-length-value block, alongside lock and memory control blocks the tag
 * manufacturer wrote at format time. Reading a Type 2 tag's data area and
 * feeding it straight to the NDEF message decoder therefore fails -- the first
 * byte is a TLV tag, not a record header.
 *
 * Most higher-level NFC APIs hide this, which is why it is easy not to know it
 * exists until you talk to a tag with raw commands.
 *
 * ```
 * +-----+------------------+------------------+
 * | T   | L                | V                |
 * | 1 B | 1 B, or 0xFF + 2 | L bytes          |
 * +-----+------------------+------------------+
 * ```
 *
 * The NULL (0x00) and Terminator (0xFE) tags are single bytes with no length or
 * value at all.
 */

import { ByteReader, ByteWriter } from './bytes';
import { invalidArgument, ndefMalformed } from '../errors';

export const TlvTag = {
  /** Padding. Skipped wherever it appears. */
  Null: 0x00,
  /** Lock Control: describes where the tag's dynamic lock bytes live. */
  LockControl: 0x01,
  /** Memory Control: marks a reserved memory area. */
  MemoryControl: 0x02,
  /** NDEF Message: the block that actually holds an NDEF message. */
  NdefMessage: 0x03,
  /** Proprietary, vendor defined. */
  Proprietary: 0xfd,
  /** Terminator: nothing after this point is data. */
  Terminator: 0xfe,
} as const;

export type TlvTag = (typeof TlvTag)[keyof typeof TlvTag];

/** Largest length the 3-byte form can express (0xFFFF is reserved). */
export const MAX_TLV_LENGTH = 0xfffe;

/** A length of exactly this value selects the 3-byte length form. */
const LONG_LENGTH_MARKER = 0xff;

/** Below this, the length fits in the single byte. */
const SHORT_LENGTH_LIMIT = 0xff;

export interface Tlv {
  readonly tag: number;
  readonly value: Uint8Array;
}

/**
 * Parses a Type 2 data area into TLV blocks.
 *
 * Stops at the first Terminator TLV and ignores everything after it, which is
 * what the specification requires: the bytes past the terminator are unwritten
 * tag memory and usually all `0x00`.
 *
 * Running out of bytes with no terminator is not an error. A tag whose data area
 * is exactly full has no room for one, and rejecting that would make a perfectly
 * valid tag unreadable.
 */
export function decodeTlvs(bytes: Uint8Array): Tlv[] {
  const reader = new ByteReader(bytes);
  const blocks: Tlv[] = [];

  while (!reader.exhausted) {
    const tag = reader.u8('TLV tag');

    if (tag === TlvTag.Null) {
      continue;
    }
    if (tag === TlvTag.Terminator) {
      break;
    }

    let length = reader.u8('TLV length');
    if (length === LONG_LENGTH_MARKER) {
      length = reader.u16be('TLV length');

      // The specification reserves 0xFFFF, and a 3-byte form encoding a length
      // that would have fit in one byte indicates a writer bug worth surfacing.
      if (length > MAX_TLV_LENGTH) {
        throw ndefMalformed(`TLV length 0x${length.toString(16)} is reserved.`);
      }
      if (length < SHORT_LENGTH_LIMIT) {
        throw ndefMalformed(
          `TLV uses the 3-byte length form for ${length} byte(s), which must use the 1-byte form.`,
        );
      }
    }

    blocks.push({ tag, value: reader.copy(length, `TLV 0x${tag.toString(16)} value`) });
  }

  return blocks;
}

/**
 * Extracts the NDEF message bytes from a Type 2 data area.
 *
 * Returns `undefined` when the tag is formatted but holds no NDEF message TLV,
 * which is different from holding an empty one -- the caller may want to write
 * rather than report a read failure.
 */
export function findNdefMessageTlv(bytes: Uint8Array): Uint8Array | undefined {
  for (const block of decodeTlvs(bytes)) {
    if (block.tag === TlvTag.NdefMessage) {
      return block.value;
    }
  }
  return undefined;
}

export interface EncodeNdefTlvOptions {
  /**
   * Appends a Terminator TLV after the message. Defaults to `true`.
   *
   * Set it to `false` only when the message fills the data area exactly and
   * there is no byte left for the terminator.
   */
  terminator?: boolean;
}

/**
 * Wraps an encoded NDEF message in an NDEF Message TLV, ready to write to a
 * Type 2 data area.
 */
export function encodeNdefTlv(message: Uint8Array, options: EncodeNdefTlvOptions = {}): Uint8Array {
  if (message.length > MAX_TLV_LENGTH) {
    throw invalidArgument(
      `NDEF message is ${message.length} bytes; a TLV can hold at most ${MAX_TLV_LENGTH}.`,
    );
  }

  const useLongForm = message.length >= SHORT_LENGTH_LIMIT;
  const writer = new ByteWriter(message.length + (useLongForm ? 4 : 2) + 1);

  writer.u8(TlvTag.NdefMessage);
  if (useLongForm) {
    writer.u8(LONG_LENGTH_MARKER).u16be(message.length);
  } else {
    writer.u8(message.length);
  }
  writer.bytes(message);

  if (options.terminator !== false) {
    writer.u8(TlvTag.Terminator);
  }

  return writer.toBytes();
}
