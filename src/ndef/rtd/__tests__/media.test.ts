import { NfcError } from '../../../errors.js';
import { utf8Encode } from '../../bytes.js';
import { decodeMessage, encodeMessage } from '../../message.js';
import { Tnf, createRecord } from '../../record.js';
import {
  ANDROID_APPLICATION_RECORD_TYPE,
  createAbsoluteUriRecord,
  createAndroidApplicationRecord,
  createExternalRecord,
  createMimeRecord,
  decodeAbsoluteUriRecord,
  decodeAndroidApplicationRecord,
  decodeExternalRecord,
  decodeMimeRecord,
  isAbsoluteUriRecord,
  isExternalRecord,
  isMimeRecord,
} from '../media.js';

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

const payload = new Uint8Array([1, 2, 3]);

describe('MIME media records', () => {
  it('stores the MIME type in the type field and the bytes in the payload', () => {
    const record = createMimeRecord('application/json', utf8Encode('{"a":1}'));

    expect(record.tnf).toBe(Tnf.MimeMedia);
    expect(Array.from(record.type)).toEqual(Array.from(utf8Encode('application/json')));
    expect(decodeMimeRecord(record).mimeType).toBe('application/json');
  });

  it('round-trips through a full message', () => {
    const records = decodeMessage(encodeMessage([createMimeRecord('image/png', payload)]));
    const decoded = decodeMimeRecord(records[0]!);

    expect(decoded.mimeType).toBe('image/png');
    expect(Array.from(decoded.data)).toEqual([1, 2, 3]);
  });

  it('accepts an empty payload', () => {
    expect(decodeMimeRecord(createMimeRecord('text/plain', new Uint8Array(0))).data).toHaveLength(
      0,
    );
  });

  it('carries an optional record ID', () => {
    const record = createMimeRecord('text/plain', payload, { id: new Uint8Array([7]) });
    expect(Array.from(record.id)).toEqual([7]);
  });

  it('matches the type case-insensitively, as RFC 2046 defines it', () => {
    const record = createMimeRecord('image/PNG', payload);

    expect(isMimeRecord(record, 'image/png')).toBe(true);
    expect(isMimeRecord(record, 'image/jpeg')).toBe(false);
  });

  it('matches any MIME record when no type is given', () => {
    expect(isMimeRecord(createMimeRecord('text/plain', payload))).toBe(true);
  });

  it('does not match a record of another TNF', () => {
    expect(isMimeRecord(createRecord({ tnf: Tnf.WellKnown, type: utf8Encode('T') }))).toBe(false);
    expect(
      isMimeRecord(createRecord({ tnf: Tnf.WellKnown, type: utf8Encode('T') }), 'text/plain'),
    ).toBe(false);
  });

  it('rejects an empty MIME type', () => {
    expectNfcError(() => createMimeRecord('', payload), 'invalidArgument', 'cannot be empty');
  });

  it('rejects a MIME type with no subtype', () => {
    expectNfcError(
      () => createMimeRecord('application', payload),
      'invalidArgument',
      'type/subtype',
    );
  });

  it('rejects decoding a record that is not MIME media', () => {
    expectNfcError(
      () => decodeMimeRecord(createRecord({ tnf: Tnf.WellKnown, type: utf8Encode('T') })),
      'invalidArgument',
      'not a MIME media record',
    );
  });
});

describe('absolute URI records', () => {
  it('keeps the URI in the type field, not the payload', () => {
    // This surprises almost everyone, and is why a well-known URI record is the
    // right choice for an ordinary link.
    const record = createAbsoluteUriRecord('https://example.com/thing');

    expect(record.tnf).toBe(Tnf.AbsoluteUri);
    expect(record.payload).toHaveLength(0);
    expect(decodeAbsoluteUriRecord(record)).toBe('https://example.com/thing');
  });

  it('round-trips through a full message', () => {
    const records = decodeMessage(encodeMessage([createAbsoluteUriRecord('urn:example:1')]));
    expect(decodeAbsoluteUriRecord(records[0]!)).toBe('urn:example:1');
  });

  it('carries an optional record ID', () => {
    const record = createAbsoluteUriRecord('https://a.example', { id: new Uint8Array([3]) });
    expect(Array.from(record.id)).toEqual([3]);
  });

  it('recognises only TNF 0x03', () => {
    expect(isAbsoluteUriRecord(createAbsoluteUriRecord('https://a.example'))).toBe(true);
    expect(isAbsoluteUriRecord(createMimeRecord('text/plain', payload))).toBe(false);
  });

  it('rejects an empty URI', () => {
    expectNfcError(() => createAbsoluteUriRecord(''), 'invalidArgument', 'cannot be empty');
  });

  it('rejects decoding a record of another TNF', () => {
    expectNfcError(
      () => decodeAbsoluteUriRecord(createMimeRecord('text/plain', payload)),
      'invalidArgument',
      'not an absolute URI record',
    );
  });
});

