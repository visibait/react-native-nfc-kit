import { WarningAggregator } from 'expo/config-plugins';

import {
  DISPATCH_NFC_MESSAGE_PERMISSION,
  NDEF_DISCOVERED_ACTION,
  TECH_DISCOVERED_ACTION,
} from '../androidManifest';
import { DEFAULT_READER_USAGE_DESCRIPTION } from '../types';
import { intentFilterActions, introspectAsync } from './introspect';

const READER_FORMATS = 'com.apple.developer.nfc.readersession.formats';
const SELECT_IDENTIFIERS = 'com.apple.developer.nfc.readersession.iso7816.select-identifiers';
const FELICA_SYSTEM_CODES = 'com.apple.developer.nfc.readersession.felica.systemcodes';

const LAUNCHER_ACTION = 'android.intent.action.MAIN';

/**
 * Warnings are captured rather than printed.
 *
 * Several cases below deliberately provoke one, and a warning shouted into the
 * test output for a case the suite is asserting about is noise that trains you to
 * ignore the real ones.
 */
let androidWarnings: jest.SpyInstance;
let iosWarnings: jest.SpyInstance;

beforeEach(() => {
  androidWarnings = jest.spyOn(WarningAggregator, 'addWarningAndroid').mockImplementation(() => {});
  iosWarnings = jest.spyOn(WarningAggregator, 'addWarningIOS').mockImplementation(() => {});
});

afterEach(() => {
  androidWarnings.mockRestore();
  iosWarnings.mockRestore();
});

