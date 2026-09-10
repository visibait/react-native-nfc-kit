/**
 * NDEF codec: `react-native-nfc-kit/ndef`
 *
 * Everything here is plain TypeScript over `Uint8Array`. There is no native
 * module, no React Native import, and nothing platform-specific -- a lint rule
 * enforces that. So this entry point works in a bundler, in Node and on the web,
 * and it is unit tested at 100% branch coverage rather than on a device.
 *
 * ```ts
 * import { createTextRecord, createUriRecord, encodeMessage } from 'react-native-nfc-kit/ndef';
 *
 * const bytes = encodeMessage([
 *   createUriRecord('https://ventry.es'),
 *   createTextRecord('Entrada general', { languageCode: 'es' }),
 * ]);
 * ```
 *
 * Reading goes the other way, narrowing each record before decoding it:
 *
 * ```ts
 * import { decodeMessage, isTextRecord, decodeTextRecord } from 'react-native-nfc-kit/ndef';
 *
 * for (const record of decodeMessage(bytes)) {
 *   if (isTextRecord(record)) {
 *     console.log(decodeTextRecord(record).text);
 *   }
 * }
 * ```
 *
 * Layers, from the bytes up:
 *
 * - `bytes`      -- `Uint8Array` helpers, hex, UTF-8 and UTF-16, reader/writer
 * - `record`     -- a single NDEF record: header flags, TNF, type, ID, payload
 * - `message`    -- a sequence of records, with chunk reassembly and framing rules
 * - `rtd/*`      -- the record types themselves: Text, URI, MIME, external, Smart Poster
 * - `tlv`        -- Type 2 tag framing, which wraps a message in tag memory
 * - `ccFile`     -- Type 4 capability container, which says where the message lives
 */

/* -------------------------------------------------------------------------- */
/* Bytes                                                                      */
/* -------------------------------------------------------------------------- */

export {
  ByteReader,
  ByteWriter,
  EMPTY_BYTES,
  bytesEqual,
  concatBytes,
  fromHex,
  toBytes,
  toHex,
  utf16Decode,
  utf16Encode,
  utf8Decode,
  utf8Encode,
} from './bytes.js';

/* -------------------------------------------------------------------------- */
/* Records and messages                                                       */
/* -------------------------------------------------------------------------- */

export {
  SHORT_RECORD_MAX_PAYLOAD,
  Tnf,
  createEmptyRecord,
  createRecord,
  decodeRecord,
  encodeRecord,
  encodedRecordLength,
  isTnf,
} from './record.js';
export type {
  EncodeRecordOptions,
  NdefRecord,
  NdefRecordInit,
  RawRecord,
  RecordFlags,
} from './record.js';

export { decodeMessage, encodeMessage, encodedMessageLength } from './message.js';
export type { EncodeMessageOptions, NdefMessage } from './message.js';

/* -------------------------------------------------------------------------- */
/* Record types                                                               */
/* -------------------------------------------------------------------------- */

export { WellKnownType, isWellKnownRecord, wellKnownTypeBytes } from './rtd/wellKnown.js';

export {
  MAX_LANGUAGE_CODE_LENGTH,
  createTextRecord,
  decodeTextRecord,
  isTextRecord,
  textStatusHasReservedBit,
} from './rtd/text.js';
export type { CreateTextRecordOptions, TextEncoding, TextRecordContent } from './rtd/text.js';

export { createUriRecord, decodeUriRecord, isUriRecord } from './rtd/uri.js';
export type { CreateUriRecordOptions, UriRecordContent } from './rtd/uri.js';

export {
  MAX_URI_PREFIX_CODE,
  URI_PREFIXES,
  expandUriPrefix,
  findUriPrefix,
} from './uriPrefixes.js';

export {
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
} from './rtd/media.js';
export type {
  CreateMediaRecordOptions,
  ExternalRecordContent,
  MimeRecordContent,
} from './rtd/media.js';

export {
  SmartPosterAction,
  createSmartPosterRecord,
  decodeSmartPosterRecord,
  isSmartPosterRecord,
} from './rtd/smartPoster.js';
export type {
  CreateSmartPosterOptions,
  SmartPosterContent,
  SmartPosterIcon,
  SmartPosterTitle,
} from './rtd/smartPoster.js';

/* -------------------------------------------------------------------------- */
/* Tag-level framing                                                          */
/* -------------------------------------------------------------------------- */

export { MAX_TLV_LENGTH, TlvTag, decodeTlvs, encodeNdefTlv, findNdefMessageTlv } from './tlv.js';
export type { EncodeNdefTlvOptions, Tlv } from './tlv.js';

export {
  DEFAULT_NDEF_FILE_ID,
  MIN_CC_LENGTH,
  NDEF_FILE_CONTROL_TAG,
  decodeCapabilityContainer,
  encodeCapabilityContainer,
} from './ccFile.js';
export type {
  CapabilityContainer,
  CapabilityContainerInit,
  MappingVersion,
  NdefFileControl,
} from './ccFile.js';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

// Re-exported so a consumer using only the codec does not need a second import
// to catch what it throws. It is the same class the rest of the library uses.
export { NfcError } from '../errors.js';
export type { NfcErrorCode, NfcErrorInit, NfcPlatform } from '../errors.js';
