/**
 * NFC Forum URI RTD (`U`).
 *
 * Payload layout:
 *
 * ```
 * +-------------------+-------------------------+
 * | prefix identifier | rest of the URI (UTF-8) |
 * | 1 byte            | rest of payload         |
 * +-------------------+-------------------------+
 * ```
 *
 * The prefix identifier indexes the abbreviation table in `../uriPrefixes`.
 */

import { ByteWriter, utf8Decode, utf8Encode } from '../bytes.js';
import { invalidArgument, ndefMalformed } from '../../errors.js';
import { Tnf, createRecord, type NdefRecord } from '../record.js';
import { expandUriPrefix, findUriPrefix } from '../uriPrefixes.js';
import { WellKnownType, isWellKnownRecord, wellKnownTypeBytes } from './wellKnown.js';

export interface CreateUriRecordOptions {
  /**
   * Writes the URI verbatim with prefix identifier 0x00 instead of abbreviating.
   *
   * Only needed for a reader known to mishandle the prefix table. It costs up to
   * 12 bytes on a tag that may only have 144.
   */
  noPrefixAbbreviation?: boolean;
  id?: Uint8Array;
}

export interface UriRecordContent {
  /** The full URI, with the abbreviated prefix expanded. */
  readonly uri: string;
  /** The prefix identifier byte as stored on the tag. */
  readonly prefixCode: number;
}

/** Whether `record` is a well-known URI record. */
export function isUriRecord(record: NdefRecord): boolean {
  return isWellKnownRecord(record, WellKnownType.Uri);
}

export function createUriRecord(uri: string, options: CreateUriRecordOptions = {}): NdefRecord {
  if (uri.length === 0) {
    throw invalidArgument('URI cannot be empty.');
  }

  const { code, rest } =
    options.noPrefixAbbreviation === true ? { code: 0, rest: uri } : findUriPrefix(uri);

  const restBytes = utf8Encode(rest);
  const writer = new ByteWriter(1 + restBytes.length);
  writer.u8(code).bytes(restBytes);

  const payload = writer.toBytes();
  const type = wellKnownTypeBytes(WellKnownType.Uri);

  return createRecord(
    options.id === undefined
      ? { tnf: Tnf.WellKnown, type, payload }
      : { tnf: Tnf.WellKnown, type, payload, id: options.id },
  );
}

/**
 * Decodes a URI record.
 *
 * A prefix identifier outside the defined range expands to nothing rather than
 * raising: the specification reserves those values, so a tag written against a
 * later table revision should still produce a usable URI.
 */
export function decodeUriRecord(record: NdefRecord): UriRecordContent {
  if (!isUriRecord(record)) {
    throw invalidArgument('Record is not a well-known URI record (TNF 0x01, type "U").');
  }

  const { payload } = record;
  if (payload.length === 0) {
    throw ndefMalformed('URI record payload is empty; a prefix identifier is required.');
  }

  const prefixCode = payload[0] as number;
  const uri = expandUriPrefix(prefixCode) + utf8Decode(payload.subarray(1));

  return { uri, prefixCode };
}
