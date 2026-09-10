import { NfcError } from '../../errors.js';
import {
  DEFAULT_NDEF_FILE_ID,
  MIN_CC_LENGTH,
  NDEF_FILE_CONTROL_TAG,
  decodeCapabilityContainer,
  encodeCapabilityContainer,
  type CapabilityContainerInit,
} from '../ccFile.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function expectMalformed(input: Uint8Array, messagePart: string): void {
  try {
    decodeCapabilityContainer(input);
  } catch (error) {
    expect(NfcError.is(error, 'ndefMalformed')).toBe(true);
    expect((error as NfcError).message).toContain(messagePart);
    return;
  }
  throw new Error('Expected decodeCapabilityContainer to reject, but it returned a value.');
}

/**
 * The CC file a NXP DESFire EV1 formatted for NDEF actually returns:
 *
 *   000F  CCLEN 15
 *   20    mapping version 2.0
 *   003B  MLe 59
 *   0034  MLc 52
 *   04 06 E104 0EFF 00 00   NDEF File Control: file E104, max 3839, read/write
 */
const DESFIRE_CC = bytes(
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
);

describe('decodeCapabilityContainer', () => {
  it('decodes a real DESFire capability container', () => {
    const cc = decodeCapabilityContainer(DESFIRE_CC);

    expect(cc.length).toBe(15);
    expect(cc.mappingVersion).toEqual({ major: 2, minor: 0 });
    expect(cc.maxReadSize).toBe(59);
    expect(cc.maxWriteSize).toBe(52);
    expect(cc.ndefFile).toEqual({
      fileId: 0xe104,
      maxFileSize: 0x0eff,
      readAccess: 0x00,
      writeAccess: 0x00,
      readable: true,
      writable: true,
      permanentlyReadOnly: false,
    });
    expect(cc.otherTlvs).toEqual([]);
  });

  it('splits the mapping version into major and minor nibbles', () => {
    const v3 = bytes(...DESFIRE_CC);
    v3[2] = 0x30;
    expect(decodeCapabilityContainer(v3).mappingVersion).toEqual({ major: 3, minor: 0 });

    v3[2] = 0x21;
    expect(decodeCapabilityContainer(v3).mappingVersion).toEqual({ major: 2, minor: 1 });
  });

  it('reports a permanently locked tag distinctly from one needing authentication', () => {
    const locked = bytes(...DESFIRE_CC);
    locked[14] = 0xff;

    const authRequired = bytes(...DESFIRE_CC);
    authRequired[14] = 0x80;

    expect(decodeCapabilityContainer(locked).ndefFile).toMatchObject({
      writable: false,
      permanentlyReadOnly: true,
    });
    expect(decodeCapabilityContainer(authRequired).ndefFile).toMatchObject({
      writable: false,
      permanentlyReadOnly: false,
    });
  });

  it('reports a file that needs authentication to read', () => {
    const protectedRead = bytes(...DESFIRE_CC);
    protectedRead[13] = 0x80;

    expect(decodeCapabilityContainer(protectedRead).ndefFile).toMatchObject({
      readable: false,
      readAccess: 0x80,
    });
  });

  it('ignores padding past the declared CCLEN', () => {
    // Some tags return a fixed-size buffer zero-padded past CCLEN. Parsing that
    // padding would turn zeros into bogus TLV blocks.
    const padded = new Uint8Array([...DESFIRE_CC, 0, 0, 0, 0, 0, 0, 0, 0]);
    const cc = decodeCapabilityContainer(padded);

    expect(cc.length).toBe(15);
    expect(cc.otherTlvs).toEqual([]);
    expect(cc.ndefFile?.fileId).toBe(0xe104);
  });

  it('preserves TLV blocks it does not recognise', () => {
    const withExtra = new Uint8Array([
      0x00, 0x13, 0x20, 0x00, 0x3b, 0x00, 0x34, 0x04, 0x06, 0xe1, 0x04, 0x0e, 0xff, 0x00, 0x00,
      0x05, 0x02, 0xaa, 0xbb,
    ]);

    const cc = decodeCapabilityContainer(withExtra);
    expect(cc.otherTlvs).toHaveLength(1);
    expect(cc.otherTlvs[0]!.tag).toBe(0x05);
    expect(Array.from(cc.otherTlvs[0]!.value)).toEqual([0xaa, 0xbb]);
  });

  it('returns undefined for ndefFile when there is no NDEF File Control TLV', () => {
    // Valid but useless for NDEF; the caller decides whether that is a failure.
    const noNdef = new Uint8Array([
      0x00, 0x0f, 0x20, 0x00, 0x3b, 0x00, 0x34, 0x05, 0x06, 1, 2, 3, 4, 5, 6,
    ]);

    const cc = decodeCapabilityContainer(noNdef);
    expect(cc.ndefFile).toBeUndefined();
    expect(cc.otherTlvs).toHaveLength(1);
  });

  it('exposes the NDEF File Control tag value', () => {
    expect(NDEF_FILE_CONTROL_TAG).toBe(0x04);
    expect(MIN_CC_LENGTH).toBe(15);
  });

  it('rejects a buffer shorter than the minimum', () => {
    expectMalformed(new Uint8Array(14), 'at least 15 are required');
  });

  it('rejects a CCLEN below the minimum', () => {
    const tooSmall = bytes(...DESFIRE_CC);
    tooSmall[1] = 0x0e;
    expectMalformed(tooSmall, 'below the minimum');
  });

  it('rejects a CCLEN longer than what was read', () => {
    // This means the read was short; continuing would parse padding as
    // structure and silently produce a wrong file id.
    const tooBig = bytes(...DESFIRE_CC);
    tooBig[1] = 0xff;
    expectMalformed(tooBig, 'the read was short');
  });

  it('rejects an NDEF File Control TLV of the wrong length', () => {
    const wrongLength = new Uint8Array([
      0x00, 0x0f, 0x20, 0x00, 0x3b, 0x00, 0x34, 0x04, 0x04, 0xe1, 0x04, 0x0e, 0xff, 0x00, 0x00,
    ]);
    expectMalformed(wrongLength, 'must hold 6 bytes');
  });

  it('rejects a TLV value that runs past the declared length', () => {
    const overrun = new Uint8Array([
      0x00, 0x0f, 0x20, 0x00, 0x3b, 0x00, 0x34, 0x04, 0x20, 0xe1, 0x04, 0x0e, 0xff, 0x00, 0x00,
    ]);
    expectMalformed(overrun, 'CC TLV 0x4 value');
  });

  it('rejects a TLV tag with no length byte', () => {
    const truncated = new Uint8Array([
      0x00, 0x10, 0x20, 0x00, 0x3b, 0x00, 0x34, 0x04, 0x06, 0xe1, 0x04, 0x0e, 0xff, 0x00, 0x00,
      0x05,
    ]);
    expectMalformed(truncated, 'CC TLV length');
  });
});

