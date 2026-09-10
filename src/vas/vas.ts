/**
 * Reading an Apple Wallet pass, at `react-native-nfc-kit/vas`.
 *
 * ```ts
 * import { vas } from 'react-native-nfc-kit/vas';
 *
 * const [response] = await vas.read({
 *   configurations: [{ passTypeIdentifier: 'pass.es.ventry.entrada' }],
 *   alertMessage: 'Hold the pass near the phone',
 * });
 * if (response?.statusName === 'success') use(response.vasData);
 * ```
 *
 * This is the merchant side of Value Added Service: the phone acts as the till and
 * asks a nearby iPhone or Watch for a pass of a given type. What comes back is the
 * pass's own data plus a mobile token.
 *
 * **iOS only, and it needs an entitlement Apple grants case by case.** Apple's
 * documentation says so and does not publish the key: *"Using NFCVASReaderSession
 * requires an entitlement from Apple."* When it is granted, Apple provides the key
 * and it appears in the App ID's capabilities — so an app that has been through
 * that process knows what to declare, and one that has not gets
 * `entitlementMissing` the first time it reads. Nothing here can check for it in
 * advance, because there is no API that answers the question.
 *
 * On a separate subpath for the same reason card emulation is: it is a different
 * job with a different setup and a platform story that is not the reader story.
 * `nfc.capabilities.vas` says whether the API and hardware are there.
 *
 * See `docs/setup/vas.md`.
 */

import { NfcError } from '../errors.js';
import { fromHex } from '../ndef/bytes.js';
import {
  VAS_MODES,
  VAS_STATUS,
  type NativeVasResponse,
  type VasMode,
  type VasStatusName,
} from '../native/contract.js';
import { callNative } from '../native/errors.js';
import { getNativeModule, platform } from '../native/module.js';

export { VAS_MODES, VAS_STATUS } from '../native/contract.js';
export type { VasMode, VasStatusName } from '../native/contract.js';

export interface VasConfiguration {
  /**
   * The pass type identifier to ask for, e.g. `pass.es.ventry.entrada`.
   *
   * Yours, from the Apple Developer portal. A pass of any other type is not
   * offered by the phone being read.
   */
  readonly passTypeIdentifier: string;
  /**
   * `normal` asks for the pass's data. `urlOnly` hands the pass a URL instead and
   * asks for nothing back.
   *
   * Defaults to `normal`, which is what reading a pass means.
   */
  readonly mode?: VasMode;
  /** Merchant URL. Required for `urlOnly`, where it is the entire point. */
  readonly url?: string;
}

export interface VasOptions {
  /**
   * The pass types to ask for. At least one.
   *
   * Several are allowed, and the phone answers for whichever it holds — which is
   * how a till that accepts more than one kind of pass is built.
   */
  readonly configurations: readonly VasConfiguration[];
  /** Text shown in the system scanning sheet. */
  readonly alertMessage?: string;
}

export interface VasResponse {
  /**
   * The status word, e.g. `0x9000`.
   *
   * A real APDU status word, the same scheme the rest of this library uses, not a
   * separate set of numbers.
   */
  readonly status: number;
  /** The status word by name. `success` is the only one that carries data. */
  readonly statusName: VasStatusName;
  /** The pass's payload. Empty unless `statusName` is `success`. */
  readonly vasData: Uint8Array;
  /** The token identifying the device that answered. */
  readonly mobileToken: Uint8Array;
}

function deps(): { native: ReturnType<typeof getNativeModule> } {
  return { native: getNativeModule() };
}

function toStatusName(value: string): VasStatusName {
  return value === 'unknown' || value in VAS_STATUS ? (value as VasStatusName) : 'unknown';
}

function toResponse(native: NativeVasResponse): VasResponse {
  return {
    status: native.status,
    statusName: toStatusName(native.statusName),
    vasData: fromHex(native.vasDataHex),
    mobileToken: fromHex(native.mobileTokenHex),
  };
}

function assertValid(options: VasOptions): void {
  if (options.configurations.length === 0) {
    throw new NfcError({
      code: 'invalidArgument',
      message:
        'At least one pass type identifier is required; a session with none would ask the phone ' +
        'for nothing.',
      platform,
    });
  }

  options.configurations.forEach((configuration, index) => {
    const at = `configurations[${index}]`;

    if (configuration.passTypeIdentifier.trim().length === 0) {
      throw new NfcError({
        code: 'invalidArgument',
        message: `${at}.passTypeIdentifier is empty.`,
        platform,
      });
    }
    const mode = configuration.mode ?? 'normal';
    if (!(VAS_MODES as readonly string[]).includes(mode)) {
      throw new NfcError({
        code: 'invalidArgument',
        message: `${at}.mode is "${mode}"; the modes are ${VAS_MODES.join(' and ')}.`,
        platform,
      });
    }
    // Checked here rather than left to CoreNFC, which accepts the configuration
    // and then hands the pass nothing.
    if (mode === 'urlOnly' && configuration.url === undefined) {
      throw new NfcError({
        code: 'invalidArgument',
        message: `${at} uses "urlOnly" without a url; that mode exists to hand one to the pass.`,
        platform,
      });
    }
  });
}

export const vas = {
  /**
   * Whether a Wallet pass can be read on this device.
   *
   * `false` on Android, and on an iPhone that cannot read NFC at all. It does
   * **not** mean the entitlement has been granted: there is no API that answers
   * that, so a read is the only way to find out, and it fails with
   * `entitlementMissing`.
   */
  isSupported(): Promise<boolean> {
    return callNative(platform, 'isVasSupported', () => deps().native.isVasSupported());
  },

  /**
   * Reads a pass, once.
   *
   * Resolves when the phone being read answers, with one response per
   * configuration it matched. Rejects `userCancelled` when the user dismisses the
   * sheet, `systemBusy` when a tag session is already open — iOS allows one reader
   * session at a time — and `entitlementMissing` when Apple has not granted the
   * entitlement for this app.
   */
  async read(options: VasOptions): Promise<VasResponse[]> {
    assertValid(options);

    const responses = await callNative(platform, 'readVas', () =>
      deps().native.readVas({
        configurations: options.configurations.map((configuration) => ({
          mode: configuration.mode ?? 'normal',
          passTypeIdentifier: configuration.passTypeIdentifier,
          url: configuration.url ?? null,
        })),
        alertMessage: options.alertMessage ?? null,
      }),
    );

    return responses.map(toResponse);
  },
};
