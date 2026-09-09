/**
 * Options accepted by the `react-native-nfc-kit` Expo config plugin.
 *
 * Two principles govern this schema, both of them reactions to how the existing
 * ecosystem gets it wrong:
 *
 * 1. **No over-asking.** The iOS reader-session entitlement is requested for the
 *    formats you actually need and nothing more. Asking for `TAG` when the app
 *    only reads NDEF is a permission the user cannot reason about.
 * 2. **Independent switches.** iOS and Android options never share a flag, so
 *    turning one off does not silently turn the other off too.
 */
export interface NfcKitPluginProps {
  /**
   * Value written to `NFCReaderUsageDescription` in Info.plist.
   *
   * iOS requires this key to be present and **non-empty**; session creation
   * fails outright when it is missing, with an error that does not mention
   * Info.plist. A default is supplied so that never happens by accident.
   */
  readerUsageDescription?: string;

  ios?: {
    /**
     * Which values to write to `com.apple.developer.nfc.readersession.formats`.
     *
     * - `'ndef'` — required by `NFCNDEFReaderSession`. Enough for reading and
     *   writing NDEF messages.
     * - `'tag'` — required by `NFCTagReaderSession`, i.e. anything low level:
     *   ISO 7816 APDUs, ISO 15693, FeliCa, MIFARE.
     *
     * Defaults to `['ndef']`.
     */
    formats?: readonly ('ndef' | 'tag')[];
  };

  android?: {
    /**
     * Whether to mark NFC hardware as required in the manifest.
     *
     * Defaults to `false`, which keeps the app installable on devices without
     * an NFC controller. Set to `true` only if the app is useless without NFC —
     * it removes those devices from your Play Store audience.
     */
    requireNfcHardware?: boolean;
  };
}

/** Every option resolved to a concrete value. */
export interface ResolvedNfcKitProps {
  readerUsageDescription: string;
  ios: { formats: readonly ('ndef' | 'tag')[] };
  android: { requireNfcHardware: boolean };
}

export const DEFAULT_READER_USAGE_DESCRIPTION = 'Hold your device near an NFC tag to read it.';

export function resolveProps(props: NfcKitPluginProps | undefined): ResolvedNfcKitProps {
  return {
    readerUsageDescription: props?.readerUsageDescription ?? DEFAULT_READER_USAGE_DESCRIPTION,
    ios: { formats: props?.ios?.formats ?? ['ndef'] },
    android: { requireNfcHardware: props?.android?.requireNfcHardware ?? false },
  };
}

/** Maps the plugin's lowercase format names to Apple's entitlement values. */
export const ENTITLEMENT_FORMAT_VALUES: Record<'ndef' | 'tag', string> = {
  ndef: 'NDEF',
  tag: 'TAG',
};
