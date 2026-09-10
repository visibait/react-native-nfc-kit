import { NfcError } from '../../errors.js';
import { toHex } from '../../ndef/bytes.js';
import {
  EXTENDED_MAX_LE,
  SHORT_MAX_LC,
  SHORT_MAX_LE,
  SW_SUCCESS,
  decodeResponseApdu,
  describeStatusWord,
  encodeCommandApdu,
  readBinary,
  selectByFileId,
  selectByName,
  sendApdu,
  sendApduChained,
  updateBinary,
  type ApduTransport,
  type CommandApdu,
} from '../iso7816.js';

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

/** A transport that replays scripted responses and records what it was sent. */
function scriptedTransport(...responses: Uint8Array[]): ApduTransport & { sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  let index = 0;

  const transport = (apdu: Uint8Array): Promise<Uint8Array> => {
    sent.push(apdu);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(response ?? bytes(0x90, 0x00));
  };

  return Object.assign(transport, { sent });
}

const SELECT: CommandApdu = { cla: 0x00, ins: 0xa4, p1: 0x04, p2: 0x00 };

describe('encodeCommandApdu', () => {
  it('encodes case 1: header only', () => {
    expect(Array.from(encodeCommandApdu(SELECT))).toEqual([0x00, 0xa4, 0x04, 0x00]);
  });

  it('encodes case 2: header plus Le', () => {
    expect(Array.from(encodeCommandApdu({ ...SELECT, le: 16 }))).toEqual([
      0x00, 0xa4, 0x04, 0x00, 0x10,
    ]);
  });

  it('encodes case 3: header plus Lc and data', () => {
    const apdu = encodeCommandApdu({ ...SELECT, data: bytes(0xa0, 0x00) });
    expect(Array.from(apdu)).toEqual([0x00, 0xa4, 0x04, 0x00, 0x02, 0xa0, 0x00]);
  });

  it('encodes case 4: header, Lc, data and Le', () => {
    const apdu = encodeCommandApdu({ ...SELECT, data: bytes(0xa0), le: 256 });
    expect(Array.from(apdu)).toEqual([0x00, 0xa4, 0x04, 0x00, 0x01, 0xa0, 0x00]);
  });

  it('encodes an Le of 256 as the byte 0x00', () => {
    // The reason this API counts bytes rather than mirroring the encoding: a
    // caller writing le: 0 would otherwise be asking for 256 without meaning to.
    expect(Array.from(encodeCommandApdu({ ...SELECT, le: SHORT_MAX_LE }))).toEqual([
      0x00, 0xa4, 0x04, 0x00, 0x00,
    ]);
  });

  it('uses the extended form when the data does not fit a short APDU', () => {
    const data = new Uint8Array(SHORT_MAX_LC + 1).fill(0x41);
    const apdu = encodeCommandApdu({ ...SELECT, data });

    expect(apdu[4]).toBe(0x00); // extended marker
    expect(apdu[5]).toBe(0x01); // length high byte
    expect(apdu[6]).toBe(0x00); // length low byte
    expect(apdu).toHaveLength(4 + 3 + data.length);
  });

  it('uses the extended form when Le exceeds the short maximum', () => {
    const apdu = encodeCommandApdu({ ...SELECT, le: 300 });
    expect(Array.from(apdu)).toEqual([0x00, 0xa4, 0x04, 0x00, 0x00, 0x01, 0x2c]);
  });

  it('encodes an extended Le of 65536 as two zero bytes', () => {
    const apdu = encodeCommandApdu({ ...SELECT, le: EXTENDED_MAX_LE });
    expect(Array.from(apdu.subarray(4))).toEqual([0x00, 0x00, 0x00]);
  });

  it('encodes extended data followed by extended Le', () => {
    const data = new Uint8Array(300).fill(7);
    const apdu = encodeCommandApdu({ ...SELECT, data, le: 512 });

    expect(Array.from(apdu.subarray(0, 7))).toEqual([0x00, 0xa4, 0x04, 0x00, 0x00, 0x01, 0x2c]);
    expect(Array.from(apdu.subarray(apdu.length - 2))).toEqual([0x02, 0x00]);
  });

  it('can be forced to the extended form for a small command', () => {
    const apdu = encodeCommandApdu({ ...SELECT, data: bytes(0xa0), le: 16 }, { extended: true });
    expect(Array.from(apdu)).toEqual([0x00, 0xa4, 0x04, 0x00, 0x00, 0x00, 0x01, 0xa0, 0x00, 0x10]);
  });

  it('forced extended with no data and no Le is still just a header', () => {
    expect(Array.from(encodeCommandApdu(SELECT, { extended: true }))).toEqual([
      0x00, 0xa4, 0x04, 0x00,
    ]);
  });

  it('forced extended with only Le writes the marker once', () => {
    expect(Array.from(encodeCommandApdu({ ...SELECT, le: 16 }, { extended: true }))).toEqual([
      0x00, 0xa4, 0x04, 0x00, 0x00, 0x00, 0x10,
    ]);
  });

  it.each([
    ['cla', { cla: 256 }],
    ['ins', { ins: -1 }],
    ['p1', { p1: 1.5 }],
    ['p2', { p2: 0x100 }],
  ])('rejects an out-of-range %s', (name, override) => {
    expectNfcError(
      () => encodeCommandApdu({ ...SELECT, ...override } as CommandApdu),
      'invalidArgument',
      name,
    );
  });

  it.each([0, -1, 1.5, EXTENDED_MAX_LE + 1])('rejects an Le of %s', (le) => {
    expectNfcError(() => encodeCommandApdu({ ...SELECT, le }), 'invalidArgument', 'le must be');
  });

  it('encodes extended data with an extended Le of 65536', () => {
    const data = new Uint8Array(300).fill(1);
    const apdu = encodeCommandApdu({ ...SELECT, data, le: EXTENDED_MAX_LE });
    expect(Array.from(apdu.subarray(apdu.length - 2))).toEqual([0x00, 0x00]);
  });

  it('rejects data larger than any APDU can carry, and says what to do', () => {
    expectNfcError(
      () => encodeCommandApdu({ ...SELECT, data: new Uint8Array(70_000) }),
      'invalidArgument',
      'sendApduChained',
    );
  });
});

