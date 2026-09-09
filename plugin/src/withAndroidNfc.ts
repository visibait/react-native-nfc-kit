import type { ConfigPlugin } from 'expo/config-plugins';
import { AndroidConfig, withAndroidManifest } from 'expo/config-plugins';

import type { ResolvedNfcKitProps } from './types';

const NFC_FEATURE = 'android.hardware.nfc';

/**
 * Adds `<uses-feature android:name="android.hardware.nfc">`.
 *
 * `required` defaults to `false` on purpose: with `true`, Google Play hides the
 * app from every device without an NFC controller. Most apps use NFC as one
 * feature among many and should stay installable.
 */
export const withAndroidNfcFeature: ConfigPlugin<ResolvedNfcKitProps> = (config, props) =>
  withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest['uses-feature'] ??= [];

    const features = manifest['uses-feature'];
    const existing = features.find((feature) => feature.$?.['android:name'] === NFC_FEATURE);
    const required = props.android.requireNfcHardware ? 'true' : 'false';

    if (existing) {
      existing.$['android:required'] = required;
    } else {
      features.push({ $: { 'android:name': NFC_FEATURE, 'android:required': required } });
    }

    return mod;
  });

/**
 * Forces `android:launchMode="singleTop"` on the main activity.
 *
 * Without it Android recreates the activity every time a tag arrives via an
 * intent, which loses in-flight state. This is required for background tag
 * delivery and harmless otherwise, so it is applied unconditionally.
 */
export const withAndroidSingleTopLaunchMode: ConfigPlugin = (config) =>
  withAndroidManifest(config, (mod) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(mod.modResults);
    activity.$['android:launchMode'] = 'singleTop';
    return mod;
  });

export const withAndroidNfc: ConfigPlugin<ResolvedNfcKitProps> = (config, props) => {
  let next = AndroidConfig.Permissions.withPermissions(config, ['android.permission.NFC']);
  next = withAndroidNfcFeature(next, props);
  next = withAndroidSingleTopLaunchMode(next);
  return next;
};
