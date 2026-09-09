/**
 * NFC Forum Text RTD (`T`).
 *
 * Payload layout:
 *
 * ```
 * +--------+------------------+--------------------+
 * | status | language code    | text               |
 * | 1 byte | 1..63 bytes      | rest of payload    |
 * +--------+------------------+--------------------+
 *
 * status: bit 7 = 0 for UTF-8, 1 for UTF-16
 *         bit 6 = RFU, shall be 0
 *         bits 5..0 = language code length
 * ```
 *
 * UTF-16 support is the part usually missing. The library this replaces carries
 * a `// TODO need to deal with UTF in the future` and simply mis-decodes any tag
 * with bit 7 set -- which is every text tag written by a number of Windows and
 * Java stacks.
 */

import { ByteWriter, utf16Decode, utf16Encode, utf8Decode, utf8Encode } from '../bytes.js';
import { invalidArgument, ndefMalformed } from '../../errors.js';
import { Tnf, createRecord, type NdefRecord } from '../record.js';
import { WellKnownType, isWellKnownRecord, wellKnownTypeBytes } from './wellKnown.js';

const STATUS_UTF16 = 0x80;
const STATUS_RFU = 0x40;
const STATUS_LANGUAGE_LENGTH = 0x3f;

/** Maximum language code length the 6-bit status field can express. */
export const MAX_LANGUAGE_CODE_LENGTH = STATUS_LANGUAGE_LENGTH;

export type TextEncoding = 'utf-8' | 'utf-16';

export interface TextRecordContent {
  readonly text: string;
  /** IANA language code as it appeared on the tag, e.g. `en` or `en-US`. */
  readonly languageCode: string;
  /** Which encoding the payload actually used. */
  readonly encoding: TextEncoding;
}

export interface CreateTextRecordOptions {
  /** IANA language code. Defaults to `en`. */
  languageCode?: string;
  /**
   * Payload encoding. Defaults to `utf-8`, which is both smaller and more
   * widely handled; choose `utf-16` only when a specific reader requires it.
   */
  encoding?: TextEncoding;
  /** Optional NDEF record ID. */
  id?: Uint8Array;
}

/** Whether `record` is a well-known Text record. */
export function isTextRecord(record: NdefRecord): boolean {
  return isWellKnownRecord(record, WellKnownType.Text);
}

export function createTextRecord(text: string, options: CreateTextRecordOptions = {}): NdefRecord {
  const languageCode = options.languageCode ?? 'en';
  const encoding = options.encoding ?? 'utf-8';

  const languageBytes = utf8Encode(languageCode);
  if (languageBytes.length === 0) {
    throw invalidArgument('Language code cannot be empty.');
  }
  if (languageBytes.length > MAX_LANGUAGE_CODE_LENGTH) {
    throw invalidArgument(
      `Language code "${languageCode}" encodes to ${languageBytes.length} bytes; ` +
        `the status byte can express at most ${MAX_LANGUAGE_CODE_LENGTH}.`,
    );
  }
  if (!/^[A-Za-z0-9-]+$/.test(languageCode)) {
    throw invalidArgument(
      `Language code "${languageCode}" is not a valid IANA code; expected letters, digits and hyphens.`,
    );
  }

  const textBytes = encoding === 'utf-16' ? utf16Encode(text) : utf8Encode(text);

  // The RFU bit is never set on output, even though it is tolerated on input.
  const status = (encoding === 'utf-16' ? STATUS_UTF16 : 0) | languageBytes.length;

  const writer = new ByteWriter(1 + languageBytes.length + textBytes.length);
  writer.u8(status).bytes(languageBytes).bytes(textBytes);

  return createRecord(
    options.id === undefined
      ? {
          tnf: Tnf.WellKnown,
          type: wellKnownTypeBytes(WellKnownType.Text),
          payload: writer.toBytes(),
        }
      : {
          tnf: Tnf.WellKnown,
          type: wellKnownTypeBytes(WellKnownType.Text),
          payload: writer.toBytes(),
          id: options.id,
        },
  );
}

/**
 * Decodes a Text record's payload.
 *
 * The reserved bit 6 is ignored rather than rejected. The specification says it
 * shall be zero, but a handful of writers set it, and refusing to read those
 * tags would be a worse outcome than tolerating a bit that carries no meaning.
 * Output never sets it -- strict when writing, lenient when reading.
 */
export function decodeTextRecord(record: NdefRecord): TextRecordContent {
  if (!isTextRecord(record)) {
    throw invalidArgument('Record is not a well-known Text record (TNF 0x01, type "T").');
  }

  const { payload } = record;
  if (payload.length === 0) {
    throw ndefMalformed('Text record payload is empty; a status byte is required.');
  }

  const status = payload[0] as number;
  const languageLength = status & STATUS_LANGUAGE_LENGTH;
  const encoding: TextEncoding = (status & STATUS_UTF16) !== 0 ? 'utf-16' : 'utf-8';

  if (1 + languageLength > payload.length) {
    throw ndefMalformed(
      `Text record declares a ${languageLength}-byte language code but only ` +
        `${payload.length - 1} byte(s) follow the status byte.`,
    );
  }

  const languageCode = utf8Decode(payload.subarray(1, 1 + languageLength));
  const textBytes = payload.subarray(1 + languageLength);
  const text = encoding === 'utf-16' ? utf16Decode(textBytes) : utf8Decode(textBytes);

  return { text, languageCode, encoding };
}

/** Whether the reserved bit of a status byte is set. Exposed for diagnostics. */
export function textStatusHasReservedBit(status: number): boolean {
  return (status & STATUS_RFU) !== 0;
}