describe('encodeCapabilityContainer', () => {
  const init: CapabilityContainerInit = {
    fileId: DEFAULT_NDEF_FILE_ID,
    maxFileSize: 0x0100,
    maxReadSize: 0x00fb,
    maxWriteSize: 0x00ff,
    writable: true,
  };

  function expectRejected(overrides: Partial<CapabilityContainerInit>, messagePart: string): void {
    try {
      encodeCapabilityContainer({ ...init, ...overrides });
    } catch (error) {
      expect(NfcError.is(error, 'invalidArgument')).toBe(true);
      expect((error as NfcError).message).toContain(messagePart);
      return;
    }
    throw new Error('Expected encodeCapabilityContainer to reject, but it returned a value.');
  }

  it('produces something the decoder reads back unchanged', () => {
    // The pairing is the point: a CC file is the first thing a terminal reads,
    // and a wrong byte in it makes an emulated card look absent rather than
    // broken. Round-tripping is how that stays true.
    const decoded = decodeCapabilityContainer(encodeCapabilityContainer(init));

    expect(decoded.length).toBe(MIN_CC_LENGTH);
    expect(decoded.mappingVersion).toEqual({ major: 2, minor: 0 });
    expect(decoded.maxReadSize).toBe(0x00fb);
    expect(decoded.maxWriteSize).toBe(0x00ff);
    expect(decoded.ndefFile).toEqual({
      fileId: DEFAULT_NDEF_FILE_ID,
      maxFileSize: 0x0100,
      readAccess: 0x00,
      writeAccess: 0x00,
      readable: true,
      writable: true,
      permanentlyReadOnly: false,
    });
    expect(decoded.otherTlvs).toEqual([]);
  });

  it('marks a read-only file as permanently locked', () => {
    const decoded = decodeCapabilityContainer(
      encodeCapabilityContainer({ ...init, writable: false }),
    );

    expect(decoded.ndefFile?.writable).toBe(false);
    expect(decoded.ndefFile?.permanentlyReadOnly).toBe(true);
  });

  it('writes the exact 15 bytes a Type 4 tag returns', () => {
    expect(
      encodeCapabilityContainer({ ...init, maxReadSize: 0x003b, maxWriteSize: 0x0034 }),
    ).toEqual(
      bytes(
        0x00,
        0x0f,
        0x20,
        0x00,
        0x3b,
        0x00,
        0x34,
        NDEF_FILE_CONTROL_TAG,
        0x06,
        0xe1,
        0x04,
        0x01,
        0x00,
        0x00,
        0x00,
      ),
    );
  });

  it('honours a non-default mapping version', () => {
    const decoded = decodeCapabilityContainer(
      encodeCapabilityContainer({ ...init, mappingVersion: { major: 3, minor: 1 } }),
    );

    expect(decoded.mappingVersion).toEqual({ major: 3, minor: 1 });
  });

  describe('rejects values a reader could not use', () => {
    it('a file id outside 16 bits', () => {
      expectRejected({ fileId: 0x1e104 }, 'must be a 16-bit value');
      expectRejected({ maxFileSize: -1 }, 'must be a 16-bit value');
      expectRejected({ maxReadSize: 1.5 }, 'must be a 16-bit value');
      expectRejected({ maxWriteSize: 0x10000 }, 'must be a 16-bit value');
    });

    it('a reserved file id', () => {
      // Selecting one of these looks for a file that cannot hold the message.
      expectRejected({ fileId: 0x0000 }, 'reserved');
      expectRejected({ fileId: 0xffff }, 'reserved');
      expectRejected({ fileId: 0xe103 }, 'reserved');
    });

    it('a file too small to hold even the length prefix', () => {
      expectRejected({ maxFileSize: 1 }, 'at least 2');
    });

    it('a zero MLe or MLc', () => {
      expectRejected({ maxReadSize: 0 }, 'at least 1');
      expectRejected({ maxWriteSize: 0 }, 'at least 1');
    });

    it('a mapping version half that does not fit a nibble', () => {
      expectRejected({ mappingVersion: { major: 16, minor: 0 } }, 'single nibble');
      expectRejected({ mappingVersion: { major: 2, minor: -1 } }, 'single nibble');
    });
  });
});
