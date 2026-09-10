/**
 * Card emulation, at `react-native-nfc-kit/hce`.
 *
 * ```tsx
 * import { hce } from 'react-native-nfc-kit/hce';
 * import { createUriRecord, encodeMessage } from 'react-native-nfc-kit/ndef';
 *
 * const session = await hce.emulateNdef(
 *   encodeMessage([createUriRecord('https://www.ventry.es/entrada')]),
 * );
 * // later
 * await session.stop();
 * ```
 *
 * On its own subpath because emulating a card is a different job from reading one,
 * with different setup, a different failure mode, and a platform story that is not
 * the reader story: **this is Android only.** iOS has `CardSession` from 17.4, but
 * it needs an entitlement Apple grants case by case and only works in the EEA, so
 * every call here rejects `unsupportedPlatform` there rather than pretending.
 *
 * `docs/setup/hce.md` covers the manifest and AID configuration, which HCE does
 * not work without.
 */

export { hce } from './facade.js';

export { DEFAULT_HCE_TIMEOUT_MS } from './session.js';
export type {
  EmulateNdefOptions,
  HceOptions,
  HceSession,
  NdefEmulationSession,
  PollingFrame,
  PollingLoopFilter,
} from './session.js';

/* -------------------------------------------------------------------------- */
/* Building responses                                                         */
/* -------------------------------------------------------------------------- */

export {
  Instruction,
  SELECT_BY_FILE_ID,
  SELECT_BY_NAME,
  StatusWord,
  decodeCommandApdu,
  encodeResponseApdu,
  statusResponse,
} from './apdu.js';
export type { IncomingApdu, StatusWordValue } from './apdu.js';

/* -------------------------------------------------------------------------- */
/* The emulated tag                                                           */
/* -------------------------------------------------------------------------- */

export {
  CC_FILE_ID,
  DEFAULT_MAX_READ_SIZE,
  DEFAULT_MAX_WRITE_SIZE,
  NDEF_APPLICATION_AID,
  createType4Card,
} from './type4.js';
export type { Type4Card, Type4CardOptions } from './type4.js';

export { POLLING_FRAME_TYPES } from '../native/contract.js';
export type { HceDeactivationReason, PollingFrameType } from '../native/contract.js';
