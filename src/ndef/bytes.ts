/**
 * Byte primitives for the NDEF codec.
 *
 * Two deliberate choices here:
 *
 * 1. **UTF-8 and UTF-16 are implemented by hand** rather than delegating to
 *    `TextEncoder`/`TextDecoder`. Those globals exist in Node and browsers, and
 *    in recent Hermes, but "recent" is doing a lot of work in that sentence: a
 *    library that silently needs a polyfill on some engines is a library that
 *    fails in someone's production app. These are a few dozen lines and fully
 *    covered by tests, so the certainty is cheap.
 * 2. **Reads are bounds-checked and raise `ndefMalformed`.** A truncated tag read
 *    is a completely normal event -- the user moved their card -- and it must
 *    surface as a typed error, never as `undefined` propagating into arithmetic
 *    and producing `NaN` two functions later.
 */

import { invalidArgument, ndefMalformed } from '../errors';

/** A `Uint8Array` of length 0, shared to avoid pointless allocation. */
export const EMPTY_BYTES: Uint8Array = new Uint8Array(0);

/* -------------------------------------------------------------------------- */
/* Construction and comparison                                                */
/* -------------------------------------------------------------------------- */

/**
 * Accepts the shapes callers realistically have and normalises to `Uint8Array`.
 *
 * `number[]` is supported because that is what the previous generation of NFC
 * libraries returned, so migrating code has arrays lying around. Values are
 * range-checked rather than silently truncated by `Uint8Array.from`.
 */
export function toBytes(input: Uint8Array | ArrayBuffer | readonly number[]): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const value = input[i];
    if (value === undefined || !Number.isInteger(value) || value < 0 || value > 0xff) {
      throw invalidArgument(
        `Byte at index ${i} is ${String(value)}; expected an integer in 0..255.`,
      );
    }
    out[i] = value;
  }
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Hex                                                                        */
/* -------------------------------------------------------------------------- */

const HEX_DIGITS = '0123456789abcdef';

/**
 * Lowercase hex. `separator` is for human-facing output such as a UID in a log
 * line; leave it empty for anything that will be parsed again.
 */
export function toHex(bytes: Uint8Array, separator = ''): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] as number;
    if (i > 0 && separator !== '') {
      out += separator;
    }
    out += HEX_DIGITS[byte >> 4];
    out += HEX_DIGITS[byte & 0x0f];
  }
  return out;
}

/**
 * Parses hex, tolerating spaces, colons and dashes as separators because that is
 * how AIDs and keys appear in datasheets and in people's notes.
 */
