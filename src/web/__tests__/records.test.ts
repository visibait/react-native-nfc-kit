import { NfcError } from '../../errors.js';
import { utf8Encode } from '../../ndef/bytes.js';
import { encodeMessage } from '../../ndef/message.js';
import { Tnf, type NdefRecord } from '../../ndef/record.js';
import {
  createAbsoluteUriRecord,
  createExternalRecord,
  createMimeRecord,
} from '../../ndef/rtd/media.js';
import { createSmartPosterRecord } from '../../ndef/rtd/smartPoster.js';
import { createTextRecord, decodeTextRecord } from '../../ndef/rtd/text.js';
import { createUriRecord, decodeUriRecord } from '../../ndef/rtd/uri.js';
import {
  fromWebRecord,
  fromWebRecords,
  toWebRecord,
  toWebRecords,
  type WebNdefRecord,
  type WebNdefRecordInit,
} from '../records.js';

/** Builds what Web NFC hands over: `data` is a `DataView`, not a `Uint8Array`. */
function webRecord(record: Omit<WebNdefRecord, 'data'> & { data?: Uint8Array }): WebNdefRecord {
  const { data, ...rest } = record;
  return {
    ...rest,
    data: data === undefined ? null : new DataView(data.buffer, data.byteOffset, data.byteLength),
  };
}

function text(value: string): Uint8Array {
  return utf8Encode(value);
}

function expectInvalidArgument(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(NfcError);
  expect((thrown as NfcError).code).toBe('invalidArgument');
}

