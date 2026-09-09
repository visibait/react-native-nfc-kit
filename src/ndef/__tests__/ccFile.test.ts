import { NfcError } from '../../errors.js';
import { MIN_CC_LENGTH, NDEF_FILE_CONTROL_TAG, decodeCapabilityContainer } from '../ccFile.js';

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