export function fromHex(hex: string): Uint8Array {
  const cleaned = hex.replace(/[\s:-]/g, '');
  if (cleaned.length % 2 !== 0) {
    throw invalidArgument(`Hex string has an odd number of digits (${cleaned.length}).`);
  }
  if (cleaned.length > 0 && !/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw invalidArgument('Hex string contains a non-hexadecimal character.');
  }

  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* UTF-8                                                                      */
/* -------------------------------------------------------------------------- */

export function utf8Encode(text: string): Uint8Array {
  // Worst case is 4 bytes per UTF-16 code unit; trimmed with subarray at the end.
  const buffer = new Uint8Array(text.length * 4);
  let length = 0;

  for (const character of text) {
    // Iterating a string yields whole code points, so surrogate pairs arrive
    // already combined and `codePointAt(0)` is always defined here.
    const code = character.codePointAt(0) as number;

    if (code < 0x80) {
      buffer[length] = code;
      length += 1;
    } else if (code < 0x800) {
      buffer[length] = 0xc0 | (code >> 6);
      buffer[length + 1] = 0x80 | (code & 0x3f);
      length += 2;
    } else if (code < 0x10000) {
      buffer[length] = 0xe0 | (code >> 12);
      buffer[length + 1] = 0x80 | ((code >> 6) & 0x3f);
      buffer[length + 2] = 0x80 | (code & 0x3f);
      length += 3;
    } else {
      buffer[length] = 0xf0 | (code >> 18);
      buffer[length + 1] = 0x80 | ((code >> 12) & 0x3f);
      buffer[length + 2] = 0x80 | ((code >> 6) & 0x3f);
      buffer[length + 3] = 0x80 | (code & 0x3f);
      length += 4;
    }
  }

  return buffer.subarray(0, length);
}

/**
 * Strict UTF-8 decode. Malformed input raises `ndefMalformed` rather than
 * yielding U+FFFD, because for tag data a replacement character is a silent
 * corruption the caller will not notice until much later.
 */
export function utf8Decode(bytes: Uint8Array): string {
  const codePoints: number[] = [];
  let i = 0;

  while (i < bytes.length) {
    const first = bytes[i] as number;
    let codePoint: number;
    let extraBytes: number;

    if (first < 0x80) {
      codePoint = first;
      extraBytes = 0;
    } else if ((first & 0xe0) === 0xc0) {
      codePoint = first & 0x1f;
      extraBytes = 1;
    } else if ((first & 0xf0) === 0xe0) {
      codePoint = first & 0x0f;
      extraBytes = 2;
    } else if ((first & 0xf8) === 0xf0) {
      codePoint = first & 0x07;
      extraBytes = 3;
    } else {
      throw ndefMalformed(`Invalid UTF-8 lead byte 0x${toHex(bytes.subarray(i, i + 1))} at ${i}.`);
    }

    if (i + extraBytes >= bytes.length) {
      throw ndefMalformed(`Truncated UTF-8 sequence at offset ${i}.`);
    }

    for (let k = 1; k <= extraBytes; k += 1) {
      const continuation = bytes[i + k] as number;
      if ((continuation & 0xc0) !== 0x80) {
        throw ndefMalformed(`Invalid UTF-8 continuation byte at offset ${i + k}.`);
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }

    // Reject overlong encodings, surrogates and out-of-range code points. An
    // overlong form is the classic way to smuggle a byte sequence past a naive
    // validator, so it is worth rejecting even here.
    const minimum =
      extraBytes === 0 ? 0 : extraBytes === 1 ? 0x80 : extraBytes === 2 ? 0x800 : 0x10000;
    if (codePoint < minimum) {
      throw ndefMalformed(`Overlong UTF-8 encoding at offset ${i}.`);
    }
    if (codePoint > 0x10ffff) {
      throw ndefMalformed(`UTF-8 code point out of range at offset ${i}.`);
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw ndefMalformed(`UTF-8 encoded surrogate at offset ${i}.`);
    }

    codePoints.push(codePoint);
    i += extraBytes + 1;
  }

  return codePointsToString(codePoints);
}

/* -------------------------------------------------------------------------- */
/* UTF-16                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Decodes UTF-16, which NDEF text records select via bit 7 of their status byte.
 *
 * A leading byte order mark decides endianness and is consumed. Without one,
 * `defaultLittleEndian` applies; the NFC Forum Text RTD does not mandate an
 * endianness, so real tags contain both and a BOM is the only reliable signal.
 */
export function utf16Decode(bytes: Uint8Array, defaultLittleEndian = false): string {
  if (bytes.length % 2 !== 0) {
    throw ndefMalformed(`UTF-16 payload has an odd byte length (${bytes.length}).`);
  }

  let offset = 0;
  let littleEndian = defaultLittleEndian;

  if (bytes.length >= 2) {
    const b0 = bytes[0] as number;
    const b1 = bytes[1] as number;
    if (b0 === 0xff && b1 === 0xfe) {
      littleEndian = true;
      offset = 2;
    } else if (b0 === 0xfe && b1 === 0xff) {
      littleEndian = false;
      offset = 2;
    }
  }

  const units: number[] = [];
  for (let i = offset; i < bytes.length; i += 2) {
    const lo = bytes[i] as number;
    const hi = bytes[i + 1] as number;
    units.push(littleEndian ? lo | (hi << 8) : (lo << 8) | hi);
  }

  return String.fromCharCode(...units);
}

/**
 * Encodes UTF-16 big-endian with a byte order mark.
 *
 * Big-endian with a BOM is the interoperable choice: readers that ignore the BOM
 * still get network byte order, and readers that honour it are unambiguous.
 */
export function utf16Encode(text: string, littleEndian = false): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);

  if (littleEndian) {
    out[0] = 0xff;
    out[1] = 0xfe;
  } else {
    out[0] = 0xfe;
    out[1] = 0xff;
  }

  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (littleEndian) {
      out[2 + i * 2] = unit & 0xff;
      out[3 + i * 2] = unit >> 8;
    } else {
      out[2 + i * 2] = unit >> 8;
      out[3 + i * 2] = unit & 0xff;
    }
  }

  return out;
}