describe('decodeResponseApdu', () => {
  it('splits the status word from the body', () => {
    const response = decodeResponseApdu(bytes(0x6f, 0x0a, 0x90, 0x00));

    expect(Array.from(response.data)).toEqual([0x6f, 0x0a]);
    expect(response.sw1).toBe(0x90);
    expect(response.sw2).toBe(0x00);
    expect(response.status).toBe(SW_SUCCESS);
    expect(response.statusHex).toBe('9000');
    expect(response.ok).toBe(true);
  });

  it('handles a status word with no body', () => {
    const response = decodeResponseApdu(bytes(0x6a, 0x82));

    expect(response.data).toHaveLength(0);
    expect(response.ok).toBe(false);
    expect(response.statusHex).toBe('6a82');
  });

  it('pads a low status word to four hex digits', () => {
    expect(decodeResponseApdu(bytes(0x00, 0x00)).statusHex).toBe('0000');
  });

  it('rejects a response too short to hold a status word', () => {
    expectNfcError(() => decodeResponseApdu(bytes(0x90)), 'transceiveFailed', 'at least 2');
  });
});

describe('describeStatusWord', () => {
  it.each([
    [0x9000, 'Success'],
    [0x6a82, 'File or application not found'],
    [0x6982, 'authenticate first'],
    [0x6700, 'Wrong length'],
  ])('describes the known word %s', (status, expected) => {
    expect(describeStatusWord(status)).toContain(expected);
  });

  it('explains a 61xx as more data waiting', () => {
    expect(describeStatusWord(0x611f)).toContain('31 more byte(s)');
  });

  it('explains a 6Cxx as the corrected length', () => {
    expect(describeStatusWord(0x6c20)).toContain('expects 32');
  });

  it('reads a 6C00 as 256, not zero', () => {
    expect(describeStatusWord(0x6c00)).toContain('expects 256');
  });

  it('reports remaining attempts for a 63Cx', () => {
    expect(describeStatusWord(0x63c2)).toContain('2 attempt(s) remaining');
  });

  it('falls back to the error class for an unlisted 6x word', () => {
    expect(describeStatusWord(0x6401)).toBe('Error, defined by the card');
  });

  it('does not guess at a proprietary word', () => {
    expect(describeStatusWord(0x9101)).toContain('applet documentation');
  });
});

