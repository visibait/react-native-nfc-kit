import { NfcError } from '../../errors';
import { decodeMessage, encodeMessage, encodedMessageLength } from '../message';
import { Tnf, createRecord } from '../record';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function expectMalformed(input: Uint8Array, messagePart: string): void {
  try {
    decodeMessage(input);
  } catch (error) {
    expect(NfcError.is(error, 'ndefMalformed')).toBe(true);
    expect((error as NfcError).message).toContain(messagePart);
    return;
  }
  throw new Error(`Expected decodeMessage to reject, but it returned a value.`);
}

/**
 * Header nibbles used throughout, spelled out once:
 *
 *   MB 0x80   ME 0x40   CF 0x20   SR 0x10   IL 0x08
 *
 *   0xd1 = MB|ME|SR|WellKnown      a lone short record
 *   0x91 = MB|SR|WellKnown         first of several
 *   0x51 = ME|SR|WellKnown         last of several
 *   0xb1 = MB|CF|SR|WellKnown      opens a chunk chain
 *   0x36 = CF|SR|Unchanged         middle chunk
 *   0x56 = ME|SR|Unchanged         final chunk
 */

describe('decodeMessage', () => {
  it('decodes zero bytes as an empty message, not as corruption', () => {
    // A formatted but never-written tag reads back as nothing at all. Treating
    // that as malformed would make every blank tag look broken.
    expect(decodeMessage(bytes())).toEqual([]);
  });

  it('decodes a single record', () => {
    const records = decodeMessage(bytes(0xd1, 0x01, 0x03, 0x54, 1, 2, 3));

    expect(records).toHaveLength(1);
    expect(records[0]!.tnf).toBe(Tnf.WellKnown);
    expect(Array.from(records[0]!.payload)).toEqual([1, 2, 3]);
  });

  it('decodes the canonical empty record', () => {
    const records = decodeMessage(bytes(0xd0, 0x00, 0x00));

    expect(records).toHaveLength(1);
    expect(records[0]!.tnf).toBe(Tnf.Empty);
    expect(records[0]!.payload).toHaveLength(0);
  });

  it('decodes several records in order', () => {
    const records = decodeMessage(bytes(0x91, 0x01, 0x01, 0x54, 1, 0x51, 0x01, 0x01, 0x55, 2));

    expect(records).toHaveLength(2);
    expect(Array.from(records[0]!.type)).toEqual([0x54]);
    expect(Array.from(records[1]!.type)).toEqual([0x55]);
    expect(Array.from(records[1]!.payload)).toEqual([2]);
  });

  describe('chunked records', () => {
    it('reassembles a two-chunk payload and takes type and ID from the head', () => {
      const input = bytes(
        0xb1,
        0x01,
        0x02,
        0x54,
        0xaa,
        0xbb, // head: CF set, type 'T', payload AA BB
        0x56,
        0x00,
        0x02,
        0xcc,
        0xdd, // final chunk: Unchanged, CF clear
      );

      const records = decodeMessage(input);

      expect(records).toHaveLength(1);
      expect(records[0]!.tnf).toBe(Tnf.WellKnown);
      expect(Array.from(records[0]!.type)).toEqual([0x54]);
      expect(Array.from(records[0]!.payload)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    });

    it('reassembles a three-chunk payload', () => {
      const input = bytes(
        0xb1,
        0x01,
        0x01,
        0x54,
        0xaa,
        0x36,
        0x00,
        0x01,
        0xbb,
        0x56,
        0x00,
        0x01,
        0xcc,
      );

      expect(Array.from(decodeMessage(input)[0]!.payload)).toEqual([0xaa, 0xbb, 0xcc]);
    });

    it('carries the head record ID through reassembly', () => {
      const input = bytes(
        0xb9,
        0x01,
        0x01,
        0x01,
        0x54,
        0x07,
        0xaa, // head with IL: id 0x07
        0x56,
        0x00,
        0x01,
        0xbb,
      );

      const records = decodeMessage(input);
      expect(Array.from(records[0]!.id)).toEqual([0x07]);
      expect(Array.from(records[0]!.payload)).toEqual([0xaa, 0xbb]);
    });

    it('reassembles a chunk chain followed by an ordinary record', () => {
      const input = bytes(
        0xb1,
        0x01,
        0x01,
        0x54,
        0xaa,
        0x16,
        0x00,
        0x01,
        0xbb, // final chunk, no ME: the message continues
        0x51,
        0x01,
        0x01,
        0x55,
        0x02,
      );

      const records = decodeMessage(input);
      expect(records).toHaveLength(2);
      expect(Array.from(records[0]!.payload)).toEqual([0xaa, 0xbb]);
      expect(Array.from(records[1]!.type)).toEqual([0x55]);
    });

    it('handles a chunk with a zero-length payload', () => {
      const input = bytes(0xb1, 0x01, 0x00, 0x54, 0x56, 0x00, 0x01, 0xaa);
      expect(Array.from(decodeMessage(input)[0]!.payload)).toEqual([0xaa]);
    });

    it('rejects a message that ends mid-chain', () => {
      expectMalformed(bytes(0xb1, 0x01, 0x01, 0x54, 0xaa), 'ends inside a chunked record');
    });

    it('rejects a continuation that is not TNF Unchanged', () => {
      expectMalformed(
        bytes(0xb1, 0x01, 0x01, 0x54, 0xaa, 0x51, 0x01, 0x01, 0x55, 0x02),
        'must use TNF 0x06',
      );
    });

    it('rejects a continuation carrying a type', () => {
      expectMalformed(
        bytes(0xb1, 0x01, 0x01, 0x54, 0xaa, 0x56, 0x01, 0x01, 0x55, 0xbb),
        'must have an empty type',
      );
    });

    it('rejects a continuation carrying an ID', () => {
      expectMalformed(
        bytes(0xb1, 0x01, 0x01, 0x54, 0xaa, 0x5e, 0x00, 0x01, 0x01, 0x99, 0xbb),
        'must not carry an ID',
      );
    });

    it('rejects TNF Unchanged with no chain open', () => {
      expectMalformed(bytes(0xd6, 0x00, 0x01, 0xaa), 'without an open chunked record');
    });

    it('rejects a record setting both the Chunk Flag and Message End', () => {
      // 0xf1 = MB|ME|CF|SR|WellKnown. MB must be present or the first-record
      // check fires first and masks the combination under test.
      expectMalformed(bytes(0xf1, 0x01, 0x01, 0x54, 0xaa), 'cannot end a message');
    });
  });

  describe('message framing', () => {
    it('rejects a first record without Message Begin', () => {
      expectMalformed(bytes(0x51, 0x01, 0x01, 0x54, 1), 'does not carry the Message Begin flag');
    });

    it('rejects Message Begin on a later record', () => {
      expectMalformed(
        bytes(0x91, 0x01, 0x01, 0x54, 1, 0xd1, 0x01, 0x01, 0x55, 2),
        'is not the first record',
      );
    });

    it('rejects a message with no Message End', () => {
      expectMalformed(bytes(0x91, 0x01, 0x01, 0x54, 1), 'no record carrying the Message End flag');
    });

    it('rejects trailing bytes after Message End', () => {
      expectMalformed(bytes(0xd1, 0x01, 0x01, 0x54, 1, 0xff), 'trailing byte(s)');
    });

    it('rejects an Empty record carrying a payload', () => {
      expectMalformed(bytes(0xd0, 0x00, 0x01, 0xaa), 'carries a type or payload');
    });

    it('rejects an Empty record carrying a type', () => {
      expectMalformed(bytes(0xd0, 0x01, 0x00, 0x54), 'carries a type or payload');
    });
  });
});

describe('encodeMessage', () => {
  it('encodes an empty list as the canonical empty message', () => {
    // This is what erasing a tag writes. Emitting zero bytes instead would leave
    // whatever was there before partially readable.
    expect(Array.from(encodeMessage([]))).toEqual([0xd0, 0x00, 0x00]);
  });

  it('sets both MB and ME on a lone record', () => {
    const message = encodeMessage([
      createRecord({ tnf: Tnf.WellKnown, type: bytes(0x54), payload: bytes(1, 2, 3) }),
    ]);

    expect(Array.from(message)).toEqual([0xd1, 0x01, 0x03, 0x54, 1, 2, 3]);
  });

  it('sets MB on the first and ME on the last of several', () => {
    const message = encodeMessage([
      createRecord({ tnf: Tnf.WellKnown, type: bytes(0x54), payload: bytes(1) }),
      createRecord({ tnf: Tnf.WellKnown, type: bytes(0x55), payload: bytes(2) }),
      createRecord({ tnf: Tnf.WellKnown, type: bytes(0x56), payload: bytes(3) }),
    ]);

    expect(message[0]).toBe(0x91); // MB, no ME
    expect(message[5]).toBe(0x11); // neither
    expect(message[10]).toBe(0x51); // ME, no MB
  });

  it('forces the long form for every record when asked', () => {
    const message = encodeMessage(
      [createRecord({ tnf: Tnf.WellKnown, type: bytes(0x54), payload: bytes(1) })],
      { forceLongRecords: true },
    );

    expect(Array.from(message)).toEqual([0xc1, 0x01, 0x00, 0x00, 0x00, 0x01, 0x54, 1]);
  });

  it('never emits the Chunk Flag', () => {
    // Chunking exists to stream a payload of unknown length, which never applies
    // when the payload is already in memory.
    const message = encodeMessage([
      createRecord({ tnf: Tnf.MimeMedia, type: bytes(0x41), payload: new Uint8Array(5000) }),
    ]);

    expect(message[0]! & 0x20).toBe(0);
  });
});

describe('round trips', () => {
  const cases = [
    ['empty message', []],
    ['single empty record', [createRecord({ tnf: Tnf.Empty })]],
    [
      'well-known record',
      [createRecord({ tnf: Tnf.WellKnown, type: bytes(0x54), payload: bytes(1, 2, 3) })],
    ],
    [
      'record with an ID',
      [
        createRecord({
          tnf: Tnf.MimeMedia,
          type: bytes(0x41, 0x42),
          id: bytes(0x09),
          payload: bytes(7),
        }),
      ],
    ],
    [
      'long payload past the short-record boundary',
      [
        createRecord({
          tnf: Tnf.ExternalType,
          type: bytes(0x61),
          payload: new Uint8Array(600).fill(3),
        }),
      ],
    ],
    [
      'several records',
      [
        createRecord({ tnf: Tnf.WellKnown, type: bytes(0x55), payload: bytes(1) }),
        createRecord({ tnf: Tnf.Unknown, payload: bytes(2, 3) }),
        createRecord({ tnf: Tnf.Reserved, type: bytes(0x7f), payload: bytes(4) }),
      ],
    ],
  ] as const;

  it.each(cases)('survives encode then decode: %s', (_label, records) => {
    const decoded = decodeMessage(encodeMessage(records));

    if (records.length === 0) {
      // The empty list encodes to one Empty record, which is what comes back.
      expect(decoded).toHaveLength(1);
      expect(decoded[0]!.tnf).toBe(Tnf.Empty);
      return;
    }

    expect(decoded).toHaveLength(records.length);
    decoded.forEach((record, index) => {
      const original = records[index]!;
      expect(record.tnf).toBe(original.tnf);
      expect(Array.from(record.type)).toEqual(Array.from(original.type));
      expect(Array.from(record.id)).toEqual(Array.from(original.id));
      expect(Array.from(record.payload)).toEqual(Array.from(original.payload));
    });
  });

  it.each(cases)('survives the forced long form too: %s', (_label, records) => {
    const decoded = decodeMessage(encodeMessage(records, { forceLongRecords: true }));
    expect(decoded).toHaveLength(Math.max(1, records.length));
  });
});

describe('encodedMessageLength', () => {
  it('reports three bytes for an empty message', () => {
    expect(encodedMessageLength([])).toBe(3);
  });

  it('agrees with the encoder for every case', () => {
    const records = [
      createRecord({ tnf: Tnf.WellKnown, type: bytes(0x54), payload: bytes(1, 2, 3) }),
      createRecord({ tnf: Tnf.MimeMedia, type: bytes(0x41), id: bytes(9), payload: bytes(1) }),
      createRecord({ tnf: Tnf.ExternalType, type: bytes(1), payload: new Uint8Array(400) }),
    ];

    expect(encodedMessageLength(records)).toBe(encodeMessage(records).length);
    expect(encodedMessageLength(records, true)).toBe(
      encodeMessage(records, { forceLongRecords: true }).length,
    );
  });
});
