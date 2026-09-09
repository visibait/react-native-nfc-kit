import { NfcError } from '../../errors';
import {
  ByteReader,
  ByteWriter,
  EMPTY_BYTES,
  bytesEqual,
  concatBytes,
  fromHex,
  toBytes,
  toHex,
  utf16Decode,
  utf16Encode,
  utf8Decode,
  utf8Encode,
} from '../bytes';

/** Asserts that `run` throws an `NfcError` carrying `code`. */
function expectNfcError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(NfcError.is(error)).toBe(true);
    expect((error as NfcError).code).toBe(code);
    return;
  }
  throw new Error(`Expected an NfcError with code "${code}" but nothing was thrown.`);
}

describe('EMPTY_BYTES', () => {
  it('is a zero-length Uint8Array', () => {
    expect(EMPTY_BYTES).toBeInstanceOf(Uint8Array);
    expect(EMPTY_BYTES).toHaveLength(0);
  });
});

describe('toBytes', () => {
  it('returns a Uint8Array unchanged, without copying', () => {
    const input = new Uint8Array([1, 2, 3]);
    expect(toBytes(input)).toBe(input);
  });

  it('wraps an ArrayBuffer', () => {
    const buffer = new Uint8Array([4, 5, 6]).buffer;
    expect(Array.from(toBytes(buffer))).toEqual([4, 5, 6]);
  });

  it('converts a number array', () => {
    expect(Array.from(toBytes([0, 127, 255]))).toEqual([0, 127, 255]);
  });

  it('accepts an empty array', () => {
    expect(toBytes([])).toHaveLength(0);
  });

  it.each([
    ['negative', [-1]],
    ['above 255', [256]],
    ['fractional', [1.5]],
    ['not a number', [Number.NaN]],
  ])('rejects a %s value rather than truncating it', (_label, input) => {
    expectNfcError(() => toBytes(input as readonly number[]), 'invalidArgument');
  });

  it('rejects a sparse array hole', () => {
    expectNfcError(() => toBytes([1, , 3] as unknown as readonly number[]), 'invalidArgument');
  });
});

describe('concatBytes', () => {
  it('returns an empty array when given nothing', () => {
    expect(concatBytes()).toHaveLength(0);
  });

  it('joins several parts in order', () => {
    const joined = concatBytes(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3]));
    expect(Array.from(joined)).toEqual([1, 2, 3]);
  });
});

describe('bytesEqual', () => {
  it('is true for the same reference', () => {
    const bytes = new Uint8Array([1]);
    expect(bytesEqual(bytes, bytes)).toBe(true);
  });

  it('is true for equal contents', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  });

  it('is false for different lengths', () => {
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('is false when a byte differs', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
  });
});

describe('toHex', () => {
  it('encodes an empty array as an empty string', () => {
    expect(toHex(EMPTY_BYTES)).toBe('');
  });

  it('encodes lowercase without a separator', () => {
    expect(toHex(new Uint8Array([0x04, 0xab, 0xff, 0x00]))).toBe('04abff00');
  });

  it('applies a separator between bytes but not before the first', () => {
    expect(toHex(new Uint8Array([0x04, 0xab]), ':')).toBe('04:ab');
  });
});

describe('fromHex', () => {
  it('parses an empty string', () => {
    expect(fromHex('')).toHaveLength(0);
  });

  it('parses plain hex, case-insensitively', () => {
    expect(Array.from(fromHex('04AbFf'))).toEqual([0x04, 0xab, 0xff]);
  });

  it.each([':', ' ', '-'])('tolerates "%s" as a separator', (separator) => {
    expect(Array.from(fromHex(`04${separator}ab`))).toEqual([0x04, 0xab]);
  });

  it('rejects an odd number of digits', () => {
    expectNfcError(() => fromHex('abc'), 'invalidArgument');
  });

  it('rejects a non-hexadecimal character', () => {
    expectNfcError(() => fromHex('zz'), 'invalidArgument');
  });

  it('round-trips with toHex', () => {
    const original = new Uint8Array([0, 1, 15, 16, 128, 255]);
    expect(bytesEqual(fromHex(toHex(original)), original)).toBe(true);
  });
});