describe('sendApdu', () => {
  it('returns the response when the card answers in one go', async () => {
    const transport = scriptedTransport(bytes(0x01, 0x02, 0x90, 0x00));
    const response = await sendApdu(transport, SELECT);

    expect(Array.from(response.data)).toEqual([0x01, 0x02]);
    expect(response.ok).toBe(true);
    expect(transport.sent).toHaveLength(1);
  });

  describe('61xx, more data waiting', () => {
    it('follows up with GET RESPONSE and joins the parts', async () => {
      // Without this the caller gets the first frame and a status word that does
      // not look like an error, which is a genuinely nasty way to lose data.
      const transport = scriptedTransport(
        bytes(0xaa, 0xbb, 0x61, 0x03),
        bytes(0xcc, 0xdd, 0xee, 0x90, 0x00),
      );

      const response = await sendApdu(transport, SELECT);

      expect(Array.from(response.data)).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
      expect(response.ok).toBe(true);
      expect(transport.sent).toHaveLength(2);
      expect(Array.from(transport.sent[1]!)).toEqual([0x00, 0xc0, 0x00, 0x00, 0x03]);
    });

    it('chains several follow-ups', async () => {
      const transport = scriptedTransport(
        bytes(0x01, 0x61, 0x01),
        bytes(0x02, 0x61, 0x01),
        bytes(0x03, 0x90, 0x00),
      );

      const response = await sendApdu(transport, SELECT);
      expect(Array.from(response.data)).toEqual([0x01, 0x02, 0x03]);
      expect(transport.sent).toHaveLength(3);
    });

    it('reads a 6100 as 256 bytes remaining', async () => {
      const transport = scriptedTransport(bytes(0x61, 0x00), bytes(0xff, 0x90, 0x00));
      await sendApdu(transport, SELECT);

      // Le 256 is encoded as the byte 0x00.
      expect(Array.from(transport.sent[1]!)).toEqual([0x00, 0xc0, 0x00, 0x00, 0x00]);
    });

    it('carries the original class byte into GET RESPONSE', async () => {
      // A logical channel or secure-messaging bit set on the command must not be
      // silently dropped by the follow-up.
      const transport = scriptedTransport(bytes(0x61, 0x02), bytes(0x01, 0x02, 0x90, 0x00));
      await sendApdu(transport, { ...SELECT, cla: 0x0c });

      expect(transport.sent[1]![0]).toBe(0x0c);
    });

    it('can be told not to follow up', async () => {
      const transport = scriptedTransport(bytes(0xaa, 0x61, 0x03));
      const response = await sendApdu(transport, SELECT, { followGetResponse: false });

      expect(response.statusHex).toBe('6103');
      expect(transport.sent).toHaveLength(1);
    });
  });

  describe('6Cxx, wrong expected length', () => {
    it('repeats the command with the length the card asked for', async () => {
      const transport = scriptedTransport(bytes(0x6c, 0x05), bytes(1, 2, 3, 4, 5, 0x90, 0x00));
      const response = await sendApdu(transport, { ...SELECT, le: 16 });

      expect(Array.from(response.data)).toEqual([1, 2, 3, 4, 5]);
      expect(transport.sent).toHaveLength(2);
      expect(transport.sent[0]![4]).toBe(0x10);
      expect(transport.sent[1]![4]).toBe(0x05);
    });

    it('reads a 6C00 as 256', async () => {
      const transport = scriptedTransport(bytes(0x6c, 0x00), bytes(0xff, 0x90, 0x00));
      await sendApdu(transport, { ...SELECT, le: 1 });

      expect(transport.sent[1]![4]).toBe(0x00);
    });

    it('can be told not to retry', async () => {
      const transport = scriptedTransport(bytes(0x6c, 0x05));
      const response = await sendApdu(transport, SELECT, { retryWrongLength: false });

      expect(response.statusHex).toBe('6c05');
      expect(transport.sent).toHaveLength(1);
    });
  });

  it('handles a 6Cxx followed by a 61xx', async () => {
    const transport = scriptedTransport(
      bytes(0x6c, 0x04),
      bytes(0xaa, 0x61, 0x01),
      bytes(0xbb, 0x90, 0x00),
    );

    const response = await sendApdu(transport, { ...SELECT, le: 1 });
    expect(Array.from(response.data)).toEqual([0xaa, 0xbb]);
    expect(transport.sent).toHaveLength(3);
  });

  describe('runaway protection', () => {
    it('gives up when the card keeps asking for GET RESPONSE', async () => {
      // A card stuck on 61xx would otherwise loop until the session times out,
      // with nothing to show for it.
      const transport = scriptedTransport(bytes(0x61, 0x01));

      await sendApdu(transport, SELECT, { maxFollowUps: 3 }).catch((error: NfcError) => {
        expect(error.code).toBe('transceiveFailed');
        expect(error.message).toContain('after 3');
        expect(error.message).toContain('6101');
      });
      expect(transport.sent).toHaveLength(4);
    });

    it('gives up when the card keeps rejecting the length', async () => {
      const transport = scriptedTransport(bytes(0x6c, 0x05));

      await expect(sendApdu(transport, SELECT, { maxFollowUps: 2 })).rejects.toMatchObject({
        code: 'transceiveFailed',
      });
    });

    it('allows follow-ups to be disabled entirely', async () => {
      const transport = scriptedTransport(bytes(0x61, 0x01));
      const response = await sendApdu(transport, SELECT, { maxFollowUps: 0 }).catch(
        (error: NfcError) => error,
      );

      expect(NfcError.is(response, 'transceiveFailed')).toBe(true);
      expect(transport.sent).toHaveLength(1);
    });

    it.each([-1, 1.5])('rejects an invalid maxFollowUps of %s', async (maxFollowUps) => {
      await expect(sendApdu(scriptedTransport(), SELECT, { maxFollowUps })).rejects.toMatchObject({
        code: 'invalidArgument',
      });
    });
  });
});

