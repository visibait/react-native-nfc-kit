import { NfcError } from '../../../errors.js';
import { utf8Encode } from '../../bytes.js';
import { decodeMessage, encodeMessage } from '../../message.js';
import { Tnf, createRecord } from '../../record.js';
import {
  MAX_LANGUAGE_CODE_LENGTH,
  createTextRecord,
  decodeTextRecord,
  isTextRecord,
  textStatusHasReservedBit,
} from '../text.js';

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

/** Builds a Text record from a raw payload, bypassing createTextRecord. */
function rawTextRecord(...payload: number[]) {
  return createRecord({
    tnf: Tnf.WellKnown,
    type: utf8Encode('T'),
    payload: new Uint8Array(payload),
  });
}

describe('isTextRecord', () => {
  it('recognises a Text record', () => {
    expect(isTextRecord(createTextRecord('hello'))).toBe(true);
  });

  it('rejects a well-known record of another type', () => {
    expect(isTextRecord(createRecord({ tnf: Tnf.WellKnown, type: utf8Encode('U') }))).toBe(false);
  });

  it('rejects a record with the right type but the wrong TNF', () => {
    expect(isTextRecord(createRecord({ tnf: Tnf.MimeMedia, type: utf8Encode('T') }))).toBe(false);
  });
});

describe('createTextRecord', () => {
  it('defaults to English and UTF-8', () => {
    const record = createTextRecord('hi');

    // 0x02 = UTF-8, language code length 2; then "en", then "hi".
    expect(Array.from(record.payload)).toEqual([0x02, 0x65, 0x6e, 0x68, 0x69]);
    expect(Array.from(record.type)).toEqual([0x54]);
    expect(record.tnf).toBe(Tnf.WellKnown);
  });

  it('honours an explicit language code', () => {
    const record = createTextRecord('hola', { languageCode: 'es' });
    expect(decodeTextRecord(record).languageCode).toBe('es');
  });

  it('accepts a regional language code', () => {
    expect(decodeTextRecord(createTextRecord('x', { languageCode: 'en-US' })).languageCode).toBe(
      'en-US',
    );
  });

  it('sets bit 7 of the status byte for UTF-16', () => {
    const record = createTextRecord('hi', { encoding: 'utf-16' });
    expect(record.payload[0]! & 0x80).toBe(0x80);
  });

  it('never sets the reserved bit', () => {
    for (const encoding of ['utf-8', 'utf-16'] as const) {
      const record = createTextRecord('x', { encoding });
      expect(textStatusHasReservedBit(record.payload[0] as number)).toBe(false);
    }
  });

  it('carries an optional record ID', () => {
    const record = createTextRecord('x', { id: new Uint8Array([0x09]) });
    expect(Array.from(record.id)).toEqual([0x09]);
  });

  it('leaves the ID empty when none is given', () => {
    expect(createTextRecord('x').id).toHaveLength(0);
  });

  it('rejects an empty language code', () => {
    expectNfcError(
      () => createTextRecord('x', { languageCode: '' }),
      'invalidArgument',
      'cannot be empty',
    );
  });

  it('rejects a language code longer than the status field can express', () => {
    expectNfcError(
      () => createTextRecord('x', { languageCode: 'a'.repeat(MAX_LANGUAGE_CODE_LENGTH + 1) }),
      'invalidArgument',
      'at most 63',
    );
  });

  it('accepts a language code at exactly the limit', () => {
    const languageCode = 'a'.repeat(MAX_LANGUAGE_CODE_LENGTH);
    expect(decodeTextRecord(createTextRecord('x', { languageCode })).languageCode).toBe(
      languageCode,
    );
  });

  it('rejects a language code with invalid characters', () => {
    expectNfcError(
      () => createTextRecord('x', { languageCode: 'en_US' }),
      'invalidArgument',
      'not a valid IANA code',
    );
  });

  it('encodes an empty string', () => {
    expect(decodeTextRecord(createTextRecord('')).text).toBe('');
  });
});

describe('decodeTextRecord', () => {
  it.each([
    ['ASCII', 'Hello, world'],
    ['accented Latin', 'Café con leche'],
    ['CJK', '日本語のテキスト'],
    ['emoji', 'contactless \u{1F4B3} payment'],
    ['empty', ''],
  ])('round-trips %s as UTF-8', (_label, text) => {
    const decoded = decodeTextRecord(createTextRecord(text));
    expect(decoded.text).toBe(text);
    expect(decoded.encoding).toBe('utf-8');
  });

  it.each([
    ['ASCII', 'Hello, world'],
    ['accented Latin', 'Café con leche'],
    ['CJK', '日本語のテキスト'],
    ['empty', ''],
  ])('round-trips %s as UTF-16', (_label, text) => {
    // This is the path the library being replaced never implemented: it carries
    // a '// TODO need to deal with UTF in the future' and mis-decodes any tag
    // written with bit 7 set.
    const decoded = decodeTextRecord(createTextRecord(text, { encoding: 'utf-16' }));
    expect(decoded.text).toBe(text);
    expect(decoded.encoding).toBe('utf-16');
  });

  it('survives a full message encode and decode', () => {
    const message = encodeMessage([
      createTextRecord('primero', { languageCode: 'es' }),
      createTextRecord('second', { languageCode: 'en' }),
    ]);
    const records = decodeMessage(message);

    expect(decodeTextRecord(records[0]!).text).toBe('primero');
    expect(decodeTextRecord(records[1]!).languageCode).toBe('en');
  });

  it('tolerates the reserved bit rather than refusing to read the tag', () => {
    // The specification says bit 6 shall be zero, but some writers set it.
    // Refusing those tags would be worse than ignoring a bit that means nothing.
    const record = rawTextRecord(0x42, 0x65, 0x6e, 0x68, 0x69);

    expect(textStatusHasReservedBit(0x42)).toBe(true);
    expect(decodeTextRecord(record)).toEqual({
      text: 'hi',
      languageCode: 'en',
      encoding: 'utf-8',
    });
  });

  it('handles a zero-length language code', () => {
    expect(decodeTextRecord(rawTextRecord(0x00, 0x68, 0x69))).toEqual({
      text: 'hi',
      languageCode: '',
      encoding: 'utf-8',
    });
  });

  it('rejects a record that is not a Text record', () => {
    expectNfcError(
      () => decodeTextRecord(createRecord({ tnf: Tnf.WellKnown, type: utf8Encode('U') })),
      'invalidArgument',
      'not a well-known Text record',
    );
  });

  it('rejects an empty payload', () => {
    expectNfcError(() => decodeTextRecord(rawTextRecord()), 'ndefMalformed', 'status byte');
  });

  it('rejects a language code length that runs past the payload', () => {
    expectNfcError(
      () => decodeTextRecord(rawTextRecord(0x05, 0x65, 0x6e)),
      'ndefMalformed',
      'declares a 5-byte language code',
    );
  });

  it('rejects a UTF-16 payload with an odd byte count', () => {
    // 0x82 = UTF-16, language length 2. "en" then a single trailing byte.
    expectNfcError(
      () => decodeTextRecord(rawTextRecord(0x82, 0x65, 0x6e, 0x00)),
      'ndefMalformed',
      'odd byte length',
    );
  });
});

describe('textStatusHasReservedBit', () => {
  it('is true only when bit 6 is set', () => {
    expect(textStatusHasReservedBit(0x40)).toBe(true);
    expect(textStatusHasReservedBit(0x00)).toBe(false);
    expect(textStatusHasReservedBit(0x80)).toBe(false);
  });
});
