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

import { platform, getNativeModule } from '../native/module.js';
import {
  emulateNdef as emulateNdefWith,
  isHceSupported as isHceSupportedWith,
  isObserveModeSupported as isObserveModeSupportedWith,
  startHce as startHceWith,
  type EmulateNdefOptions,
  type HceOptions,
  type HceSession,
  type NdefEmulationSession,
} from './session.js';

function deps(): { native: ReturnType<typeof getNativeModule>; platform: typeof platform } {
  return { native: getNativeModule(), platform };
}

export const hce = {
  /**
   * Whether this device can emulate a card.
   *
   * `false` on iOS, and on Android devices whose controller does not implement
   * host card emulation. Worth checking before showing a "tap to pay" affordance
   * that cannot work.
   */
  isSupported(): Promise<boolean> {
    return isHceSupportedWith(deps());
  },

  /**
   * Whether the card can be held silent while a reader polls.
   *
   * Android 15 and later, and a hardware capability on top of that. This is what
   * makes "notice the reader, ask the user, then answer" possible; without it a
   * card answers the moment it is selected.
   */
  isObserveModeSupported(): Promise<boolean> {
    return isObserveModeSupportedWith(deps());
  },

  /** Starts emulating a card with your own command handler. */
  start(options: HceOptions): Promise<HceSession> {
    return startHceWith(deps(), options);
  },

  /** Emulates an NDEF tag, which is what most apps want. */
  emulateNdef(message: Uint8Array, options?: EmulateNdefOptions): Promise<NdefEmulationSession> {
    return emulateNdefWith(deps(), message, options);
  },
};

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
