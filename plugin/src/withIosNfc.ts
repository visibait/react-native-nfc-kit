import type { ConfigPlugin } from 'expo/config-plugins';
import { WarningAggregator, withEntitlementsPlist, withInfoPlist } from 'expo/config-plugins';

import { mergeStringList, normalizeHex, selectIdentifierWarnings } from './iosPlist';
import { ENTITLEMENT_FORMAT_VALUES, type ResolvedProps } from './types';

const READER_FORMATS_KEY = 'com.apple.developer.nfc.readersession.formats';
const SELECT_IDENTIFIERS_KEY = 'com.apple.developer.nfc.readersession.iso7816.select-identifiers';
const FELICA_SYSTEM_CODES_KEY = 'com.apple.developer.nfc.readersession.felica.systemcodes';
const WARNING_TAG = 'react-native-nfc-kit';

/**
 * Writes exactly the entitlement formats requested and nothing else.
 *
 * Existing values are preserved and de-duplicated, because another plugin may
 * legitimately have added a format. Values are sorted so the generated
 * entitlements file is stable across runs — otherwise the prebuild snapshot tests
 * would produce spurious diffs.
 */
export const withIosNfcEntitlement: ConfigPlugin<ResolvedProps> = (config, props) =>
  withEntitlementsPlist(config, (mod) => {
    const requested = props.ios.formats.map((format) => ENTITLEMENT_FORMAT_VALUES[format]);
    mod.modResults[READER_FORMATS_KEY] = mergeStringList(
      mod.modResults[READER_FORMATS_KEY],
      requested,
    );
    return mod;
  });

/**
 * Sets `NFCReaderUsageDescription`.
 *
 * An empty string here is worse than a missing key: CoreNFC refuses to create a
 * session and the resulting error says nothing about Info.plist. A value the
 * developer explicitly set always wins; the default only fills a genuine gap.
 */
export const withIosNfcUsageDescription: ConfigPlugin<ResolvedProps> = (config, props) =>
  withInfoPlist(config, (mod) => {
    const current = mod.modResults.NFCReaderUsageDescription;
    const hasMeaningfulValue = typeof current === 'string' && current.trim().length > 0;

    mod.modResults.NFCReaderUsageDescription = hasMeaningfulValue
      ? current
      : props.readerUsageDescription;
    return mod;
  });

/**
 * Declares the ISO 7816 AIDs and FeliCa system codes the app may talk to.
 *
 * These are not a nicety. iOS filters at the radio: an ISO 7816 tag whose AID is
 * not listed, or a FeliCa card whose system code is not listed, is never handed
 * to the app at all — no error, no event, the tag simply appears not to exist.
 * It is the usual reason a card that works on Android seems unreadable on iOS.
 *
 * Keys are removed rather than written empty when nothing is configured, since an
 * empty array is a declaration that matches nothing rather than an absent one.
 */
export const withIosNfcSelectors: ConfigPlugin<ResolvedProps> = (config, props) =>
  withInfoPlist(config, (mod) => {
    const identifiers = props.ios.selectIdentifiers.map(normalizeHex);
    const systemCodes = props.ios.felicaSystemCodes.map(normalizeHex);

    for (const warning of selectIdentifierWarnings(identifiers)) {
      WarningAggregator.addWarningIOS(WARNING_TAG, warning);
    }

    const merged: [string, string[]][] = [
      [
        SELECT_IDENTIFIERS_KEY,
        mergeStringList(mod.modResults[SELECT_IDENTIFIERS_KEY], identifiers),
      ],
      [
        FELICA_SYSTEM_CODES_KEY,
        mergeStringList(mod.modResults[FELICA_SYSTEM_CODES_KEY], systemCodes),
      ],
    ];

    for (const [key, values] of merged) {
      if (values.length > 0) {
        mod.modResults[key] = values;
      } else {
        delete mod.modResults[key];
      }
    }

    return mod;
  });

export const withIosNfc: ConfigPlugin<ResolvedProps> = (config, props) => {
  let next = withIosNfcEntitlement(config, props);
  next = withIosNfcUsageDescription(next, props);
  next = withIosNfcSelectors(next, props);
  return next;
};
