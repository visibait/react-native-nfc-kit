/**
 * Translating between Web NFC's records and NDEF records.
 *
 * Web NFC does not hand over an NDEF message; it hands over records it has already
 * interpreted. A text record arrives as `{ recordType: 'text', data, lang,
 * encoding }` rather than as a status byte followed by a language code, and a URL
 * arrives whole rather than as a prefix index plus a remainder. So a shim cannot
 * simply pass bytes along: it has to rebuild the records the rest of this library
 * works with, and rebuild Web NFC's shape again in order to write.
 *
 * Both directions are here, and they are tested against each other. That pairing
 * is the point: a browser is the one platform where the bytes on the tag are never
 * visible, so the only way to know the mapping is right is to round-trip it.
 *
 * Where the mapping is not faithful, this refuses rather than guessing. A record
 * type that cannot be represented on one side would otherwise be written to a tag
 * as something a reader interprets differently, which is worse than an error at
 * the point of the call.
 */

import { invalidArgument } from '../errors.js';
import { bytesEqual, utf8Decode, utf8Encode } from '../ndef/bytes.js';
import { decodeMessage, encodeMessage } from '../ndef/message.js';
import { Tnf, type NdefRecord } from '../ndef/record.js';
import {
  createAbsoluteUriRecord,
  createExternalRecord,
  createMimeRecord,
} from '../ndef/rtd/media.js';
import { createTextRecord, decodeTextRecord, isTextRecord } from '../ndef/rtd/text.js';
import { createUriRecord, decodeUriRecord, isUriRecord } from '../ndef/rtd/uri.js';
import { WellKnownType, wellKnownTypeBytes } from '../ndef/rtd/wellKnown.js';

/* -------------------------------------------------------------------------- */
/* Web NFC's own shapes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The parts of Web NFC's `NDEFRecord` this shim reads.
 *
 * Declared here rather than taken from `lib.dom`, which does not carry Web NFC:
 * it is not on a standards track every browser has adopted, so relying on the
 * ambient types would make this file fail to compile depending on the consumer's
 * TypeScript version.
 */
export interface WebNdefRecord {
  readonly recordType: string;
  readonly mediaType?: string | null;
  readonly id?: string | null;
  readonly data?: DataView | null;
  readonly encoding?: string | null;
  readonly lang?: string | null;
  /** Nested records, for a smart poster. */
  toRecords?: () => WebNdefRecord[];
}

/** What `NDEFReader.write` accepts for one record. */
export interface WebNdefRecordInit {
  recordType: string;
  mediaType?: string;
  id?: string;
  data?: ArrayBufferView | ArrayBuffer | string;
  encoding?: string;
  lang?: string;
}