describe('utf8', () => {
  it.each([
    ['ASCII', 'Hello, world', [0x48]],
    ['two-byte', 'é', [0xc3, 0xa9]],
    ['three-byte', '€', [0xe2, 0x82, 0xac]],
    ['four-byte astral', '\u{1F4B3}', [0xf0, 0x9f, 0x92, 0xb3]],
  ])('encodes %s correctly', (_label, text, expectedPrefix) => {
    const encoded = utf8Encode(text);
    expect(Array.from(encoded.subarray(0, expectedPrefix.length))).toEqual(expectedPrefix);
    expect(utf8Decode(encoded)).toBe(text);
  });

  it('encodes an empty string to no bytes', () => {
    expect(utf8Encode('')).toHaveLength(0);
    expect(utf8Decode(EMPTY_BYTES)).toBe('');
  });

  it('round-trips a mixed string with every sequence length', () => {
    const text = 'aé€\u{1F600}z';
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });

  it('round-trips a payload large enough to need chunked string building', () => {
    // The decoder assembles the result in 4096-code-point chunks, because
    // String.fromCodePoint(...array) exceeds the argument limit on real tags.
    const text = 'x'.repeat(10_000);
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });

  it.each([
    ['an invalid lead byte', [0xf8]],
    ['a continuation byte used as a lead', [0x80]],
    ['a truncated two-byte sequence', [0xc2]],
    ['a truncated three-byte sequence', [0xe2, 0x82]],
    ['an invalid continuation byte', [0xc2, 0x41]],
    ['an overlong encoding of U+0000', [0xc0, 0x80]],
    ['an overlong three-byte encoding', [0xe0, 0x80, 0x80]],
    ['an overlong four-byte encoding', [0xf0, 0x80, 0x80, 0x80]],
    ['an encoded surrogate', [0xed, 0xa0, 0x80]],
    ['a code point above U+10FFFF', [0xf7, 0xbf, 0xbf, 0xbf]],
  ])('rejects %s as malformed', (_label, input) => {
    expectNfcError(() => utf8Decode(new Uint8Array(input)), 'ndefMalformed');
  });
});

