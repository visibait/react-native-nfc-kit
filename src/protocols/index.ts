/**
 * Tag protocols: `react-native-nfc-kit/protocols`
 *
 * Everything here is plain TypeScript over `Uint8Array`, built on a single
 * `transceive` primitive. There is no native module and no React Native import --
 * a lint rule enforces that -- so these layers are unit tested at 100% branch
 * coverage rather than on a device, and they work in Node and on the web too.
 *
 * That is the point of the split: the native side does one thing, which is move
 * bytes to and from a tag, and everything that can be reasoned about in software
 * lives here where it can be tested properly.
 *
 * ```ts
 * import { nfc } from 'react-native-nfc-kit';
 * import { sendApdu, selectByName } from 'react-native-nfc-kit/protocols';
 *
 * await nfc.withTag({ tech: ['isoDep'] }, async (tag) => {
 *   if (!tag.is('isoDep')) throw new Error('Not an ISO-DEP tag');
 *
 *   const transport = (apdu: Uint8Array) => tag.transceive(apdu);
 *   const selected = await sendApdu(transport, selectByName(aid));
 *   if (!selected.ok) throw new Error(describeStatusWord(selected.status));
 * });
 * ```
 */

export {
  CLA_CHAINING,
  EXTENDED_MAX_LC,
  EXTENDED_MAX_LE,
  SHORT_MAX_LC,
  SHORT_MAX_LE,
  SW_SUCCESS,
  decodeResponseApdu,
  describeStatusWord,
  encodeCommandApdu,
  readBinary,
  selectByFileId,
  selectByName,
  sendApdu,
  sendApduChained,
  updateBinary,
} from './iso7816.js';

export {
  PACK_SIZE,
  PAGES_PER_READ,
  PAGE_SIZE,
  PASSWORD_SIZE,
  READ_SIZE,
  compatibilityWritePage,
  fastRead,
  getVersion,
  passwordAuthenticate,
  read,
  readCounter,
  readPages,
  readSignature,
  storageBytesFor,
  writePage,
  writePages,
} from './ultralight.js';

export type { TagVersion, UltralightTransport } from './ultralight.js';

export type {
  ApduTransport,
  CommandApdu,
  EncodeApduOptions,
  ResponseApdu,
  SendApduChainedOptions,
  SendApduOptions,
} from './iso7816.js';