describe('reading what Web NFC hands over', () => {
  it('rebuilds a text record, status byte and all', () => {
    // The browser reports the decoded text plus a language; the status byte and
    // the language prefix have to be put back or the record is not an NDEF text
    // record at all.
    const record = fromWebRecord(
      webRecord({ recordType: 'text', data: text('Entrada general'), lang: 'es' }),
    );

    expect(record.tnf).toBe(Tnf.WellKnown);
    expect(decodeTextRecord(record)).toMatchObject({
      text: 'Entrada general',
      languageCode: 'es',
      encoding: 'utf-8',
    });
  });

  it('rebuilds a UTF-16 text record as UTF-16', () => {
    // Rebuilding it as UTF-8 would leave a status byte that contradicts the
    // payload, which a reader resolves by showing nonsense.
    const record = fromWebRecord(
      webRecord({ recordType: 'text', data: text('hola'), lang: 'es', encoding: 'utf-16' }),
    );

    expect(decodeTextRecord(record).encoding).toBe('utf-16');
  });

  it('defaults the language when the browser reports none', () => {
    const record = fromWebRecord(webRecord({ recordType: 'text', data: text('hi') }));

    expect(decodeTextRecord(record).languageCode).toBe('en');
  });

  it('rebuilds a URL record, applying the prefix table', () => {
    // Web NFC gives the whole URL; the wire format stores a prefix index.
    const record = fromWebRecord(
      webRecord({ recordType: 'url', data: text('https://www.ventry.es/entrada') }),
    );

    expect(decodeUriRecord(record).uri).toBe('https://www.ventry.es/entrada');
    // The prefix really was applied rather than the URL stored whole.
    expect(record.payload.length).toBeLessThan('https://www.ventry.es/entrada'.length);
  });

  it('rebuilds an absolute URI into the type field, where it belongs', () => {
    const record = fromWebRecord(
      webRecord({ recordType: 'absolute-url', data: text('urn:epc:id:sgtin:1.2.3') }),
    );

    expect(record.tnf).toBe(Tnf.AbsoluteUri);
    expect(record.payload).toHaveLength(0);
  });

  it('rebuilds a MIME record', () => {
    const record = fromWebRecord(
      webRecord({
        recordType: 'mime',
        mediaType: 'application/vnd.ventry.ticket',
        data: new Uint8Array([1, 2, 3]),
      }),
    );

    expect(record.tnf).toBe(Tnf.MimeMedia);
    expect(record.payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('falls back to an opaque media type when the browser reports none', () => {
    const record = fromWebRecord(webRecord({ recordType: 'mime', data: new Uint8Array([9]) }));

    expect(record.tnf).toBe(Tnf.MimeMedia);
  });

  it('rebuilds an empty record', () => {
    const record = fromWebRecord(webRecord({ recordType: 'empty' }));

    expect(record).toEqual({
      tnf: Tnf.Empty,
      type: new Uint8Array(),
      id: new Uint8Array(),
      payload: new Uint8Array(),
    });
  });

  it('rebuilds an unknown record without inventing a type', () => {
    const record = fromWebRecord(
      webRecord({ recordType: 'unknown', data: new Uint8Array([0xaa]) }),
    );

    expect(record.tnf).toBe(Tnf.Unknown);
    expect(record.type).toHaveLength(0);
    expect(record.payload).toEqual(new Uint8Array([0xaa]));
  });

  it('rebuilds an external record', () => {
    const record = fromWebRecord(
      webRecord({ recordType: 'android.com:pkg', data: text('es.ventry.app') }),
    );

    expect(record.tnf).toBe(Tnf.ExternalType);
  });

  it('rebuilds a local type without its colon', () => {
    // Web NFC spells these `:act`; on the wire the type is `act`.
    const record = fromWebRecord(webRecord({ recordType: ':act', data: new Uint8Array([0x00]) }));

    expect(record.tnf).toBe(Tnf.WellKnown);
    expect(record.type).toEqual(text('act'));
  });

  it('rebuilds a smart poster from its nested records', () => {
    const record = fromWebRecord({
      recordType: 'smart-poster',
      toRecords: () => [
        webRecord({ recordType: 'url', data: text('https://ventry.es') }),
        webRecord({ recordType: 'text', data: text('Entrada'), lang: 'es' }),
      ],
    });

    // A smart poster's payload is an encoded message, which is exactly what the
    // nested records become.
    expect(record.tnf).toBe(Tnf.WellKnown);
    expect(record.type).toEqual(text('Sp'));
    expect(record.payload.length).toBeGreaterThan(0);
  });

  it('treats a smart poster with no nested records as an empty message', () => {
    const record = fromWebRecord({ recordType: 'smart-poster' });

    expect(record.payload).toEqual(encodeMessage([]));
  });

  it('carries the record id across as UTF-8', () => {
    const record = fromWebRecord(webRecord({ recordType: 'unknown', id: 'r1' }));

    expect(record.id).toEqual(text('r1'));
  });

  it('refuses a record type it cannot interpret', () => {
    // Reading it as bytes would be a guess about what it means.
    expectInvalidArgument(() => fromWebRecord(webRecord({ recordType: 'something-new' })));
  });

  it('rebuilds a whole message', () => {
    const records = fromWebRecords([
      webRecord({ recordType: 'url', data: text('https://ventry.es') }),
      webRecord({ recordType: 'text', data: text('hi'), lang: 'en' }),
    ]);

    expect(records).toHaveLength(2);
  });
});

describe('writing through Web NFC', () => {
  it('turns a text record back into what the browser expects', () => {
    const init = toWebRecord(createTextRecord('Entrada', { languageCode: 'es' }));

    expect(init).toEqual({
      recordType: 'text',
      data: 'Entrada',
      lang: 'es',
      encoding: 'utf-8',
    });
  });

  it('turns a URI record back into a whole URL', () => {
    const init = toWebRecord(createUriRecord('https://www.ventry.es/entrada'));

    expect(init).toEqual({ recordType: 'url', data: 'https://www.ventry.es/entrada' });
  });

  it('puts an absolute URI back where Web NFC expects it', () => {
    const init = toWebRecord(createAbsoluteUriRecord('urn:epc:id:sgtin:1.2.3'));

    expect(init).toEqual({ recordType: 'absolute-url', data: 'urn:epc:id:sgtin:1.2.3' });
  });

  it('turns a MIME record back with its media type', () => {
    const init = toWebRecord(createMimeRecord('text/plain', text('hi')));

    expect(init.recordType).toBe('mime');
    expect(init.mediaType).toBe('text/plain');
  });

  it('turns an external record back into its namespaced type', () => {
    const init = toWebRecord(createExternalRecord('android.com:pkg', text('es.ventry.app')));

    expect(init.recordType).toBe('android.com:pkg');
  });

  it('turns a well-known type Web NFC has no name for into a local type', () => {
    const record: NdefRecord = {
      tnf: Tnf.WellKnown,
      type: text('act'),
      id: new Uint8Array(),
      payload: new Uint8Array([0x00]),
    };

    expect(toWebRecord(record).recordType).toBe(':act');
  });

  it('turns an empty and an unknown record back', () => {
    expect(
      toWebRecord({
        tnf: Tnf.Empty,
        type: new Uint8Array(),
        id: new Uint8Array(),
        payload: new Uint8Array(),
      }),
    ).toEqual({
      recordType: 'empty',
    });
    expect(
      toWebRecord({
        tnf: Tnf.Unknown,
        type: new Uint8Array(),
        id: new Uint8Array(),
        payload: new Uint8Array([1]),
      }).recordType,
    ).toBe('unknown');
  });

  it('carries a record id back', () => {
    const record: NdefRecord = {
      tnf: Tnf.Unknown,
      type: new Uint8Array(),
      id: text('r1'),
      payload: new Uint8Array(),
    };

    expect(toWebRecord(record).id).toBe('r1');
  });

  it('refuses a smart poster rather than writing something else', () => {
    // Web NFC's write API builds records itself and cannot express a nested
    // message. Writing the outer record with the payload as opaque bytes would
    // produce a tag readers interpret differently.
    expectInvalidArgument(() =>
      toWebRecord(createSmartPosterRecord('https://ventry.es', { titles: [{ text: 'Entrada' }] })),
    );
  });

  it('refuses a chunk continuation, which cannot appear in a message anyway', () => {
    expectInvalidArgument(() =>
      toWebRecord({
        tnf: Tnf.Unchanged,
        type: new Uint8Array(),
        id: new Uint8Array(),
        payload: new Uint8Array(),
      }),
    );
  });

  it('converts a whole encoded message', () => {
    const message = encodeMessage([
      createUriRecord('https://ventry.es'),
      createTextRecord('hi', { languageCode: 'en' }),
    ]);

    expect(toWebRecords(message).map((init) => init.recordType)).toEqual(['url', 'text']);
  });
});

describe('round-tripping between the two shapes', () => {
  /**
   * The pairing is the real test. A browser never shows the bytes on the tag, so
   * the only way to know the mapping is faithful is to send a record through both
   * directions and compare it with itself.
   */
  const cases: { name: string; record: NdefRecord }[] = [
    { name: 'text', record: createTextRecord('Entrada general', { languageCode: 'es' }) },
    {
      name: 'UTF-16 text',
      record: createTextRecord('hola', { languageCode: 'es', encoding: 'utf-16' }),
    },
    { name: 'a URL with a known prefix', record: createUriRecord('https://www.ventry.es/e') },
    { name: 'a URL with no prefix', record: createUriRecord('ventry://entrada') },
    { name: 'an absolute URI', record: createAbsoluteUriRecord('urn:epc:id:sgtin:1.2.3') },
    { name: 'MIME', record: createMimeRecord('application/json', text('{}')) },
    { name: 'external', record: createExternalRecord('ventry.es:ticket', text('abc')) },
    {
      name: 'unknown',
      record: {
        tnf: Tnf.Unknown,
        type: new Uint8Array(),
        id: new Uint8Array(),
        payload: new Uint8Array([1, 2, 3]),
      },
    },
    {
      name: 'empty',
      record: {
        tnf: Tnf.Empty,
        type: new Uint8Array(),
        id: new Uint8Array(),
        payload: new Uint8Array(),
      },
    },
  ];

  /** Turns a write-shaped record back into a read-shaped one, as a browser would. */
  function asBrowserWouldReport(init: WebNdefRecordInit): WebNdefRecord {
    const data =
      typeof init.data === 'string'
        ? utf8Encode(init.data)
        : init.data instanceof Uint8Array
          ? init.data
          : undefined;

    return webRecord({
      recordType: init.recordType,
      ...(init.mediaType === undefined ? {} : { mediaType: init.mediaType }),
      ...(init.id === undefined ? {} : { id: init.id }),
      ...(init.encoding === undefined ? {} : { encoding: init.encoding }),
      ...(init.lang === undefined ? {} : { lang: init.lang }),
      ...(data === undefined ? {} : { data }),
    });
  }

  it.each(cases)('$name survives both directions', ({ record }) => {
    expect(fromWebRecord(asBrowserWouldReport(toWebRecord(record)))).toEqual(record);
  });

  it('keeps a record id through both directions', () => {
    const record: NdefRecord = { ...createTextRecord('hi'), id: text('r1') };

    expect(fromWebRecord(asBrowserWouldReport(toWebRecord(record)))).toEqual(record);
  });
});
