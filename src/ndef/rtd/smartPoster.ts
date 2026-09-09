/**
 * NFC Forum Smart Poster RTD (`Sp`).
 *
 * A Smart Poster is a composite record: its payload is itself a complete NDEF
 * message holding exactly one URI record plus optional metadata -- localised
 * titles, a recommended action, the size and MIME type of the referred object,
 * and icons.
 *
 * Nesting a message inside a record means the outer record's payload has to be
 * run through the message decoder again, including its own MB/ME framing. That
 * is why a decoder built only for flat records mangles Smart Posters.
 */

import { ByteReader, ByteWriter, utf8Decode } from '../bytes.js';
import { invalidArgument, ndefMalformed } from '../../errors.js';
import { decodeMessage, encodeMessage } from '../message.js';
import { Tnf, createRecord, type NdefRecord } from '../record.js';
import { WellKnownType, isWellKnownRecord, wellKnownTypeBytes } from './wellKnown.js';
import { createMimeRecord, isMimeRecord } from './media.js';
import {
  createTextRecord,
  decodeTextRecord,
  isTextRecord,
  type TextEncoding,
  type TextRecordContent,
} from './text.js';
import { createUriRecord, decodeUriRecord, isUriRecord } from './uri.js';

/** Type names of the metadata records that may appear inside a Smart Poster. */
const ACTION_TYPE = 'act';
const SIZE_TYPE = 's';
const MIME_TYPE_TYPE = 't';

/**
 * What the reader is being asked to do with the URI.
 *
 * A recommendation only -- nothing obliges a reader to honour it, and most
 * phone handlers ignore it.
 */
export const SmartPosterAction = {
  /** Do the action, e.g. open the URI. */
  Execute: 0x00,
  /** Save for later, e.g. bookmark it. */
  Save: 0x01,
  /** Open for editing. */
  Edit: 0x02,
} as const;

export type SmartPosterAction = (typeof SmartPosterAction)[keyof typeof SmartPosterAction];

export interface SmartPosterIcon {
  readonly mimeType: string;
  readonly data: Uint8Array;
}

export interface SmartPosterContent {
  readonly uri: string;
  /** One title per language, in the order they appeared. */
  readonly titles: readonly TextRecordContent[];
  readonly action: SmartPosterAction | undefined;
  /** Size in bytes of the object the URI refers to. */
  readonly size: number | undefined;
  /** MIME type of the object the URI refers to. */
  readonly mimeType: string | undefined;
  readonly icons: readonly SmartPosterIcon[];
  /**
   * Records inside the poster that this decoder did not recognise.
   *
   * Preserved rather than dropped: a Smart Poster written by another stack may
   * carry records from a later revision, and silently discarding them would
   * make a lossy read look like a complete one.
   */
  readonly unknown: readonly NdefRecord[];
}

export interface SmartPosterTitle {
  text: string;
  languageCode?: string;
  encoding?: TextEncoding;
}

export interface CreateSmartPosterOptions {
  titles?: readonly SmartPosterTitle[];
  action?: SmartPosterAction;
  size?: number;
  mimeType?: string;
  icons?: readonly SmartPosterIcon[];
  id?: Uint8Array;
}

/** Whether `record` is a well-known Smart Poster record. */
export function isSmartPosterRecord(record: NdefRecord): boolean {
  return isWellKnownRecord(record, WellKnownType.SmartPoster);
}

