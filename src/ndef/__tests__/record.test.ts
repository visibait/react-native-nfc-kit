import { NfcError } from '../../errors.js';
import { ByteReader, ByteWriter } from '../bytes.js';
import {
  SHORT_RECORD_MAX_PAYLOAD,
  Tnf,
  createEmptyRecord,
  createRecord,
  decodeRecord,
  encodeRecord,
  encodedRecordLength,
  isTnf,
} from '../record.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function expectNfcError(run: () => unknown, code: string, messagePart?: string): void {
  try {
    run();
  } catch (error) {
    expect(NfcError.is(error, code as never)).toBe(true);
    if (messagePart !== undefined) {
      expect((error as NfcError).message).toContain(messagePart);
    }
    return;
  }
  throw new Error(`Expected an NfcError with code "${code}" but nothing was thrown.`);
}

describe('Tnf', () => {
  it('maps each name to its specification value', () => {
    expect(Tnf).toEqual({
      Empty: 0x00,
      WellKnown: 0x01,
      MimeMedia: 0x02,
      AbsoluteUri: 0x03,
      ExternalType: 0x04,
      Unknown: 0x05,
      Unchanged: 0x06,
      Reserved: 0x07,
    });
  });

  it('recognises every valid value and rejects the rest', () => {
    for (let value = 0; value <= 7; value += 1) {
      expect(isTnf(value)).toBe(true);
    }
    expect(isTnf(8)).toBe(false);
    expect(isTnf(-1)).toBe(false);
  });
});

describe('createRecord', () => {
  it('defaults type, id and payload to zero-length rather than undefined', () => {
    const record = createRecord({ tnf: Tnf.Unknown });

    expect(record.type).toHaveLength(0);
    expect(record.id).toHaveLength(0);
    expect(record.payload).toHaveLength(0);
  });

  it('keeps what it is given', () => {
    const record = createRecord({
      tnf: Tnf.WellKnown,
      type: bytes(0x54),
      id: bytes(0xaa),
      payload: bytes(1, 2),
    });

    expect(record.tnf).toBe(Tnf.WellKnown);
    expect(Array.from(record.type)).toEqual([0x54]);
    expect(Array.from(record.id)).toEqual([0xaa]);
    expect(Array.from(record.payload)).toEqual([1, 2]);
  });

  it('rejects a TNF outside 0..7', () => {
    expectNfcError(() => createRecord({ tnf: 9 as Tnf }), 'invalidArgument', 'Invalid TNF');
  });

  it.each([
    ['a type', { type: bytes(0x54) }],
    ['an ID', { id: bytes(0xaa) }],
    ['a payload', { payload: bytes(1) }],
  ])('rejects an Empty record carrying %s', (_label, extra) => {
    expectNfcError(
      () => createRecord({ tnf: Tnf.Empty, ...extra }),
      'invalidArgument',
      'Empty record',
    );
  });

  it('allows a genuinely empty Empty record', () => {
    expect(createRecord({ tnf: Tnf.Empty }).tnf).toBe(Tnf.Empty);
  });

  it('rejects an Unknown record with a type', () => {
    expectNfcError(
      () => createRecord({ tnf: Tnf.Unknown, type: bytes(0x54) }),
      'invalidArgument',
      'empty type',
    );
  });

  it('refuses to build an Unchanged record, which only the encoder may emit', () => {
    expectNfcError(() => createRecord({ tnf: Tnf.Unchanged }), 'invalidArgument', 'Unchanged');
  });

  it('rejects a type longer than 255 bytes', () => {
    expectNfcError(
      () => createRecord({ tnf: Tnf.ExternalType, type: new Uint8Array(256) }),
      'invalidArgument',
      'type is 256 bytes',
    );
  });

  it('rejects an ID longer than 255 bytes', () => {
    expectNfcError(
      () => createRecord({ tnf: Tnf.WellKnown, id: new Uint8Array(256) }),
      'invalidArgument',
      'ID is 256 bytes',
    );
  });

  it('accepts a type and ID of exactly 255 bytes', () => {
    const record = createRecord({
      tnf: Tnf.ExternalType,
      type: new Uint8Array(255),
      id: new Uint8Array(255),
    });
    expect(record.type).toHaveLength(255);
    expect(record.id).toHaveLength(255);
  });
});

describe('createEmptyRecord', () => {
  it('produces a record with TNF 0x00 and nothing else', () => {
    const record = createEmptyRecord();
    expect(record.tnf).toBe(Tnf.Empty);
    expect(record.type).toHaveLength(0);
    expect(record.id).toHaveLength(0);
    expect(record.payload).toHaveLength(0);
  });
});

