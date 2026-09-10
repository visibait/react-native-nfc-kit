import fs from 'node:fs/promises';
import path from 'node:path';

import type { ConfigPlugin } from 'expo/config-plugins';
import {
  AndroidConfig,
  WarningAggregator,
  XML,
  withAndroidManifest,
  withDangerousMod,
} from 'expo/config-plugins';

import {
  applyDispatchPermission,
  applyNfcToActivity,
  buildTechFilterDocument,
  TECH_FILTER_RESOURCE,
  upsertNfcFeature,
  type ActivityWithMetaData,
} from './androidManifest';
import { decideDispatchPermission, resolveTargetSdkVersion } from './targetSdk';
import type { ResolvedProps } from './types';

const WARNING_TAG = 'react-native-nfc-kit';

/**
 * Adds `<uses-feature android:name="android.hardware.nfc">`.
 *
 * `required` defaults to `false` on purpose: with `true`, Google Play hides the
 * app from every device without an NFC controller. Most apps use NFC as one
 * feature among several and should stay installable.
 */
export const withAndroidNfcFeature: ConfigPlugin<ResolvedProps> = (config, props) =>
  withAndroidManifest(config, (mod) => {
    upsertNfcFeature(mod.modResults, props.android.requireNfcHardware);
    return mod;
  });

/**
 * Forces `android:launchMode="singleTop"` on the main activity.
 *
 * Without it Android recreates the activity every time a tag arrives via an
 * intent, losing in-flight state. Required for background tag delivery and
 * harmless otherwise, so it is applied unconditionally.
 */
export const withAndroidSingleTopLaunchMode: ConfigPlugin = (config) =>
  withAndroidManifest(config, (mod) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(mod.modResults);
    activity.$['android:launchMode'] = 'singleTop';
    return mod;
  });

/**
 * Writes the intent filters, the tech-list `<meta-data>` and the dispatch
 * permission onto the main activity.
 */
export const withAndroidNfcIntentFilters: ConfigPlugin<ResolvedProps> = (config, props) =>
  withAndroidManifest(config, (mod) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(
      mod.modResults,
    ) as ActivityWithMetaData;

    applyNfcToActivity(activity, props);

    const decision = decideDispatchPermission({
      setting: props.android.dispatchNfcMessagePermission,
      backgroundReadingEnabled: props.android.backgroundReadingEnabled,
      targetSdkVersion: resolveTargetSdkVersion(mod),
    });
    if (decision.warning) {
      WarningAggregator.addWarningAndroid(WARNING_TAG, decision.warning);
    }
    applyDispatchPermission(activity, decision.apply);

    return mod;
  });

/**
 * Absolute path of the generated tech-filter resource.
 *
 * Derived from the platform project root rather than looked up through
 * `AndroidConfig.Paths`, which throws when `android/` does not exist yet. The
 * layout below is fixed by the Android Gradle plugin, so there is nothing to
 * discover.
 */
export function techFilterPath(platformProjectRoot: string): string {
  return path.join(
    platformProjectRoot,
    'app',
    'src',
    'main',
    'res',
    'xml',
    `${TECH_FILTER_RESOURCE}.xml`,
  );
}

/**
 * Writes `res/xml/nfc_kit_tech_filter.xml`, or removes it when no longer used.
 *
 * Removal matters: a stale resource left behind after the tech lists are dropped
 * from the config keeps compiling, so nothing ever points at it as the reason a
 * filter still behaves the way it used to.
 */
export async function writeTechFilterAsync(
  platformProjectRoot: string,
  techLists: ResolvedProps['android']['techLists'],
): Promise<void> {
  const filePath = techFilterPath(platformProjectRoot);

  if (techLists.length === 0) {
    await fs.rm(filePath, { force: true });
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, XML.format(buildTechFilterDocument(techLists)), 'utf8');
}

export const withAndroidTechFilterResource: ConfigPlugin<ResolvedProps> = (config, props) =>
  withDangerousMod(config, [
    'android',
    async (mod) => {
      await writeTechFilterAsync(mod.modRequest.platformProjectRoot, props.android.techLists);
      return mod;
    },
  ]);

export const withAndroidNfc: ConfigPlugin<ResolvedProps> = (config, props) => {
  let next = AndroidConfig.Permissions.withPermissions(config, ['android.permission.NFC']);
  next = withAndroidNfcFeature(next, props);
  next = withAndroidSingleTopLaunchMode(next);
  next = withAndroidNfcIntentFilters(next, props);
  next = withAndroidTechFilterResource(next, props);
  return next;
};
