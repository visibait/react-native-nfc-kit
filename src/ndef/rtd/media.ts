/**
 * Records whose type is not an NFC Forum well-known type: MIME media
 * (TNF 0x02), absolute URI (TNF 0x03) and external types (TNF 0x04).
 *
 * These are how applications put their own data on a tag. The external type is
 * the one to reach for by default: it is namespaced by a domain you control, so
 * it cannot collide with another app's records the way a bare MIME type can.
 */

import { utf8Decode, utf8Encode } from '../bytes.js';
import { invalidArgument } from '../../errors.js';
import { Tnf, createRecord, type NdefRecord } from '../record.js';

export interface CreateMediaRecordOptions {
  id?: Uint8Array;
}

/* -------------------------------------------------------------------------- */
/* MIME media (TNF 0x02)                                                      */
/* -------------------------------------------------------------------------- */

export interface MimeRecordContent {
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/**
 * Whether `record` carries MIME media, optionally of a specific type.
 *
 * The comparison is case-insensitive because RFC 2046 defines media types that
 * way, and real tags contain both `image/PNG` and `image/png`.
 */
export function isMimeRecord(record: NdefRecord, mimeType?: string): boolean {
  if (record.tnf !== Tnf.MimeMedia) {
    return false;
  }
  if (mimeType === undefined) {
    return true;
  }
  return utf8Decode(record.type).toLowerCase() === mimeType.toLowerCase();
}

export function createMimeRecord(
  mimeType: string,
  data: Uint8Array,
  options: CreateMediaRecordOptions = {},
): NdefRecord {
  if (mimeType.length === 0) {
    throw invalidArgument('MIME type cannot be empty.');
  }
  if (!mimeType.includes('/')) {
    throw invalidArgument(`MIME type "${mimeType}" is not of the form "type/subtype".`);
  }

  const type = utf8Encode(mimeType);
  return createRecord(
    options.id === undefined
      ? { tnf: Tnf.MimeMedia, type, payload: data }
      : { tnf: Tnf.MimeMedia, type, payload: data, id: options.id },
  );
}

export function decodeMimeRecord(record: NdefRecord): MimeRecordContent {
  if (!isMimeRecord(record)) {
    throw invalidArgument('Record is not a MIME media record (TNF 0x02).');
  }
  return { mimeType: utf8Decode(record.type), data: record.payload };
}

/* -------------------------------------------------------------------------- */
/* Absolute URI (TNF 0x03)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * An absolute-URI record keeps the URI in the *type* field, not the payload.
 *
 * That surprises almost everyone, and it is why a well-known URI record
 * (TNF 0x01, type `U`) is the right choice for "this tag points at a link".
 * This one exists for the rare reader that requires it.
 */
export function isAbsoluteUriRecord(record: NdefRecord): boolean {
  return record.tnf === Tnf.AbsoluteUri;
}

export function createAbsoluteUriRecord(
  uri: string,
  options: CreateMediaRecordOptions = {},
): NdefRecord {
  if (uri.length === 0) {
    throw invalidArgument('URI cannot be empty.');
  }

  const type = utf8Encode(uri);
  return createRecord(
    options.id === undefined
      ? { tnf: Tnf.AbsoluteUri, type }
      : { tnf: Tnf.AbsoluteUri, type, id: options.id },
  );
}

export function decodeAbsoluteUriRecord(record: NdefRecord): string {
  if (!isAbsoluteUriRecord(record)) {
    throw invalidArgument('Record is not an absolute URI record (TNF 0x03).');
  }
  return utf8Decode(record.type);
}

/* -------------------------------------------------------------------------- */
/* External type (TNF 0x04)                                                   */
/* -------------------------------------------------------------------------- */

export interface ExternalRecordContent {
  /** The full `domain:type` name, lowercased as the specification requires. */
  readonly type: string;
  readonly data: Uint8Array;
}

/**
 * Android surfaces an external record as the URI
 * `vnd.android.nfc://ext/<domain>:<type>`, so the name chosen here is what an
 * intent filter has to match.
 */
export function isExternalRecord(record: NdefRecord, type?: string): boolean {
  if (record.tnf !== Tnf.ExternalType) {
    return false;
  }
  if (type === undefined) {
    return true;
  }
  return utf8Decode(record.type) === type.toLowerCase();
}

/**
 * Creates an external record.
 *
 * The name is lowercased because the specification defines external type names
 * as case-insensitive and stored in lower case; writing mixed case produces a
 * tag that some readers match and others do not.
 */
export function createExternalRecord(
  type: string,
  data: Uint8Array,
  options: CreateMediaRecordOptions = {},
): NdefRecord {
  if (!/^[^:\s]+:[^:\s]+$/.test(type)) {
    throw invalidArgument(
      `External type "${type}" must be of the form "domain:name", e.g. "example.com:thing".`,
    );
  }

  const typeBytes = utf8Encode(type.toLowerCase());
  return createRecord(
    options.id === undefined
      ? { tnf: Tnf.ExternalType, type: typeBytes, payload: data }
      : { tnf: Tnf.ExternalType, type: typeBytes, payload: data, id: options.id },
  );
}

export function decodeExternalRecord(record: NdefRecord): ExternalRecordContent {
  if (!isExternalRecord(record)) {
    throw invalidArgument('Record is not an external type record (TNF 0x04).');
  }
  return { type: utf8Decode(record.type), data: record.payload };
}

/** External type name Android reserves for the Android Application Record. */
export const ANDROID_APPLICATION_RECORD_TYPE = 'android.com:pkg';

/**
 * Creates an Android Application Record (AAR).
 *
 * An AAR overrides Android's normal intent dispatch: the named package wins the
 * tag regardless of which other apps declare a matching intent filter, and if it
 * is not installed the Play Store opens instead. It is the reliable way to stop
 * another NFC app from intercepting your tags.
 *
 * iOS ignores AARs entirely, so include one only as a supplementary record.
 */
export function createAndroidApplicationRecord(packageName: string): NdefRecord {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    throw invalidArgument(
      `"${packageName}" is not a valid Android package name, e.g. "es.ventry.checkin".`,
    );
  }

  return createRecord({
    tnf: Tnf.ExternalType,
    type: utf8Encode(ANDROID_APPLICATION_RECORD_TYPE),
    payload: utf8Encode(packageName),
  });
}

/** Whether `record` is an Android Application Record, and for which package. */
export function decodeAndroidApplicationRecord(record: NdefRecord): string {
  if (!isExternalRecord(record, ANDROID_APPLICATION_RECORD_TYPE)) {
    throw invalidArgument('Record is not an Android Application Record.');
  }
  return utf8Decode(record.payload);
}
