import type { AndroidConfig } from 'expo/config-plugins';

import {
  ANDROID_TECH_CLASSES,
  type NdefIntentFilter,
  type ResolvedProps,
  type TechName,
} from './types';

type ManifestActivity = AndroidConfig.Manifest.ManifestActivity;
type ManifestIntentFilter = AndroidConfig.Manifest.ManifestIntentFilter;
type ManifestMetaData = AndroidConfig.Manifest.ManifestMetaData;
type ManifestData = NonNullable<ManifestIntentFilter['data']>[number];
type AndroidManifest = AndroidConfig.Manifest.AndroidManifest;

/**
 * `<activity>` accepts `<meta-data>` children, which the upstream type omits.
 *
 * Declaring the shape here keeps the rest of this file honestly typed rather than
 * casting at each use.
 */
export type ActivityWithMetaData = ManifestActivity & {
  'meta-data'?: ManifestMetaData[];
};

export const NFC_FEATURE = 'android.hardware.nfc';
export const NDEF_DISCOVERED_ACTION = 'android.nfc.action.NDEF_DISCOVERED';
export const TECH_DISCOVERED_ACTION = 'android.nfc.action.TECH_DISCOVERED';
export const DEFAULT_CATEGORY = 'android.intent.category.DEFAULT';
export const DISPATCH_NFC_MESSAGE_PERMISSION = 'android.permission.DISPATCH_NFC_MESSAGE';

/** Base name of the generated resource, without extension or `@xml/` prefix. */
export const TECH_FILTER_RESOURCE = 'nfc_kit_tech_filter';

/**
 * Actions this plugin owns.
 *
 * `ACTION_TAG_DISCOVERED` is deliberately absent: it is deprecated as of API 37,
 * and it is also the widest possible filter — it fires for any tag at all,
 * including ones the app has no idea what to do with.
 */
const OWNED_ACTIONS: readonly string[] = [NDEF_DISCOVERED_ACTION, TECH_DISCOVERED_ACTION];

function actionNames(filter: ManifestIntentFilter): string[] {
  return (filter.action ?? []).map((action) => action.$['android:name']);
}

/** True when this filter is one of ours, and so is ours to replace. */
export function isNfcIntentFilter(filter: ManifestIntentFilter): boolean {
  return actionNames(filter).some((name) => OWNED_ACTIONS.includes(name));
}

/**
 * Builds the `<data>` element for one NDEF filter.
 *
 * Android reads an absent attribute as "match anything", so an attribute is
 * emitted only when it was given. Writing `android:host=""` would narrow the
 * filter to a host that cannot exist.
 */
function buildData(filter: NdefIntentFilter): ManifestData[] {
  const attributes: Record<string, string> = {};
  if (filter.mimeType !== undefined) attributes['android:mimeType'] = filter.mimeType;
  if (filter.scheme !== undefined) attributes['android:scheme'] = filter.scheme;
  if (filter.host !== undefined) attributes['android:host'] = filter.host;
  if (filter.pathPrefix !== undefined) attributes['android:pathPrefix'] = filter.pathPrefix;
  return [{ $: attributes }];
}

/**
 * One `<intent-filter>` per configured NDEF filter.
 *
 * They are kept separate rather than merged into a single filter with several
 * `<data>` elements, because Android combines the attributes of sibling `<data>`
 * elements combinatorially: a filter holding `scheme=https` and
 * `mimeType=text/plain` matches an https URI *or* any text/plain payload, which
 * is not what a reader of the config would expect.
 */
export function buildNdefIntentFilters(
  filters: readonly NdefIntentFilter[],
): ManifestIntentFilter[] {
  return filters.map((filter) => ({
    action: [{ $: { 'android:name': NDEF_DISCOVERED_ACTION } }],
    category: [{ $: { 'android:name': DEFAULT_CATEGORY } }],
    data: buildData(filter),
  }));
}

