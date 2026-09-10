import { NfcError } from '../../errors.js';
import { encodeCommandApdu } from '../../protocols/iso7816.js';
import { decodeCommandApdu, encodeResponseApdu, statusResponse, StatusWord } from '../apdu.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

async function expectInvalidArgument(run: () => unknown): Promise<void> {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(NfcError);
  expect((thrown as NfcError).code).toBe('invalidArgument');
}

describe('decodeCommandApdu', () => {
  describe('the four ISO 7816 cases, short form', () => {
    it('case 1: header only', () => {
      expect(decodeCommandApdu(bytes(0x00, 0xa4, 0x04, 0x00))).toEqual({
        cla: 0x00,
        ins: 0xa4,
        p1: 0x04,
        p2: 0x00,
        data: new Uint8Array(),
        le: null,
        extended: false,
      });
    });

    it('case 2: an expected length and no data', () => {
      const apdu = decodeCommandApdu(bytes(0x00, 0xb0, 0x00, 0x00, 0x0f));

      expect(apdu.data).toHaveLength(0);
      expect(apdu.le).toBe(15);
    });

    it('case 3: data and no expected length', () => {
      const apdu = decodeCommandApdu(bytes(0x00, 0xd6, 0x00, 0x00, 0x02, 0xab, 0xcd));

      expect(apdu.data).toEqual(bytes(0xab, 0xcd));
      expect(apdu.le).toBeNull();
    });

    it('case 4: data and an expected length', () => {
      const apdu = decodeCommandApdu(bytes(0x00, 0xa4, 0x04, 0x00, 0x02, 0xe1, 0x03, 0x10));

      expect(apdu.data).toEqual(bytes(0xe1, 0x03));
      expect(apdu.le).toBe(16);
    });
  });

  describe('the maximum-length encoding', () => {
    it('reads a short Le of 0x00 as 256, not 0', () => {
      // The one place this is easy to get wrong, and getting it wrong truncates
      // every full-size read a terminal asks for.
      expect(decodeCommandApdu(bytes(0x00, 0xb0, 0x00, 0x00, 0x00)).le).toBe(256);
    });

    it('reads an extended Le of 0x0000 as 65536', () => {
      expect(decodeCommandApdu(bytes(0x00, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x00)).le).toBe(65536);
    });

    it('reads an extended Le of 0x0000 as 65536 after a data field too', () => {
      // The same rule, on the other side of the data field. Two separate places
      // in the parser, and only one of them is exercised by the case above.
      const apdu = decodeCommandApdu(
        bytes(0x00, 0xd6, 0x00, 0x00, 0x00, 0x00, 0x01, 0xaa, 0x00, 0x00),
      );

      expect(apdu.data).toEqual(bytes(0xaa));
      expect(apdu.le).toBe(65536);
    });
  });

  describe('the extended form', () => {
    it('reads case 2, which carries no data field at all', () => {
      // `00 Le1 Le2` looks like the start of a truncated case 4 and is the shape
      // most hand-written parsers get wrong.
      const apdu = decodeCommandApdu(bytes(0x00, 0xb0, 0x00, 0x00, 0x00, 0x01, 0x00));

      expect(apdu.extended).toBe(true);
      expect(apdu.data).toHaveLength(0);
      expect(apdu.le).toBe(256);
    });

    it('reads case 3', () => {
      const apdu = decodeCommandApdu(
        bytes(0x00, 0xd6, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x02, 0x03),
      );

      expect(apdu.extended).toBe(true);
      expect(apdu.data).toEqual(bytes(0x01, 0x02, 0x03));
      expect(apdu.le).toBeNull();
    });

    it('reads case 4', () => {
      const apdu = decodeCommandApdu(
        bytes(0x00, 0xa4, 0x00, 0x00, 0x00, 0x00, 0x02, 0xe1, 0x04, 0x00, 0x20),
      );

      expect(apdu.data).toEqual(bytes(0xe1, 0x04));
      expect(apdu.le).toBe(32);
      expect(apdu.extended).toBe(true);
    });

    it('reads a data field longer than the short form allows', () => {
      const data = new Uint8Array(300).fill(0x5a);
      const command = new Uint8Array([0x00, 0xd6, 0x00, 0x00, 0x00, 0x01, 0x2c, ...data]);

      expect(decodeCommandApdu(command).data).toEqual(data);
    });
  });

  describe('rejects a frame it cannot trust', () => {
    it('shorter than a header', () => {
      void expectInvalidArgument(() => decodeCommandApdu(bytes(0x00, 0xa4, 0x04)));
    });

    it('an Lc that promises more data than arrived', () => {
      void expectInvalidArgument(() =>
        decodeCommandApdu(bytes(0x00, 0xd6, 0x00, 0x00, 0x05, 0x01)),
      );
    });

    it('bytes trailing the Le field', () => {
      void expectInvalidArgument(() =>
        decodeCommandApdu(bytes(0x00, 0xd6, 0x00, 0x00, 0x01, 0xaa, 0x00, 0x99)),
      );
    });

    it('a zero Lc', () => {
      void expectInvalidArgument(() =>
        decodeCommandApdu(bytes(0x00, 0xd6, 0x00, 0x00, 0x00, 0xaa)),
      );
    });

    it('a truncated extended length field', () => {
      void expectInvalidArgument(() =>
        decodeCommandApdu(bytes(0x00, 0xb0, 0x00, 0x00, 0x00, 0x01)),
      );
    });

    it('a zero extended Lc', () => {
      void expectInvalidArgument(() =>
        decodeCommandApdu(bytes(0x00, 0xd6, 0x00, 0x00, 0x00, 0x00, 0x00, 0xaa)),
      );
    });

    it('an extended Lc that promises more data than arrived', () => {
      void expectInvalidArgument(() =>
        decodeCommandApdu(bytes(0x00, 0xd6, 0x00, 0x00, 0x00, 0x00, 0x09, 0x01, 0x02)),
      );
    });

    it('an impossible number of bytes after an extended data field', () => {
      void expectInvalidArgument(() =>
        decodeCommandApdu(bytes(0x00, 0xd6, 0x00, 0x00, 0x00, 0x00, 0x01, 0xaa, 0x00)),
      );
    });
  });

  describe('round-trips against the reader-side encoder', () => {
    // The two halves of the same framing, so a change to either that breaks the
    // pairing fails here rather than on a terminal.
    const cases = [
      { name: 'case 1', command: { cla: 0x00, ins: 0xa4, p1: 0x04, p2: 0x00 } },
      { name: 'case 2', command: { cla: 0x00, ins: 0xb0, p1: 0x00, p2: 0x02, le: 15 } },
      {
        name: 'case 2 asking the maximum',
        command: { cla: 0x00, ins: 0xb0, p1: 0, p2: 0, le: 256 },
      },
      {
        name: 'case 3',
        command: { cla: 0x00, ins: 0xd6, p1: 0x00, p2: 0x00, data: bytes(1, 2, 3) },
      },
      {
        name: 'case 4',
        command: {
          cla: 0x00,
          ins: 0xa4,
          p1: 0x04,
          p2: 0x00,
          data: bytes(0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01),
          le: 256,
        },
      },
      {
        name: 'an extended data field',
        command: {
          cla: 0x00,
          ins: 0xd6,
          p1: 0x00,
          p2: 0x00,
          data: new Uint8Array(400).fill(0x11),
        },
      },
    ];

    it.each(cases)('$name', ({ command }) => {
      const decoded = decodeCommandApdu(encodeCommandApdu(command));

      expect(decoded.cla).toBe(command.cla);
      expect(decoded.ins).toBe(command.ins);
      expect(decoded.p1).toBe(command.p1);
      expect(decoded.p2).toBe(command.p2);
      expect(decoded.data).toEqual(command.data ?? new Uint8Array());
      expect(decoded.le).toBe(command.le ?? null);
    });
  });
});

describe('encodeResponseApdu', () => {
  it('appends the status word after the data', () => {
    expect(encodeResponseApdu(bytes(0xaa, 0xbb))).toEqual(bytes(0xaa, 0xbb, 0x90, 0x00));
  });

  it('writes a status word with a low byte correctly', () => {
    expect(encodeResponseApdu(new Uint8Array(), StatusWord.fileNotFound)).toEqual(
      bytes(0x6a, 0x82),
    );
  });

  it('produces just the status word when there is no data', () => {
    expect(statusResponse(StatusWord.ok)).toEqual(bytes(0x90, 0x00));
  });

  it('rejects a status word that is not two bytes', async () => {
    await expectInvalidArgument(() => encodeResponseApdu(new Uint8Array(), 0x1234567));
    await expectInvalidArgument(() => encodeResponseApdu(new Uint8Array(), -1));
    await expectInvalidArgument(() => encodeResponseApdu(new Uint8Array(), 1.5));
  });
});