describe('sendApduChained', () => {
  it('sends a small command straight through, without chaining', async () => {
    const transport = scriptedTransport(bytes(0x90, 0x00));
    await sendApduChained(transport, { ...SELECT, data: bytes(1, 2, 3) });

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]![0]).toBe(0x00); // no chaining bit
  });

  it('sends a command with no data at all straight through', async () => {
    const transport = scriptedTransport(bytes(0x90, 0x00));
    await sendApduChained(transport, SELECT);

    expect(transport.sent).toHaveLength(1);
    expect(Array.from(transport.sent[0]!)).toEqual([0x00, 0xa4, 0x04, 0x00]);
  });

  it('splits large data and sets the chaining bit on every chunk but the last', async () => {
    const transport = scriptedTransport(bytes(0x90, 0x00));
    const data = new Uint8Array(600).fill(0x41);

    const response = await sendApduChained(transport, { ...SELECT, data, le: 16 });

    expect(response.ok).toBe(true);
    expect(transport.sent).toHaveLength(3); // 255 + 255 + 90
    expect(transport.sent[0]![0]).toBe(0x10);
    expect(transport.sent[1]![0]).toBe(0x10);
    expect(transport.sent[2]![0]).toBe(0x00);
  });

  it('puts the expected length only on the final chunk', async () => {
    // Only the last command produces a response body, so an Le on an
    // intermediate chunk would be asking the card for data it has not made yet.
    const transport = scriptedTransport(bytes(0x90, 0x00));
    await sendApduChained(transport, { ...SELECT, data: new Uint8Array(400).fill(1), le: 32 });

    const first = transport.sent[0]!;
    const last = transport.sent[transport.sent.length - 1]!;
    expect(first).toHaveLength(4 + 1 + 255);
    expect(last[last.length - 1]).toBe(32);
  });

  it('honours a smaller chunk size', async () => {
    const transport = scriptedTransport(bytes(0x90, 0x00));
    await sendApduChained(
      transport,
      { ...SELECT, data: new Uint8Array(10).fill(1) },
      {
        chunkSize: 4,
      },
    );

    expect(transport.sent).toHaveLength(3); // 4 + 4 + 2
  });

  it('splits evenly divisible data without sending an empty final chunk', async () => {
    const transport = scriptedTransport(bytes(0x90, 0x00));
    await sendApduChained(
      transport,
      { ...SELECT, data: new Uint8Array(8).fill(1) },
      {
        chunkSize: 4,
      },
    );

    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]![4]).toBe(4);
  });

  it('stops as soon as the card rejects a chunk', async () => {
    // Pushing more data at a card that already said no wastes time at best, and
    // at worst leaves it in a state the next command does not expect.
    const transport = scriptedTransport(bytes(0x6a, 0x80));
    const response = await sendApduChained(transport, {
      ...SELECT,
      data: new Uint8Array(600).fill(1),
    });

    expect(response.statusHex).toBe('6a80');
    expect(transport.sent).toHaveLength(1);
  });

  it.each([0, -1, 1.5])('rejects a chunkSize of %s', async (chunkSize) => {
    await expect(
      sendApduChained(scriptedTransport(), { ...SELECT, data: bytes(1) }, { chunkSize }),
    ).rejects.toMatchObject({ code: 'invalidArgument' });
  });
});