describe('decodeRecord', () => {
  it('decodes a short record without an ID', () => {
    // D1 = MB | ME | SR | WellKnown
    const { record, flags } = decodeRecord(new ByteReader(bytes(0xd1, 0x01, 0x03, 0x54, 1, 2, 3)));

    expect(record.tnf).toBe(Tnf.WellKnown);
    expect(Array.from(record.type)).toEqual([0x54]);
    expect(record.id).toHaveLength(0);
    expect(Array.from(record.payload)).toEqual([1, 2, 3]);
    expect(flags).toEqual({
      messageBegin: true,
      messageEnd: true,
      chunked: false,
      shortRecord: true,
      hasId: false,
    });
  });

  it('decodes a short record with an ID', () => {
    // D9 adds the IL flag; field order is type length, payload length, ID length.
    const { record, flags } = decodeRecord(
      new ByteReader(bytes(0xd9, 0x01, 0x03, 0x02, 0x54, 0xaa, 0xbb, 1, 2, 3)),
    );

    expect(flags.hasId).toBe(true);
    expect(Array.from(record.id)).toEqual([0xaa, 0xbb]);
    expect(Array.from(record.payload)).toEqual([1, 2, 3]);
  });

  it('decodes a long record with a 4-byte payload length', () => {
    // C1 clears SR, so the payload length occupies four bytes.
    const { record, flags } = decodeRecord(
      new ByteReader(bytes(0xc1, 0x01, 0x00, 0x00, 0x00, 0x03, 0x54, 1, 2, 3)),
    );

    expect(flags.shortRecord).toBe(false);
    expect(Array.from(record.payload)).toEqual([1, 2, 3]);
  });

  it('reports the chunk flag without interpreting it', () => {
    // B1 = MB | CF | SR | WellKnown. Reassembly is the message layer's job.
    const { flags } = decodeRecord(new ByteReader(bytes(0xb1, 0x01, 0x01, 0x54, 0xaa)));
    expect(flags.chunked).toBe(true);
  });

  it('decodes a record with a zero-length payload', () => {
    const { record } = decodeRecord(new ByteReader(bytes(0xd1, 0x01, 0x00, 0x54)));
    expect(record.payload).toHaveLength(0);
  });

  it('decodes every TNF value including Reserved', () => {
    for (let tnf = 0; tnf <= 7; tnf += 1) {
      const header = 0xd0 | tnf;
      const { record } = decodeRecord(new ByteReader(bytes(header, 0x00, 0x00)));
      expect(record.tnf).toBe(tnf);
    }
  });

  it('returns copies, so the decoded record does not alias the source buffer', () => {
    const source = bytes(0xd1, 0x01, 0x01, 0x54, 0xaa);
    const { record } = decodeRecord(new ByteReader(source));

    source[4] = 0xff;
    expect(record.payload[0]).toBe(0xaa);
  });

  it('names the impossible length when the payload overruns the buffer', () => {
    expectNfcError(
      () => decodeRecord(new ByteReader(bytes(0xd1, 0x01, 0x05, 0x54, 1))),
      'ndefMalformed',
      'claims a 5-byte payload',
    );
  });

  it('blames the type field when the type is truncated', () => {
    expectNfcError(
      () => decodeRecord(new ByteReader(bytes(0xd1, 0x05, 0x00))),
      'ndefMalformed',
      'record type',
    );
  });

  it('blames the ID field when the ID is truncated', () => {
    expectNfcError(
      () => decodeRecord(new ByteReader(bytes(0xd9, 0x01, 0x01, 0x03, 0x54, 0xaa))),
      'ndefMalformed',
      'record ID',
    );
  });

  it('rejects a header with nothing after it', () => {
    expectNfcError(() => decodeRecord(new ByteReader(bytes(0xd1))), 'ndefMalformed', 'type length');
  });
});

