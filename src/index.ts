/**
 * react-native-nfc-kit
 *
 * The reader and session API lands in M2 (Android) and M3 (iOS). What is
 * available today is the NDEF codec and the shared error type, both of which are
 * pure TypeScript and usable on their own.
 *
 * For the codec, prefer the dedicated entry point -- it pulls in nothing else:
 *
 * ```ts
 * import { encodeMessage, createUriRecord } from 'react-native-nfc-kit/ndef';
 * ```
 */

export { NfcError } from './errors.js';
export type { NfcErrorCode, NfcErrorInit, NfcPlatform } from './errors.js';