function dataBytes(record: WebNdefRecord): Uint8Array {
  const view = record.data;
  if (view === undefined || view === null) {
    return new Uint8Array();
  }
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/* -------------------------------------------------------------------------- */
/* Web NFC -> NDEF                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A local type, e.g. `:act` inside a smart poster.
 *
 * Web NFC spells these with a leading colon; on the wire they are well-known
 * records whose type is the name without it.
 */
function isLocalType(recordType: string): boolean {
  return recordType.startsWith(':');
}

/** An external type, e.g. `android.com:pkg`. */
function isExternalType(recordType: string): boolean {
  return !isLocalType(recordType) && recordType.includes(':');
}

/**
 * Rebuilds one NDEF record from what Web NFC reported.
 *
 * The `id` deserves a note: Web NFC exposes it as a string, and the NDEF ID field
 * is bytes. Treating it as UTF-8 is the only available reading, and it is what
 * Chrome does in the other direction, so a round trip through a browser is stable
 * even though an ID holding arbitrary bytes could not survive the trip.
 */
export function fromWebRecord(record: WebNdefRecord): NdefRecord {
  const id = record.id ? utf8Encode(record.id) : undefined;
  const withId = <T extends NdefRecord>(built: T): NdefRecord =>
    id === undefined ? built : { ...built, id };

  switch (record.recordType) {
    case 'empty':
      return {
        tnf: Tnf.Empty,
        type: new Uint8Array(),
        id: new Uint8Array(),
        payload: new Uint8Array(),
      };

    case 'text': {
      const text = utf8Decode(dataBytes(record));
      // Web NFC reports the encoding it found; a UTF-16 record has to be rebuilt
      // as UTF-16 or the status byte would contradict the payload.
      const encoding =
        record.encoding === 'utf-16' || record.encoding === 'utf-16be' ? 'utf-16' : 'utf-8';
      return withId(
        createTextRecord(text, {
          languageCode: record.lang ?? 'en',
          encoding,
        }),
      );
    }

    case 'url':
      return withId(createUriRecord(utf8Decode(dataBytes(record))));

    case 'absolute-url':
      return withId(createAbsoluteUriRecord(utf8Decode(dataBytes(record))));

    case 'mime':
      return withId(
        createMimeRecord(record.mediaType ?? 'application/octet-stream', dataBytes(record)),
      );

    case 'smart-poster': {
      // The nested records are the payload, so they are encoded as a message --
      // which is exactly what a smart poster's payload is on the wire.
      const nested = record.toRecords?.() ?? [];
      return withId({
        tnf: Tnf.WellKnown,
        type: wellKnownTypeBytes(WellKnownType.SmartPoster),
        id: new Uint8Array(),
        payload: encodeMessage(nested.map(fromWebRecord)),
      });
    }

    case 'unknown':
      return withId({
        tnf: Tnf.Unknown,
        type: new Uint8Array(),
        id: new Uint8Array(),
        payload: dataBytes(record),
      });

    default:
      break;
  }

  if (isLocalType(record.recordType)) {
    return withId({
      tnf: Tnf.WellKnown,
      type: utf8Encode(record.recordType.slice(1)),
      id: new Uint8Array(),
      payload: dataBytes(record),
    });
  }

  if (isExternalType(record.recordType)) {
    return withId(createExternalRecord(record.recordType, dataBytes(record)));
  }

  throw invalidArgument(
    `Web NFC reported a record type this library does not recognise: "${record.recordType}". ` +
      'Reading it as bytes would be a guess about what it means.',
  );
}

/** Rebuilds a whole message. */
export function fromWebRecords(records: readonly WebNdefRecord[]): NdefRecord[] {
  return records.map(fromWebRecord);
}

/* -------------------------------------------------------------------------- */
/* NDEF -> Web NFC                                                            */
/* -------------------------------------------------------------------------- */

const SMART_POSTER_TYPE = wellKnownTypeBytes(WellKnownType.SmartPoster);

/**
 * Turns one record into what `NDEFReader.write` accepts.
 *
 * Web NFC has no way to express a raw record: `write` takes types it understands
 * and builds the bytes itself. So anything outside its vocabulary cannot be
 * written from a browser at all, and saying so is better than sending a record a
 * reader would interpret as something else.
 */
export function toWebRecord(record: NdefRecord): WebNdefRecordInit {
  const id = record.id.length > 0 ? { id: utf8Decode(record.id) } : {};

  switch (record.tnf) {
    case Tnf.Empty:
      return { recordType: 'empty' };

    case Tnf.WellKnown: {
      if (isTextRecord(record)) {
        const { text, languageCode, encoding } = decodeTextRecord(record);
        return { recordType: 'text', data: text, lang: languageCode, encoding, ...id };
      }
      if (isUriRecord(record)) {
        return { recordType: 'url', data: decodeUriRecord(record).uri, ...id };
      }
      if (bytesEqual(record.type, SMART_POSTER_TYPE)) {
        // Chrome accepts nested records only through an NDEFMessageInit, which
        // `write` does not take per record, so this is genuinely out of reach.
        throw invalidArgument(
          'Web NFC cannot write a smart poster: its write API builds records itself and has no ' +
            'way to express a nested message. Write the URL and the title as separate records, ' +
            'or write this tag from a native platform.',
        );
      }
      return {
        recordType: `:${utf8Decode(record.type)}`,
        data: record.payload,
        ...id,
      };
    }

    case Tnf.MimeMedia:
      return {
        recordType: 'mime',
        mediaType: utf8Decode(record.type),
        data: record.payload,
        ...id,
      };

    case Tnf.AbsoluteUri:
      // The URI lives in the type field for this TNF, which is the part that
      // catches people out.
      return { recordType: 'absolute-url', data: utf8Decode(record.type), ...id };

    case Tnf.ExternalType:
      return { recordType: utf8Decode(record.type), data: record.payload, ...id };

    case Tnf.Unknown:
      return { recordType: 'unknown', data: record.payload, ...id };

    default:
      throw invalidArgument(
        `Web NFC cannot write a record with TNF 0x${record.tnf.toString(16).padStart(2, '0')}. ` +
          'Reserved and chunk-continuation records have no Web NFC equivalent.',
      );
  }
}

/** Turns encoded message bytes into what `NDEFReader.write` accepts. */
export function toWebRecords(message: Uint8Array): WebNdefRecordInit[] {
  return decodeMessage(message).map(toWebRecord);
}