describe('encodeRecord', () => {
  function encode(
    record: Parameters<typeof encodeRecord>[1],
    options: Parameters<typeof encodeRecord>[2],
  ): number[] {
    const writer = new ByteWriter();
    encodeRecord(writer, record, options);
    return Array.from(writer.toBytes());
  }

  it('chooses the short form and sets MB and ME for a lone record', () => {
    const record = createRecord({ tnf: Tnf.WellKnown, type: bytes(0x54), payload: bytes(1, 2, 3) });

    expect(encode(record, { messageBegin: true, messageEnd: true })).toEqual([
      0xd1, 0x01, 0x03, 0x54, 1, 2, 3,
    ]);
  });

  it('sets the IL flag and writes the ID length only when an ID is present', () => {
    const record = createRecord({
      tnf: Tnf.WellKnown,
      type: bytes(0x54),
      id: bytes(0xaa, 0xbb),
      payload: bytes(1),
    });

    expect(encode(record, { messageBegin: true, messageEnd: true })).toEqual([
      0xd9, 0x01, 0x01, 0x02, 0x54, 0xaa, 0xbb, 1,
    ]);
  });

  it('omits MB and ME for a middle record', () => {
    const record = createRecord({ tnf: Tnf.WellKnown, type: bytes(0x54) });
    expect(encode(record, { messageBegin: false, messageEnd: false })[0]).toBe(0x11);
  });

  it('uses the 4-byte length when forced', () => {
    const record = createRecord({ tnf: Tnf.WellKnown, type: bytes(0x54), payload: bytes(1) });

    expect(encode(record, { messageBegin: true, messageEnd: true, forceLongRecord: true })).toEqual(
      [0xc1, 0x01, 0x00, 0x00, 0x00, 0x01, 0x54, 1],
    );
  });

  it('uses the short form at exactly the 255-byte boundary', () => {
    const record = createRecord({
      tnf: Tnf.MimeMedia,
      type: bytes(0x41),
      payload: new Uint8Array(SHORT_RECORD_MAX_PAYLOAD),
    });
    const encoded = encode(record, { messageBegin: true, messageEnd: true });

    expect(encoded[0]! & 0x10).toBe(0x10);
    expect(encoded[2]).toBe(0xff);
  });

  it('switches to the long form one byte past the boundary', () => {
    const record = createRecord({
      tnf: Tnf.MimeMedia,
      type: bytes(0x41),
      payload: new Uint8Array(SHORT_RECORD_MAX_PAYLOAD + 1),
    });
    const encoded = encode(record, { messageBegin: true, messageEnd: true });

    expect(encoded[0]! & 0x10).toBe(0x00);
    expect(encoded.slice(2, 6)).toEqual([0x00, 0x00, 0x01, 0x00]);
  });

  it('round-trips through decodeRecord', () => {
    const original = createRecord({
      tnf: Tnf.ExternalType,
      type: bytes(0x61, 0x62),
      id: bytes(0x01),
      payload: new Uint8Array(1000).fill(7),
    });

    const writer = new ByteWriter();
    encodeRecord(writer, original, { messageBegin: true, messageEnd: true });
    const { record } = decodeRecord(new ByteReader(writer.toBytes()));

    expect(record.tnf).toBe(original.tnf);
    expect(Array.from(record.type)).toEqual(Array.from(original.type));
    expect(Array.from(record.id)).toEqual(Array.from(original.id));
    expect(record.payload).toHaveLength(1000);
  });
});

describe('encodedRecordLength', () => {
  it('accounts for the short length and no ID', () => {
    const record = createRecord({ tnf: Tnf.WellKnown, type: bytes(0x54), payload: bytes(1, 2, 3) });
    expect(encodedRecordLength(record)).toBe(7);
  });

  it('accounts for the ID length byte and the ID itself', () => {
    const record = createRecord({
      tnf: Tnf.WellKnown,
      type: bytes(0x54),
      id: bytes(0xaa, 0xbb),
      payload: bytes(1),
    });
    expect(encodedRecordLength(record)).toBe(8);
  });

  it('accounts for the 4-byte length when forced', () => {
    const record = createRecord({ tnf: Tnf.WellKnown, type: bytes(0x54), payload: bytes(1) });
    expect(encodedRecordLength(record, true)).toBe(8);
  });

  it('agrees with what encodeRecord actually writes', () => {
    const cases = [
      createRecord({ tnf: Tnf.Empty }),
      createRecord({ tnf: Tnf.WellKnown, type: bytes(0x55), payload: bytes(1, 2) }),
      createRecord({ tnf: Tnf.MimeMedia, type: bytes(0x41), id: bytes(9), payload: bytes(1) }),
      createRecord({ tnf: Tnf.ExternalType, type: bytes(1), payload: new Uint8Array(300) }),
    ];

    for (const record of cases) {
      for (const forceLongRecord of [false, true]) {
        const writer = new ByteWriter();
        encodeRecord(writer, record, { messageBegin: true, messageEnd: true, forceLongRecord });
        expect(encodedRecordLength(record, forceLongRecord)).toBe(writer.size);
      }
    }
  });
});
