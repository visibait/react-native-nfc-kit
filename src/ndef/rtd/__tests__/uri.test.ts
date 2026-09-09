import { NfcError } from '../../../errors';
import { utf8Encode } from '../../bytes';
import { decodeMessage, encodeMessage } from '../../message';
import { Tnf, createRecord } from '../../record';
import { URI_PREFIXES } from '../../uriPrefixes';
import { createUriRecord, decodeUriRecord, isUriRecord } from '../uri';
import { WellKnownType, isWellKnownRecord, wellKnownTypeBytes } from '../wellKnown';

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

function rawUriRecord(...payload: number[]) {
  return createRecord({
    tnf: Tnf.WellKnown,
    type: utf8Encode('U'),
    payload: new Uint8Array(payload),
  });
}

describe('isUriRecord', () => {
  it('recognises a URI record', () => {
    expect(isUriRecord(createUriRecord('https://example.com'))).toBe(true);
  });

  it('rejects a Text record', () => {
    expect(isUriRecord(createRecord({ tnf: Tnf.WellKnown, type: utf8Encode('T') }))).toBe(false);
  });
});

describe('createUriRecord', () => {
  it('abbreviates the prefix by default', () => {
    const record = createUriRecord('https://example.com');

    // 0x04 = "https://", then the remainder in UTF-8.
    expect(record.payload[0]).toBe(0x04);
    expect(record.payload).toHaveLength(1 + 'example.com'.length);
  });

  it('picks the longest prefix, saving the most bytes', () => {
    expect(createUriRecord('https://www.example.com').payload[0]).toBe(0x02);
  });

  it('writes the URI verbatim when abbreviation is disabled', () => {
    const record = createUriRecord('https://example.com', { noPrefixAbbreviation: true });

    expect(record.payload[0]).toBe(0x00);
    expect(record.payload).toHaveLength(1 + 'https://example.com'.length);
  });

  it('produces a smaller payload with abbreviation than without', () => {
    const uri = 'https://www.example.com/some/path';
    const abbreviated = createUriRecord(uri).payload.length;
    const verbatim = createUriRecord(uri, { noPrefixAbbreviation: true }).payload.length;

    expect(abbreviated).toBe(verbatim - 'https://www.'.length);
  });

  it('carries an optional record ID', () => {
    const record = createUriRecord('tel:+34600000000', { id: new Uint8Array([1, 2]) });
    expect(Array.from(record.id)).toEqual([1, 2]);
  });

  it('leaves the ID empty when none is given', () => {
    expect(createUriRecord('tel:123').id).toHaveLength(0);
  });

  it('rejects an empty URI', () => {
    expectNfcError(() => createUriRecord(''), 'invalidArgument', 'cannot be empty');
  });

  it('handles a URI that is exactly a prefix', () => {
    const record = createUriRecord('urn:nfc:');
    expect(record.payload[0]).toBe(0x23);
    expect(record.payload).toHaveLength(1);
  });
});

describe('decodeUriRecord', () => {
  it.each([
    'https://example.com',
    'https://www.example.com/path?query=1#hash',
    'http://example.com',
    'tel:+34600000000',
    'mailto:someone@example.com',
    'file:///tmp/thing',
    'urn:epc:id:sgtin:0614141.112345.400',
    'urn:nfc:ext:example.com:thing',
    'custom-scheme://no-prefix-match',
    'https://example.com/café',
  ])('round-trips %s', (uri) => {
    expect(decodeUriRecord(createUriRecord(uri)).uri).toBe(uri);
  });

  it.each([false, true])('round-trips with noPrefixAbbreviation=%s', (noPrefixAbbreviation) => {
    const uri = 'https://www.example.com/x';
    expect(decodeUriRecord(createUriRecord(uri, { noPrefixAbbreviation })).uri).toBe(uri);
  });

  it('reports the stored prefix identifier', () => {
    expect(decodeUriRecord(createUriRecord('https://example.com')).prefixCode).toBe(0x04);
  });

  it('round-trips through a full NDEF message', () => {
    const records = decodeMessage(encodeMessage([createUriRecord('https://ventry.es')]));
    expect(decodeUriRecord(records[0]!).uri).toBe('https://ventry.es');
  });

  it('round-trips every prefix in the table', () => {
    URI_PREFIXES.forEach((prefix) => {
      const uri = `${prefix}tail`;
      expect(decodeUriRecord(createUriRecord(uri)).uri).toBe(uri);
    });
  });

  it('decodes a reserved prefix identifier as an unabbreviated URI', () => {
    // 0xff is reserved. Yielding the remainder is more useful than refusing to
    // read a tag written against a later revision of the table.
    const record = rawUriRecord(0xff, 0x61, 0x62);
    expect(decodeUriRecord(record)).toEqual({ uri: 'ab', prefixCode: 0xff });
  });

  it('decodes a payload holding only a prefix identifier', () => {
    expect(decodeUriRecord(rawUriRecord(0x05)).uri).toBe('tel:');
  });

  it('rejects a record that is not a URI record', () => {
    expectNfcError(
      () => decodeUriRecord(createRecord({ tnf: Tnf.WellKnown, type: utf8Encode('T') })),
      'invalidArgument',
      'not a well-known URI record',
    );
  });

  it('rejects an empty payload', () => {
    expectNfcError(() => decodeUriRecord(rawUriRecord()), 'ndefMalformed', 'prefix identifier');
  });
});

describe('wellKnown helpers', () => {
  it('exposes the specified type names', () => {
    expect(WellKnownType).toEqual({
      Text: 'T',
      Uri: 'U',
      SmartPoster: 'Sp',
      Signature: 'Sig',
      HandoverCarrier: 'Hc',
      HandoverRequest: 'Hr',
      HandoverSelect: 'Hs',
      AlternativeCarrier: 'ac',
      CollisionResolution: 'cr',
      GenericControl: 'Gc',
    });
  });

  it('returns a fresh array each call, so a caller cannot corrupt a shared constant', () => {
    const first = wellKnownTypeBytes('T');
    const second = wellKnownTypeBytes('T');

    expect(first).not.toBe(second);
    first[0] = 0x00;
    expect(second[0]).toBe(0x54);
  });

  it('matches a multi-character type name', () => {
    const record = createRecord({ tnf: Tnf.WellKnown, type: wellKnownTypeBytes('Sp') });

    expect(isWellKnownRecord(record, 'Sp')).toBe(true);
    expect(isWellKnownRecord(record, 'S')).toBe(false);
  });
});