/**
 * The single `ACTION_TECH_DISCOVERED` filter.
 *
 * The technologies themselves live in the resource file, not here; this filter
 * carries no `<data>` and no `<category>`, which is what the platform expects.
 */
export function buildTechIntentFilter(): ManifestIntentFilter {
  return { action: [{ $: { 'android:name': TECH_DISCOVERED_ACTION } }] };
}

/** The `<meta-data>` pointing the tech filter at its resource. */
export function buildTechMetaData(): ManifestMetaData {
  return {
    $: {
      'android:name': TECH_DISCOVERED_ACTION,
      'android:resource': `@xml/${TECH_FILTER_RESOURCE}`,
    },
  };
}

/**
 * The XML document for `res/xml/nfc_kit_tech_filter.xml`, as an object tree.
 *
 * A tag matches when it supports every technology inside one `<tech-list>`;
 * separate lists are alternatives.
 */
export function buildTechFilterDocument(techLists: readonly (readonly TechName[])[]): {
  resources: { 'tech-list': { tech: string[] }[] };
} {
  return {
    resources: {
      'tech-list': techLists.map((list) => ({
        tech: list.map((tech) => ANDROID_TECH_CLASSES[tech]),
      })),
    },
  };
}

/**
 * Applies every NFC-related change to the main activity, in place.
 *
 * Idempotent by construction: filters this plugin owns are dropped first and
 * rebuilt from the current options, so a second prebuild with different options
 * cannot leave the previous run's filters behind. The cost is that a hand-written
 * NFC filter in a bare project's manifest is also removed — which is the right
 * trade, since a stale duplicate filter is much harder to notice than a missing
 * one, and the plugin is the declared owner of this configuration.
 */
export function applyNfcToActivity(activity: ActivityWithMetaData, props: ResolvedProps): void {
  const { ndefIntentFilters, techLists } = props.android;

  const preserved = (activity['intent-filter'] ?? []).filter(
    (filter) => !isNfcIntentFilter(filter),
  );
  const added: ManifestIntentFilter[] = buildNdefIntentFilters(ndefIntentFilters);
  if (techLists.length > 0) {
    added.push(buildTechIntentFilter());
  }

  const filters = [...preserved, ...added];
  if (filters.length > 0) {
    activity['intent-filter'] = filters;
  } else {
    delete activity['intent-filter'];
  }

  const metaData = (activity['meta-data'] ?? []).filter(
    (item) => item.$['android:name'] !== TECH_DISCOVERED_ACTION,
  );
  if (techLists.length > 0) {
    metaData.push(buildTechMetaData());
  }
  if (metaData.length > 0) {
    activity['meta-data'] = metaData;
  } else {
    delete activity['meta-data'];
  }
}

/**
 * Sets or clears `android:permission` on the main activity.
 *
 * Only ever touches this one permission, so an activity protected by something
 * else keeps it.
 */
export function applyDispatchPermission(activity: ManifestActivity, enabled: boolean): void {
  if (enabled) {
    activity.$['android:permission'] = DISPATCH_NFC_MESSAGE_PERMISSION;
  } else if (activity.$['android:permission'] === DISPATCH_NFC_MESSAGE_PERMISSION) {
    delete activity.$['android:permission'];
  }
}

/**
 * Declares the NFC hardware feature, updating an existing entry rather than
 * adding a second one.
 *
 * `required` is the consequential half: with `true`, Google Play hides the app
 * from every device without an NFC controller. Most apps use NFC as one feature
 * among several and should stay installable, so the caller's default is `false`.
 */
export function upsertNfcFeature(manifest: AndroidManifest, required: boolean): void {
  manifest.manifest['uses-feature'] ??= [];

  const features = manifest.manifest['uses-feature'];
  const existing = features.find((feature) => feature.$?.['android:name'] === NFC_FEATURE);
  const value = required ? 'true' : 'false';

  if (existing) {
    existing.$['android:required'] = value;
  } else {
    features.push({ $: { 'android:name': NFC_FEATURE, 'android:required': value } });
  }
}