/**
 * Builds a string from code points in chunks.
 *
 * `String.fromCodePoint(...array)` blows the argument limit on large payloads,
 * and an NDEF message can carry tens of kilobytes.
 */
function codePointsToString(codePoints: readonly number[]): string {
  const CHUNK = 4096;
  if (codePoints.length <= CHUNK) {
    return String.fromCodePoint(...codePoints);
  }

  let out = '';
  for (let i = 0; i < codePoints.length; i += CHUNK) {
    out += String.fromCodePoint(...codePoints.slice(i, i + CHUNK));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Reader and writer                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Sequential bounds-checked reader.
 *
 * Every overrun raises `ndefMalformed` naming the offset, which is the
 * difference between a bug report that says "invalid tag" and one that says
 * exactly which byte was missing.
 */
export class ByteReader {
  private offset = 0;

  constructor(private readonly source: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.source.length - this.offset;
  }

  get exhausted(): boolean {
    return this.offset >= this.source.length;
  }

  /** Reads one byte. */
  u8(what = 'byte'): number {
    if (this.offset >= this.source.length) {
      throw ndefMalformed(`Unexpected end of data reading ${what} at offset ${this.offset}.`);
    }
    const value = this.source[this.offset] as number;
    this.offset += 1;
    return value;
  }

  /** Reads a big-endian unsigned 16-bit integer. */
  u16be(what = 'length'): number {
    const high = this.u8(what);
    const low = this.u8(what);
    return (high << 8) | low;
  }

  /** Reads a big-endian unsigned 32-bit integer. */
  u32be(what = 'length'): number {
    const b0 = this.u8(what);
    const b1 = this.u8(what);
    const b2 = this.u8(what);
    const b3 = this.u8(what);
    // `>>> 0` keeps the result unsigned; a 4-byte NDEF length may exceed 2^31.
    return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  }

  /**
   * Reads `length` bytes as a view over the source, with no copy.
   *
   * The result aliases the caller's buffer. That is intentional and fast, but it
   * means anything retained beyond the decode must be copied -- see
   * {@link ByteReader.copy}.
   */
  bytes(length: number, what = 'payload'): Uint8Array {
    if (length < 0 || !Number.isInteger(length)) {
      throw invalidArgument(`Cannot read ${length} bytes.`);
    }
    if (this.offset + length > this.source.length) {
      throw ndefMalformed(
        `Unexpected end of data reading ${length}-byte ${what} at offset ${this.offset}; ` +
          `only ${this.remaining} byte(s) remain.`,
      );
    }
    const value = this.source.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  /** Like {@link ByteReader.bytes}, but returns an independent copy. */
  copy(length: number, what = 'payload'): Uint8Array {
    return new Uint8Array(this.bytes(length, what));
  }
}

/** Growable byte buffer. */
export class ByteWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(initialCapacity = 64) {
    this.buffer = new Uint8Array(Math.max(1, initialCapacity));
  }

  get size(): number {
    return this.length;
  }

  u8(value: number): this {
    this.ensure(1);
    this.buffer[this.length] = value & 0xff;
    this.length += 1;
    return this;
  }

  u16be(value: number): this {
    this.ensure(2);
    this.buffer[this.length] = (value >>> 8) & 0xff;
    this.buffer[this.length + 1] = value & 0xff;
    this.length += 2;
    return this;
  }

  u32be(value: number): this {
    this.ensure(4);
    this.buffer[this.length] = (value >>> 24) & 0xff;
    this.buffer[this.length + 1] = (value >>> 16) & 0xff;
    this.buffer[this.length + 2] = (value >>> 8) & 0xff;
    this.buffer[this.length + 3] = value & 0xff;
    this.length += 4;
    return this;
  }

  bytes(value: Uint8Array): this {
    this.ensure(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
    return this;
  }

  /** Returns an independent copy of everything written so far. */
  toBytes(): Uint8Array {
    return new Uint8Array(this.buffer.subarray(0, this.length));
  }

  private ensure(extra: number): void {
    const required = this.length + extra;
    if (required <= this.buffer.length) {
      return;
    }

    let capacity = this.buffer.length * 2;
    while (capacity < required) {
      capacity *= 2;
    }

    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }
}
