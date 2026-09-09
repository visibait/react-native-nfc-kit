import { NfcError } from '../../errors.js';
import { encodeMessage } from '../message.js';
import { createTextRecord } from '../rtd/text.js';
import { MAX_TLV_LENGTH, TlvTag, decodeTlvs, encodeNdefTlv, findNdefMessageTlv } from '../tlv.js';

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

describe('TlvTag', () => {
  it('maps each name to its specification value', () => {
    expect(TlvTag).toEqual({
      Null: 0x00,
      LockControl: 0x01,
      MemoryControl: 0x02,
      NdefMessage: 0x03,
      Proprietary: 0xfd,
      Terminator: 0xfe,
    });
    expect(MAX_TLV_LENGTH).toBe(0xfffe);
  });
});

describe('decodeTlvs', () => {
  it('decodes an empty data area', () => {
    expect(decodeTlvs(bytes())).toEqual([]);
  });

  it('decodes a single NDEF Message TLV', () => {
    const blocks = decodeTlvs(bytes(0x03, 0x03, 0xaa, 0xbb, 0xcc, 0xfe));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.tag).toBe(TlvTag.NdefMessage);
    expect(Array.from(blocks[0]!.value)).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it('skips NULL padding wherever it appears', () => {
    const blocks = decodeTlvs(bytes(0x00, 0x00, 0x03, 0x01, 0xaa, 0x00, 0xfe));

    expect(blocks).toHaveLength(1);
    expect(Array.from(blocks[0]!.value)).toEqual([0xaa]);
  });

  it('decodes the lock and memory control blocks a manufacturer writes at format time', () => {
    // A real NTAG213 data area starts with these before the NDEF block.
    const blocks = decodeTlvs(bytes(0x01, 0x03, 0xa0, 0x0c, 0x34, 0x03, 0x01, 0xaa, 0xfe));

    expect(blocks.map((b) => b.tag)).toEqual([TlvTag.LockControl, TlvTag.NdefMessage]);
    expect(Array.from(blocks[0]!.value)).toEqual([0xa0, 0x0c, 0x34]);
  });

  it('decodes a proprietary block', () => {
    const blocks = decodeTlvs(bytes(0xfd, 0x02, 0x01, 0x02, 0xfe));
    expect(blocks[0]!.tag).toBe(TlvTag.Proprietary);
  });

  it('stops at the terminator and ignores unwritten memory after it', () => {
    // Everything past the terminator is blank tag memory, usually all zeros.
    const blocks = decodeTlvs(bytes(0x03, 0x01, 0xaa, 0xfe, 0x03, 0x01, 0xbb));

    expect(blocks).toHaveLength(1);
    expect(Array.from(blocks[0]!.value)).toEqual([0xaa]);
  });

  it('accepts a data area that ends without a terminator', () => {
    // A tag whose data area is exactly full has no room for one, and rejecting
    // that would make a perfectly valid tag unreadable.
    const blocks = decodeTlvs(bytes(0x03, 0x01, 0xaa));
    expect(blocks).toHaveLength(1);
  });

  it('decodes a zero-length value', () => {
    expect(decodeTlvs(bytes(0x03, 0x00, 0xfe))[0]!.value).toHaveLength(0);
  });

  it('decodes the 3-byte length form', () => {
    const value = new Uint8Array(300).fill(7);
    const input = new Uint8Array([0x03, 0xff, 0x01, 0x2c, ...value, 0xfe]);

    const blocks = decodeTlvs(input);
    expect(blocks[0]!.value).toHaveLength(300);
    expect(blocks[0]!.value[299]).toBe(7);
  });

  it('rejects the reserved 0xFFFF length', () => {
    expectNfcError(() => decodeTlvs(bytes(0x03, 0xff, 0xff, 0xff)), 'ndefMalformed', 'is reserved');
  });

  it('rejects a 3-byte length that should have used the 1-byte form', () => {
    // A writer emitting the long form for a short length has a bug worth seeing.
    expectNfcError(
      () => decodeTlvs(bytes(0x03, 0xff, 0x00, 0x02, 0xaa, 0xbb)),
      'ndefMalformed',
      'must use the 1-byte form',
    );
  });

  it('accepts the 3-byte form at exactly the boundary', () => {
    const value = new Uint8Array(0xff).fill(1);
    const input = new Uint8Array([0x03, 0xff, 0x00, 0xff, ...value]);
    expect(decodeTlvs(input)[0]!.value).toHaveLength(0xff);
  });

  it('rejects a value that runs past the data area', () => {
    expectNfcError(() => decodeTlvs(bytes(0x03, 0x05, 0xaa)), 'ndefMalformed', 'TLV 0x3 value');
  });

  it('rejects a block with a tag but no length byte', () => {
    expectNfcError(() => decodeTlvs(bytes(0x03)), 'ndefMalformed', 'TLV length');
  });
});

describe('findNdefMessageTlv', () => {
  it('finds the NDEF block past the control blocks', () => {
    const found = findNdefMessageTlv(
      bytes(0x01, 0x03, 0xa0, 0x0c, 0x34, 0x03, 0x02, 0xaa, 0xbb, 0xfe),
    );
    expect(Array.from(found!)).toEqual([0xaa, 0xbb]);
  });

  it('returns undefined when the tag is formatted but holds no NDEF block', () => {
    // Distinct from holding an empty message: the caller may want to write
    // rather than report a read failure.
    expect(findNdefMessageTlv(bytes(0x01, 0x03, 0xa0, 0x0c, 0x34, 0xfe))).toBeUndefined();
  });

  it('returns undefined for a blank data area', () => {
    expect(findNdefMessageTlv(bytes(0x00, 0x00, 0xfe))).toBeUndefined();
  });

  it('recovers a real NDEF message written through the TLV layer', () => {
    // This is the round trip that matters: feeding a Type 2 data area straight
    // to the message decoder fails, because the first byte is a TLV tag.
    const message = encodeMessage([createTextRecord('hola', { languageCode: 'es' })]);
    const area = encodeNdefTlv(message);

    expect(Array.from(findNdefMessageTlv(area)!)).toEqual(Array.from(message));
  });
});

describe('encodeNdefTlv', () => {
  it('wraps a short message and appends a terminator', () => {
    expect(Array.from(encodeNdefTlv(bytes(0xaa, 0xbb)))).toEqual([0x03, 0x02, 0xaa, 0xbb, 0xfe]);
  });

  it('omits the terminator when asked', () => {
    // For a message that fills the data area exactly, with no byte to spare.
    expect(Array.from(encodeNdefTlv(bytes(0xaa), { terminator: false }))).toEqual([
      0x03, 0x01, 0xaa,
    ]);
  });

  it('wraps an empty message', () => {
    expect(Array.from(encodeNdefTlv(bytes()))).toEqual([0x03, 0x00, 0xfe]);
  });

  it('uses the 1-byte length form just below the boundary', () => {
    const encoded = encodeNdefTlv(new Uint8Array(0xfe));
    expect(encoded[1]).toBe(0xfe);
    expect(encoded).toHaveLength(0xfe + 3);
  });

  it('switches to the 3-byte form at the boundary', () => {
    const encoded = encodeNdefTlv(new Uint8Array(0xff));

    expect(encoded[1]).toBe(0xff);
    expect(encoded[2]).toBe(0x00);
    expect(encoded[3]).toBe(0xff);
    expect(encoded).toHaveLength(0xff + 5);
  });

  it('rejects a message longer than a TLV can hold', () => {
    expectNfcError(
      () => encodeNdefTlv(new Uint8Array(MAX_TLV_LENGTH + 1)),
      'invalidArgument',
      'a TLV can hold at most',
    );
  });

  it.each([1, 2, 0xfe, 0xff, 0x100, 1000])('round-trips a %s-byte message', (size) => {
    const message = new Uint8Array(size).fill(0x5a);
    expect(Array.from(findNdefMessageTlv(encodeNdefTlv(message))!)).toEqual(Array.from(message));
  });
});