describe('common commands', () => {
  describe('selectByName', () => {
    it('builds a SELECT by AID', () => {
      const aid = bytes(0xa0, 0x00, 0x00, 0x02, 0x47, 0x10, 0x01);
      const apdu = encodeCommandApdu(selectByName(aid));

      expect(toHex(apdu)).toBe('00a4040007a0000002471001' + '00');
    });

    it('selects the next occurrence when asked', () => {
      expect(selectByName(bytes(0xa0), { first: false }).p2).toBe(0x02);
    });

    it.each([0, 17])('rejects an AID of %s bytes', (length) => {
      expectNfcError(() => selectByName(new Uint8Array(length)), 'invalidArgument', '1..16 bytes');
    });
  });

  describe('selectByFileId', () => {
    it('builds a SELECT by file identifier', () => {
      // E103 is the capability container on a Type 4 tag.
      expect(Array.from(encodeCommandApdu(selectByFileId(0xe103)))).toEqual([
        0x00, 0xa4, 0x00, 0x0c, 0x02, 0xe1, 0x03,
      ]);
    });

    it.each([-1, 0x10000, 1.5])('rejects the file identifier %s', (fileId) => {
      expectNfcError(() => selectByFileId(fileId), 'invalidArgument', '16-bit');
    });
  });

  describe('readBinary', () => {
    it('puts the offset in P1-P2 and the length in Le', () => {
      expect(Array.from(encodeCommandApdu(readBinary(0x0102, 15)))).toEqual([
        0x00, 0xb0, 0x01, 0x02, 0x0f,
      ]);
    });

    it('reads from the start', () => {
      expect(Array.from(encodeCommandApdu(readBinary(0, 2)))).toEqual([
        0x00, 0xb0, 0x00, 0x00, 0x02,
      ]);
    });

    it.each([-1, 0x8000, 1.5])('rejects the offset %s', (offset) => {
      expectNfcError(() => readBinary(offset, 1), 'invalidArgument', 'offset');
    });

    it.each([0, -1, EXTENDED_MAX_LE + 1])('rejects the length %s', (length) => {
      expectNfcError(() => readBinary(0, length), 'invalidArgument', 'length');
    });
  });

  describe('updateBinary', () => {
    it('puts the offset in P1-P2 and the bytes in the data field', () => {
      expect(Array.from(encodeCommandApdu(updateBinary(4, bytes(0xaa, 0xbb))))).toEqual([
        0x00, 0xd6, 0x00, 0x04, 0x02, 0xaa, 0xbb,
      ]);
    });

    it.each([-1, 0x8000, 1.5])('rejects the offset %s', (offset) => {
      expectNfcError(() => updateBinary(offset, bytes(1)), 'invalidArgument', 'offset');
    });

    it('rejects an empty write', () => {
      expectNfcError(() => updateBinary(0, new Uint8Array(0)), 'invalidArgument', 'at least one');
    });
  });

  it('reads a Type 4 capability container end to end', async () => {
    // The real sequence: select the NDEF application, select the CC file, read
    // it. The card answers 61xx on the first select, as many do.
    const transport = scriptedTransport(
      bytes(0x61, 0x02),
      bytes(0x6f, 0x00, 0x90, 0x00),
      bytes(0x90, 0x00),
      bytes(
        0x00,
        0x0f,
        0x20,
        0x00,
        0x3b,
        0x00,
        0x34,
        0x04,
        0x06,
        0xe1,
        0x04,
        0x0e,
        0xff,
        0x00,
        0x00,
        0x90,
        0x00,
      ),
    );

    const ndefAid = bytes(0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01);
    expect((await sendApdu(transport, selectByName(ndefAid))).ok).toBe(true);
    expect((await sendApdu(transport, selectByFileId(0xe103))).ok).toBe(true);

    const cc = await sendApdu(transport, readBinary(0, 15));
    expect(cc.ok).toBe(true);
    expect(cc.data).toHaveLength(15);
    expect(toHex(cc.data.subarray(0, 3))).toBe('000f20');
  });
});