export function createSmartPosterRecord(
  uri: string,
  options: CreateSmartPosterOptions = {},
): NdefRecord {
  if (options.size !== undefined) {
    if (!Number.isInteger(options.size) || options.size < 0 || options.size > 0xffffffff) {
      throw invalidArgument(
        `Smart Poster size must be an integer in 0..4294967295, received ${options.size}.`,
      );
    }
  }

  // The URI record comes first by convention; readers that only look at the
  // first record still find the link.
  const inner: NdefRecord[] = [createUriRecord(uri)];

  for (const title of options.titles ?? []) {
    inner.push(
      createTextRecord(title.text, {
        ...(title.languageCode === undefined ? {} : { languageCode: title.languageCode }),
        ...(title.encoding === undefined ? {} : { encoding: title.encoding }),
      }),
    );
  }

  if (options.action !== undefined) {
    inner.push(
      createRecord({
        tnf: Tnf.WellKnown,
        type: wellKnownTypeBytes(ACTION_TYPE),
        payload: new Uint8Array([options.action]),
      }),
    );
  }

  if (options.size !== undefined) {
    inner.push(
      createRecord({
        tnf: Tnf.WellKnown,
        type: wellKnownTypeBytes(SIZE_TYPE),
        payload: new ByteWriter(4).u32be(options.size).toBytes(),
      }),
    );
  }

  if (options.mimeType !== undefined) {
    inner.push(
      createRecord({
        tnf: Tnf.WellKnown,
        type: wellKnownTypeBytes(MIME_TYPE_TYPE),
        payload: wellKnownTypeBytes(options.mimeType),
      }),
    );
  }

  for (const icon of options.icons ?? []) {
    if (!icon.mimeType.toLowerCase().startsWith('image/')) {
      throw invalidArgument(
        `Smart Poster icon MIME type must start with "image/", received "${icon.mimeType}".`,
      );
    }
    inner.push(createMimeRecord(icon.mimeType, icon.data));
  }

  const payload = encodeMessage(inner);
  const type = wellKnownTypeBytes(WellKnownType.SmartPoster);

  return createRecord(
    options.id === undefined
      ? { tnf: Tnf.WellKnown, type, payload }
      : { tnf: Tnf.WellKnown, type, payload, id: options.id },
  );
}

export function decodeSmartPosterRecord(record: NdefRecord): SmartPosterContent {
  if (!isSmartPosterRecord(record)) {
    throw invalidArgument('Record is not a well-known Smart Poster record (TNF 0x01, type "Sp").');
  }

  const inner = decodeMessage(record.payload);

  let uri: string | undefined;
  const titles: TextRecordContent[] = [];
  let action: SmartPosterAction | undefined;
  let size: number | undefined;
  let mimeType: string | undefined;
  const icons: SmartPosterIcon[] = [];
  const unknown: NdefRecord[] = [];

  for (const child of inner) {
    if (isUriRecord(child)) {
      if (uri !== undefined) {
        throw ndefMalformed(
          'Smart Poster contains more than one URI record; exactly one is required.',
        );
      }
      uri = decodeUriRecord(child).uri;
    } else if (isTextRecord(child)) {
      titles.push(decodeTextRecord(child));
    } else if (isWellKnownRecord(child, ACTION_TYPE)) {
      if (child.payload.length !== 1) {
        throw ndefMalformed(
          `Smart Poster action record must hold exactly one byte, found ${child.payload.length}.`,
        );
      }
      action = child.payload[0] as SmartPosterAction;
    } else if (isWellKnownRecord(child, SIZE_TYPE)) {
      if (child.payload.length !== 4) {
        throw ndefMalformed(
          `Smart Poster size record must hold exactly four bytes, found ${child.payload.length}.`,
        );
      }
      size = new ByteReader(child.payload).u32be('Smart Poster size');
    } else if (isWellKnownRecord(child, MIME_TYPE_TYPE)) {
      mimeType = utf8Decode(child.payload);
    } else if (isMimeRecord(child) && utf8Decode(child.type).toLowerCase().startsWith('image/')) {
      icons.push({ mimeType: utf8Decode(child.type), data: child.payload });
    } else {
      unknown.push(child);
    }
  }

  if (uri === undefined) {
    throw ndefMalformed('Smart Poster contains no URI record; exactly one is required.');
  }

  return { uri, titles, action, size, mimeType, icons, unknown };
}
