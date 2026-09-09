import type { ConfigPlugin } from 'expo/config-plugins';
import { withEntitlementsPlist, withInfoPlist } from 'expo/config-plugins';

import { ENTITLEMENT_FORMAT_VALUES, type ResolvedNfcKitProps } from './types';

const READER_FORMATS_KEY = 'com.apple.developer.nfc.readersession.formats';

/**
 * Writes exactly the entitlement formats requested and nothing else.
 *
 * Existing values are preserved and de-duplicated, because another plugin may
 * legitimately have added a format. Values are sorted so the generated
 * entitlements file is stable across runs — otherwise the prebuild snapshot
 * tests would produce spurious diffs.
 */
export const withIosNfcEntitlement: ConfigPlugin<ResolvedNfcKitProps> = (config, props) =>
  withEntitlementsPlist(config, (mod) => {
    const requested = props.ios.formats.map((format) => ENTITLEMENT_FORMAT_VALUES[format]);
    const existing = mod.modResults[READER_FORMATS_KEY];
    const previous = Array.isArray(existing)
      ? existing.filter((v): v is string => typeof v === 'string')
      : [];

    mod.modResults[READER_FORMATS_KEY] = [...new Set([...previous, ...requested])].sort();
    return mod;
  });

/**
 * Sets `NFCReaderUsageDescription`.
 *
 * An empty string here is worse than a missing key: CoreNFC refuses to create a
 * session and the resulting error says nothing about Info.plist. A value the
 * developer explicitly set always wins; the default only fills a genuine gap.
 */
export const withIosNfcUsageDescription: ConfigPlugin<ResolvedNfcKitProps> = (config, props) =>
  withInfoPlist(config, (mod) => {
    const current = mod.modResults.NFCReaderUsageDescription;
    const hasMeaningfulValue = typeof current === 'string' && current.trim().length > 0;

    mod.modResults.NFCReaderUsageDescription = hasMeaningfulValue
      ? current
      : props.readerUsageDescription;
    return mod;
  });

export const withIosNfc: ConfigPlugin<ResolvedNfcKitProps> = (config, props) => {
  let next = withIosNfcEntitlement(config, props);
  next = withIosNfcUsageDescription(next, props);
  return next;
};
