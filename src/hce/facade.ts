/**
 * The card-emulation facade, bound to the real native module.
 *
 * Separate from the barrel so it is measured by the coverage gate: a thin
 * delegation is exactly where calling the wrong function hides, and an `index.ts`
 * is excluded from coverage on the assumption that it only re-exports.
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