describe('utf16', () => {
  it('decodes big-endian with a BOM', () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
    expect(utf16Decode(bytes)).toBe('hi');
  });

  it('decodes little-endian with a BOM', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    expect(utf16Decode(bytes)).toBe('hi');
  });

  it('falls back to big-endian when there is no BOM', () => {
    expect(utf16Decode(new Uint8Array([0x00, 0x68]))).toBe('h');
  });

  it('honours the little-endian default when there is no BOM', () => {
    expect(utf16Decode(new Uint8Array([0x68, 0x00]), true)).toBe('h');
  });

  it('decodes an empty payload', () => {
    expect(utf16Decode(EMPTY_BYTES)).toBe('');
  });

  it('decodes a single byte pair that is not a BOM', () => {
    expect(utf16Decode(new Uint8Array([0x00, 0x41]))).toBe('A');
  });

  it('rejects an odd byte length', () => {
    expectNfcError(() => utf16Decode(new Uint8Array([0x00])), 'ndefMalformed');
  });

  it('encodes big-endian with a BOM by default', () => {
    expect(Array.from(utf16Encode('hi'))).toEqual([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
  });

  it('encodes little-endian with a BOM when asked', () => {
    expect(Array.from(utf16Encode('hi', true))).toEqual([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
  });

  it.each([false, true])('round-trips (littleEndian=%s)', (littleEndian) => {
    const text = 'Café 中文';
    expect(utf16Decode(utf16Encode(text, littleEndian))).toBe(text);
  });
});

describe('ByteReader', () => {
  it('tracks position, remaining and exhaustion', () => {
    const reader = new ByteReader(new Uint8Array([1, 2]));
    expect(reader.position).toBe(0);
    expect(reader.remaining).toBe(2);
    expect(reader.exhausted).toBe(false);

    reader.u8();
    expect(reader.position).toBe(1);
    expect(reader.remaining).toBe(1);
    expect(reader.exhausted).toBe(false);

    reader.u8();
    expect(reader.exhausted).toBe(true);
  });

  it('reads a big-endian u32 as unsigned', () => {
    const reader = new ByteReader(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    expect(reader.u32be()).toBe(0xffffffff);
  });

  it('returns a view from bytes() and a copy from copy()', () => {
    const source = new Uint8Array([1, 2, 3, 4]);

    const view = new ByteReader(source).bytes(2);
    expect(Array.from(view)).toEqual([1, 2]);
    view[0] = 99;
    expect(source[0]).toBe(99);

    source[0] = 1;
    const copied = new ByteReader(source).copy(2);
    copied[0] = 42;
    expect(source[0]).toBe(1);
  });

  it('reads zero bytes without moving', () => {
    const reader = new ByteReader(new Uint8Array([1]));
    expect(reader.bytes(0)).toHaveLength(0);
    expect(reader.position).toBe(0);
  });

  it('reports the offset when u8 runs past the end', () => {
    const reader = new ByteReader(EMPTY_BYTES);
    try {
      reader.u8('TNF byte');
      throw new Error('should have thrown');
    } catch (error) {
      expect(NfcError.is(error, 'ndefMalformed')).toBe(true);
      expect((error as NfcError).message).toContain('TNF byte');
      expect((error as NfcError).message).toContain('offset 0');
    }
  });

  it('reports how many bytes remain when bytes() runs past the end', () => {
    const reader = new ByteReader(new Uint8Array([1, 2]));
    try {
      reader.bytes(5, 'record payload');
      throw new Error('should have thrown');
    } catch (error) {
      expect(NfcError.is(error, 'ndefMalformed')).toBe(true);
      expect((error as NfcError).message).toContain('record payload');
      expect((error as NfcError).message).toContain('2 byte(s) remain');
    }
  });

  it('rejects a u32be that runs past the end', () => {
    expectNfcError(() => new ByteReader(new Uint8Array([1, 2])).u32be(), 'ndefMalformed');
  });

  it.each([-1, 1.5])('rejects a length of %s as a caller bug', (length) => {
    expectNfcError(() => new ByteReader(new Uint8Array([1])).bytes(length), 'invalidArgument');
  });
});

describe('ByteWriter', () => {
  it('starts empty', () => {
    const writer = new ByteWriter();
    expect(writer.size).toBe(0);
    expect(writer.toBytes()).toHaveLength(0);
  });

  it('writes bytes, u32be values and slices, and reports size', () => {
    const writer = new ByteWriter(4);
    writer
      .u8(0xd1)
      .u32be(0x01020304)
      .bytes(new Uint8Array([0xaa, 0xbb]));

    expect(writer.size).toBe(7);
    expect(Array.from(writer.toBytes())).toEqual([0xd1, 0x01, 0x02, 0x03, 0x04, 0xaa, 0xbb]);
  });

  it('masks a value wider than a byte', () => {
    expect(Array.from(new ByteWriter().u8(0x1ff).toBytes())).toEqual([0xff]);
  });

  it('grows past its initial capacity', () => {
    // A capacity of 1 forces several doublings, which is the path that matters:
    // an NDEF message is assembled without knowing its final size up front.
    const writer = new ByteWriter(1);
    for (let i = 0; i < 300; i += 1) {
      writer.u8(i & 0xff);
    }
    expect(writer.size).toBe(300);
    expect(writer.toBytes()[299]).toBe(299 & 0xff);
  });

  it('grows enough for a single write larger than one doubling', () => {
    const writer = new ByteWriter(1);
    writer.bytes(new Uint8Array(1000).fill(7));
    expect(writer.size).toBe(1000);
    expect(writer.toBytes()[999]).toBe(7);
  });

  it('returns an independent copy from toBytes', () => {
    const writer = new ByteWriter();
    writer.u8(1);
    const first = writer.toBytes();
    writer.u8(2);
    expect(Array.from(first)).toEqual([1]);
  });

  it('treats a zero initial capacity as at least one byte', () => {
    expect(Array.from(new ByteWriter(0).u8(9).toBytes())).toEqual([9]);
  });
});
