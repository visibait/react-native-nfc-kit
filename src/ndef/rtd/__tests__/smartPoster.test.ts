import { NfcError } from '../../../errors.js';
import { utf8Encode } from '../../bytes.js';
import { decodeMessage, encodeMessage } from '../../message.js';
import { Tnf, createRecord, type NdefRecord } from '../../record.js';
import { createMimeRecord } from '../media.js';
import {
  SmartPosterAction,
  createSmartPosterRecord,
  decodeSmartPosterRecord,
  isSmartPosterRecord,
} from '../smartPoster.js';
import { createTextRecord } from '../text.js';
import { createUriRecord } from '../uri.js';
import { wellKnownTypeBytes } from '../wellKnown.js';

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

/** Wraps inner records in a Smart Poster, bypassing createSmartPosterRecord. */
function rawSmartPoster(inner: readonly NdefRecord[]): NdefRecord {
  return createRecord({
    tnf: Tnf.WellKnown,
    type: wellKnownTypeBytes('Sp'),
    payload: encodeMessage(inner),
  });
}

const iconData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('isSmartPosterRecord', () => {
  it('recognises a Smart Poster', () => {
    expect(isSmartPosterRecord(createSmartPosterRecord('https://example.com'))).toBe(true);
  });

  it('rejects a plain URI record', () => {
    expect(isSmartPosterRecord(createUriRecord('https://example.com'))).toBe(false);
  });
});

describe('createSmartPosterRecord', () => {
  it('nests a complete NDEF message in the payload', () => {
    const record = createSmartPosterRecord('https://example.com');

    // The payload is a message in its own right, with its own MB/ME framing.
    // A decoder built only for flat records mangles this.
    const inner = decodeMessage(record.payload);
    expect(inner).toHaveLength(1);
    expect(Array.from(inner[0]!.type)).toEqual([0x55]);
  });

  it('puts the URI record first', () => {
    const record = createSmartPosterRecord('https://example.com', {
      titles: [{ text: 'Title' }],
    });

    expect(Array.from(decodeMessage(record.payload)[0]!.type)).toEqual([0x55]);
  });

  it('carries an optional record ID', () => {
    const record = createSmartPosterRecord('https://example.com', { id: new Uint8Array([4]) });
    expect(Array.from(record.id)).toEqual([4]);
  });

  it.each([-1, 1.5, 0x1_0000_0000])('rejects the out-of-range size %s', (size) => {
    expectNfcError(
      () => createSmartPosterRecord('https://example.com', { size }),
      'invalidArgument',
      'size must be an integer',
    );
  });

  it('accepts the size boundaries', () => {
    for (const size of [0, 0xffffffff]) {
      expect(
        decodeSmartPosterRecord(createSmartPosterRecord('https://a.example', { size })).size,
      ).toBe(size);
    }
  });

  it('rejects an icon whose MIME type is not an image', () => {
    expectNfcError(
      () =>
        createSmartPosterRecord('https://example.com', {
          icons: [{ mimeType: 'application/pdf', data: iconData }],
        }),
      'invalidArgument',
      'must start with "image/"',
    );
  });
});

