/**
 * react-native-nfc-kit
 *
 * ```ts
 * import { nfc } from 'react-native-nfc-kit';
 *
 * const message = await nfc.withTag({ tech: ['ndef'], timeoutMs: 20_000 }, async (tag) => {
 *   if (!tag.is('ndef')) throw new Error('Not an NDEF tag');
 *   return tag.readNdef();
 * });
 * ```
 *
 * Two things to know before reading further:
 *
 * - **A `Tag` carries no technology methods until you narrow it.** `tag.is('ndef')`
 *   is what makes `readNdef` exist. That is how the platform asymmetry stays
 *   visible: on iOS `tag.is('mifareClassic')` is always false, because CoreNFC
 *   cannot reach Crypto-1 at any OS version.
 * - **`withTag` always closes the session.** On success, on a throw, on an abort,
 *   on a timeout, and when the platform ends the session underneath. A leaked
 *   session keeps the iOS sheet up and holds Android's NFC controller exclusively.
 *
 * The NDEF codec is available on its own at `react-native-nfc-kit/ndef` with no
 * native dependency, so it also runs in Node and on the web.
 */

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export { nfc } from './core/nfc.js';
export type {
  NfcAntenna,
  NfcAntennaInfo,
  NfcAvailability,
  NfcCapabilities,
  TagStreamOptions,
} from './core/nfc.js';

export type { BackgroundTagOptions } from './core/background.js';

export type {
  AndroidScanOptions,
  IosScanOptions,
  NextTagOptions,
  NfcSession,
  ScanOptions,
  SessionConfig,
} from './core/session.js';

/* -------------------------------------------------------------------------- */
/* Tags                                                                       */
/* -------------------------------------------------------------------------- */

export type {
  AndroidTagFacet,
  ApduResponse,
  IosTagFacet,
  NdefCapability,
  NdefFormatableCapability,
  NdefStatus,
  IsoDepCapability,
  Tag,
  TagBase,
  TagCapabilities,
  TagOperationOptions,
  TagWith,
  TransceiveCapability,
} from './core/tag.js';

export { TAG_TECH_NAMES, TAG_LOST_REPORTING, isTagTech } from './native/contract.js';
export type { TagLostReporting, TagTech } from './native/contract.js';

/* -------------------------------------------------------------------------- */
/* Errors and subscriptions                                                   */
/* -------------------------------------------------------------------------- */

export { NFC_ERROR_CODES, NfcError, isNfcErrorCode } from './errors.js';
export type { NfcErrorCode, NfcErrorInit, NfcPlatform } from './errors.js';

export type { Subscription } from './core/subscription.js';

/* -------------------------------------------------------------------------- */
/* NDEF                                                                       */
/* -------------------------------------------------------------------------- */

// Re-exported for convenience: reading a tag almost always means building or
// inspecting records. Importing from "react-native-nfc-kit/ndef" instead pulls in
// nothing native, which is what you want on a server or in a pure unit test.
export {
  Tnf,
  createExternalRecord,
  createMimeRecord,
  createSmartPosterRecord,
  createTextRecord,
  createUriRecord,
  decodeMessage,
  decodeSmartPosterRecord,
  decodeTextRecord,
  decodeUriRecord,
  encodeMessage,
  encodedMessageLength,
  isSmartPosterRecord,
  isTextRecord,
  isUriRecord,
  toHex,
  fromHex,
} from './ndef/index.js';

export type { NdefMessage, NdefRecord } from './ndef/index.js';