describe('the plugin applied end to end', () => {
  describe('with no options at all', () => {
    it('produces a project that can open a session and read a tag', async () => {
      const { manifest, mainActivity, infoPlist, entitlements } = await introspectAsync();

      // Everything reader mode needs, and nothing more.
      const permissions = (manifest.manifest['uses-permission'] ?? []).map(
        (item) => item.$['android:name'],
      );
      expect(permissions).toContain('android.permission.NFC');

      const features = manifest.manifest['uses-feature'] ?? [];
      expect(features).toContainEqual({
        $: { 'android:name': 'android.hardware.nfc', 'android:required': 'false' },
      });

      expect(mainActivity.$['android:launchMode']).toBe('singleTop');
      expect(entitlements[READER_FORMATS]).toEqual(['TAG']);
      expect(infoPlist.NFCReaderUsageDescription).toBe(DEFAULT_READER_USAGE_DESCRIPTION);
    });

    it('adds no intent filter, because reader mode receives no intents', async () => {
      const { mainActivity } = await introspectAsync();

      expect(intentFilterActions(mainActivity)).toEqual([[LAUNCHER_ACTION]]);
      expect(mainActivity['meta-data']).toBeUndefined();
    });

    it('leaves out the AID and system-code keys rather than writing them empty', async () => {
      const { infoPlist } = await introspectAsync();

      // An empty array is a declaration that matches nothing, which is not the
      // same thing as not having declared anything.
      expect(infoPlist).not.toHaveProperty(SELECT_IDENTIFIERS);
      expect(infoPlist).not.toHaveProperty(FELICA_SYSTEM_CODES);
    });

    it('does not protect the activity, since there is nothing to dispatch to it', async () => {
      const { mainActivity } = await introspectAsync();

      expect(mainActivity.$['android:permission']).toBeUndefined();
    });
  });

  describe('with background reading configured', () => {
    it('adds one filter per NDEF entry and keeps the launcher filter', async () => {
      const { mainActivity } = await introspectAsync({
        android: {
          backgroundReading: {
            ndef: [{ mimeType: 'application/vnd.ventry.ticket' }, { scheme: 'ventry' }],
          },
        },
      });

      expect(intentFilterActions(mainActivity)).toEqual([
        [LAUNCHER_ACTION],
        [NDEF_DISCOVERED_ACTION],
        [NDEF_DISCOVERED_ACTION],
      ]);

      const data = (mainActivity['intent-filter'] ?? []).map((filter) => filter.data);
      expect(data[1]).toEqual([{ $: { 'android:mimeType': 'application/vnd.ventry.ticket' } }]);
      expect(data[2]).toEqual([{ $: { 'android:scheme': 'ventry' } }]);
    });

    it('adds the tech filter together with the meta-data that points at it', async () => {
      const { mainActivity } = await introspectAsync({
        android: { backgroundReading: { techLists: [['isoDep']] } },
      });

      expect(intentFilterActions(mainActivity)).toEqual([
        [LAUNCHER_ACTION],
        [TECH_DISCOVERED_ACTION],
      ]);
      expect(mainActivity['meta-data']).toEqual([
        {
          $: {
            'android:name': TECH_DISCOVERED_ACTION,
            'android:resource': '@xml/nfc_kit_tech_filter',
          },
        },
      ]);
    });
  });

  describe('the DISPATCH_NFC_MESSAGE permission', () => {
    const backgroundReading = { ndef: [{ mimeType: 'text/plain' }] };

    it('is applied when the project targets API 37', async () => {
      const { mainActivity } = await introspectAsync(
        { android: { backgroundReading } },
        { plugins: [['expo-build-properties', { android: { targetSdkVersion: 37 } }]] },
      );

      expect(mainActivity.$['android:permission']).toBe(DISPATCH_NFC_MESSAGE_PERMISSION);
    });

    it('is not applied when the project targets API 36', async () => {
      const { mainActivity } = await introspectAsync(
        { android: { backgroundReading } },
        { plugins: [['expo-build-properties', { android: { targetSdkVersion: 36 } }]] },
      );

      expect(mainActivity.$['android:permission']).toBeUndefined();
    });

    it('warns instead of guessing when the target SDK is unknown', async () => {
      const { mainActivity } = await introspectAsync({ android: { backgroundReading } });

      expect(mainActivity.$['android:permission']).toBeUndefined();
      expect(androidWarnings).toHaveBeenCalledWith(
        'react-native-nfc-kit',
        expect.stringContaining('DISPATCH_NFC_MESSAGE'),
      );
    });

    it('can be forced on without background reading', async () => {
      const { mainActivity } = await introspectAsync({
        android: { dispatchNfcMessagePermission: true },
      });

      expect(mainActivity.$['android:permission']).toBe(DISPATCH_NFC_MESSAGE_PERMISSION);
    });
  });

  describe('the iOS selectors', () => {
    it('writes AIDs and system codes uppercased and sorted', async () => {
      const { infoPlist } = await introspectAsync({
        ios: {
          selectIdentifiers: ['a0000002471001', 'D2760000850100'],
          felicaSystemCodes: ['12fc', 'ffff'],
        },
      });

      expect(infoPlist[SELECT_IDENTIFIERS]).toEqual(['A0000002471001', 'D2760000850100']);
      expect(infoPlist[FELICA_SYSTEM_CODES]).toEqual(['12FC', 'FFFF']);
    });

    it('warns when the NDEF application AID is declared', async () => {
      await introspectAsync({ ios: { selectIdentifiers: ['D2760000850101'] } });

      expect(iosWarnings).toHaveBeenCalledWith(
        'react-native-nfc-kit',
        expect.stringContaining('D2760000850101'),
      );
    });

    it('says nothing about an ordinary AID', async () => {
      await introspectAsync({ ios: { selectIdentifiers: ['A0000002471001'] } });

      expect(iosWarnings).not.toHaveBeenCalled();
    });
  });

  describe('options the developer set by hand', () => {
    it('keeps an existing usage description rather than overwriting it', async () => {
      const { infoPlist } = await introspectAsync(undefined, {
        ios: { infoPlist: { NFCReaderUsageDescription: 'Tap your season pass.' } },
      });

      expect(infoPlist.NFCReaderUsageDescription).toBe('Tap your season pass.');
    });

    it('replaces a blank usage description, which iOS treats as missing', async () => {
      const { infoPlist } = await introspectAsync(undefined, {
        ios: { infoPlist: { NFCReaderUsageDescription: '   ' } },
      });

      expect(infoPlist.NFCReaderUsageDescription).toBe(DEFAULT_READER_USAGE_DESCRIPTION);
    });

    it('marks NFC hardware as required only when asked', async () => {
      const { manifest } = await introspectAsync({ android: { requireNfcHardware: true } });

      expect(manifest.manifest['uses-feature']).toContainEqual({
        $: { 'android:name': 'android.hardware.nfc', 'android:required': 'true' },
      });
    });
  });
});