describe('decodeSmartPosterRecord', () => {
  it('decodes a URI-only poster', () => {
    const decoded = decodeSmartPosterRecord(createSmartPosterRecord('https://ventry.es'));

    expect(decoded).toEqual({
      uri: 'https://ventry.es',
      titles: [],
      action: undefined,
      size: undefined,
      mimeType: undefined,
      icons: [],
      unknown: [],
    });
  });

  it('round-trips every field', () => {
    const record = createSmartPosterRecord('https://www.example.com/brochure.pdf', {
      titles: [
        { text: 'Brochure', languageCode: 'en' },
        { text: 'Folleto', languageCode: 'es' },
        { text: 'パンフレット', languageCode: 'ja', encoding: 'utf-16' },
      ],
      action: SmartPosterAction.Save,
      size: 1_048_576,
      mimeType: 'application/pdf',
      icons: [{ mimeType: 'image/png', data: iconData }],
    });

    const decoded = decodeSmartPosterRecord(record);

    expect(decoded.uri).toBe('https://www.example.com/brochure.pdf');
    expect(decoded.titles).toHaveLength(3);
    expect(decoded.titles[0]).toEqual({ text: 'Brochure', languageCode: 'en', encoding: 'utf-8' });
    expect(decoded.titles[2]).toEqual({
      text: 'パンフレット',
      languageCode: 'ja',
      encoding: 'utf-16',
    });
    expect(decoded.action).toBe(SmartPosterAction.Save);
    expect(decoded.size).toBe(1_048_576);
    expect(decoded.mimeType).toBe('application/pdf');
    expect(decoded.icons).toHaveLength(1);
    expect(decoded.icons[0]!.mimeType).toBe('image/png');
    expect(Array.from(decoded.icons[0]!.data)).toEqual(Array.from(iconData));
    expect(decoded.unknown).toEqual([]);
  });

  it('survives being nested in an outer message', () => {
    const outer = encodeMessage([
      createSmartPosterRecord('https://example.com', { titles: [{ text: 'Hi' }] }),
      createTextRecord('sibling'),
    ]);
    const records = decodeMessage(outer);

    expect(decodeSmartPosterRecord(records[0]!).titles[0]!.text).toBe('Hi');
  });

  it.each([SmartPosterAction.Execute, SmartPosterAction.Save, SmartPosterAction.Edit])(
    'round-trips action %s',
    (action) => {
      expect(
        decodeSmartPosterRecord(createSmartPosterRecord('https://a.example', { action })).action,
      ).toBe(action);
    },
  );

  it('preserves records it does not recognise instead of dropping them', () => {
    // A poster written against a later revision may carry extra records, and
    // silently discarding them would make a lossy read look complete.
    const extra = createMimeRecord('application/json', utf8Encode('{}'));
    const decoded = decodeSmartPosterRecord(
      rawSmartPoster([createUriRecord('https://a.example'), extra]),
    );

    expect(decoded.unknown).toHaveLength(1);
    expect(Array.from(decoded.unknown[0]!.type)).toEqual(
      Array.from(utf8Encode('application/json')),
    );
  });

  it('treats a non-image MIME record as unknown rather than as an icon', () => {
    const decoded = decodeSmartPosterRecord(
      rawSmartPoster([
        createUriRecord('https://a.example'),
        createMimeRecord('text/csv', new Uint8Array([1])),
      ]),
    );

    expect(decoded.icons).toEqual([]);
    expect(decoded.unknown).toHaveLength(1);
  });

  it('accepts an image MIME type in mixed case as an icon', () => {
    const decoded = decodeSmartPosterRecord(
      rawSmartPoster([
        createUriRecord('https://a.example'),
        createMimeRecord('IMAGE/JPEG', iconData),
      ]),
    );

    expect(decoded.icons).toHaveLength(1);
    expect(decoded.unknown).toEqual([]);
  });

  it('rejects a record that is not a Smart Poster', () => {
    expectNfcError(
      () => decodeSmartPosterRecord(createUriRecord('https://a.example')),
      'invalidArgument',
      'not a well-known Smart Poster record',
    );
  });

  it('rejects a poster with no URI record', () => {
    expectNfcError(
      () => decodeSmartPosterRecord(rawSmartPoster([createTextRecord('orphan title')])),
      'ndefMalformed',
      'contains no URI record',
    );
  });

  it('rejects a poster with more than one URI record', () => {
    expectNfcError(
      () =>
        decodeSmartPosterRecord(
          rawSmartPoster([
            createUriRecord('https://a.example'),
            createUriRecord('https://b.example'),
          ]),
        ),
      'ndefMalformed',
      'more than one URI record',
    );
  });

  it('rejects an action record of the wrong length', () => {
    expectNfcError(
      () =>
        decodeSmartPosterRecord(
          rawSmartPoster([
            createUriRecord('https://a.example'),
            createRecord({
              tnf: Tnf.WellKnown,
              type: wellKnownTypeBytes('act'),
              payload: new Uint8Array([0, 0]),
            }),
          ]),
        ),
      'ndefMalformed',
      'exactly one byte',
    );
  });

  it('rejects a size record of the wrong length', () => {
    expectNfcError(
      () =>
        decodeSmartPosterRecord(
          rawSmartPoster([
            createUriRecord('https://a.example'),
            createRecord({
              tnf: Tnf.WellKnown,
              type: wellKnownTypeBytes('s'),
              payload: new Uint8Array([0, 1]),
            }),
          ]),
        ),
      'ndefMalformed',
      'exactly four bytes',
    );
  });
});