describe('external type records', () => {
  it('stores a namespaced type name', () => {
    const record = createExternalRecord('ventry.es:ticket', payload);

    expect(record.tnf).toBe(Tnf.ExternalType);
    expect(decodeExternalRecord(record).type).toBe('ventry.es:ticket');
    expect(Array.from(decodeExternalRecord(record).data)).toEqual([1, 2, 3]);
  });

  it('lowercases the type name, because the specification defines it that way', () => {
    // Writing mixed case produces a tag some readers match and others do not.
    expect(decodeExternalRecord(createExternalRecord('Ventry.ES:Ticket', payload)).type).toBe(
      'ventry.es:ticket',
    );
  });

  it('matches case-insensitively against a requested name', () => {
    const record = createExternalRecord('ventry.es:ticket', payload);

    expect(isExternalRecord(record, 'VENTRY.ES:TICKET')).toBe(true);
    expect(isExternalRecord(record, 'other.com:thing')).toBe(false);
  });

  it('carries an optional record ID', () => {
    const record = createExternalRecord('a.com:b', payload, { id: new Uint8Array([5]) });
    expect(Array.from(record.id)).toEqual([5]);
  });

  it('leaves the ID empty when none is given', () => {
    expect(createExternalRecord('a.com:b', payload).id).toHaveLength(0);
  });

  it('matches any external record when no name is given', () => {
    expect(isExternalRecord(createExternalRecord('a.com:b', payload))).toBe(true);
  });

  it('does not match a record of another TNF', () => {
    expect(isExternalRecord(createMimeRecord('text/plain', payload))).toBe(false);
    expect(isExternalRecord(createMimeRecord('text/plain', payload), 'a.com:b')).toBe(false);
  });

  it('round-trips through a full message', () => {
    const records = decodeMessage(encodeMessage([createExternalRecord('a.com:b', payload)]));
    expect(decodeExternalRecord(records[0]!).type).toBe('a.com:b');
  });

  it.each(['nocolon', 'a:', ':b', 'a:b:c', 'a b:c', 'a:b c'])(
    'rejects the malformed type name %s',
    (type) => {
      expectNfcError(() => createExternalRecord(type, payload), 'invalidArgument', 'domain:name');
    },
  );

  it('rejects decoding a record of another TNF', () => {
    expectNfcError(
      () => decodeExternalRecord(createMimeRecord('text/plain', payload)),
      'invalidArgument',
      'not an external type record',
    );
  });
});

describe('Android Application Record', () => {
  it('uses the type name Android reserves', () => {
    const record = createAndroidApplicationRecord('es.ventry.checkin');

    expect(ANDROID_APPLICATION_RECORD_TYPE).toBe('android.com:pkg');
    expect(isExternalRecord(record, ANDROID_APPLICATION_RECORD_TYPE)).toBe(true);
    expect(decodeAndroidApplicationRecord(record)).toBe('es.ventry.checkin');
  });

  it('round-trips through a full message', () => {
    const records = decodeMessage(
      encodeMessage([createAndroidApplicationRecord('com.example.app')]),
    );
    expect(decodeAndroidApplicationRecord(records[0]!)).toBe('com.example.app');
  });

  it.each(['nodots', '1bad.start', 'trailing.', '.leading', 'has space.x', 'a..b'])(
    'rejects the invalid package name %s',
    (packageName) => {
      expectNfcError(
        () => createAndroidApplicationRecord(packageName),
        'invalidArgument',
        'valid Android package name',
      );
    },
  );

  it('accepts underscores and digits after the first character of a segment', () => {
    expect(decodeAndroidApplicationRecord(createAndroidApplicationRecord('a_1.b2_c'))).toBe(
      'a_1.b2_c',
    );
  });

  it('rejects decoding an external record that is not an AAR', () => {
    expectNfcError(
      () => decodeAndroidApplicationRecord(createExternalRecord('a.com:b', payload)),
      'invalidArgument',
      'not an Android Application Record',
    );
  });
});
