import { XML, type AndroidConfig } from 'expo/config-plugins';

import {
  buildTechFilterDocument,
  isNfcIntentFilter,
  TECH_DISCOVERED_ACTION,
  type ActivityWithMetaData,
} from '../androidManifest';
import type { NfcKitPluginProps, ResolvedProps } from '../types';
import { introspectAsync, type IntrospectionResult } from './introspect';

/**
 * Renders what the config plugin produces, as copy-pasteable snippets.
 *
 * These are what the setup documentation shows a bare React Native project to
 * write by hand, and the documentation test asserts the files still match. That
 * is the whole point: a setup guide is the one kind of documentation that is
 * silently wrong the moment the tool changes, because nobody re-reads it until
 * something has already failed on a device.
 *
 * The snippets are derived by diffing against a prebuild with the plugin absent,
 * so a value the plugin writes cannot go unmentioned by a renderer that forgot
 * about it.
 */

/* -------------------------------------------------------------------------- */
/* Property lists                                                             */
/* -------------------------------------------------------------------------- */

type PlistValue = string | readonly string[];

function renderPlistValue(value: PlistValue, indent: string): string {
  if (typeof value === 'string') {
    return `${indent}<string>${value}</string>`;
  }
  const items = value.map((item) => `${indent}  <string>${item}</string>`).join('\n');
  return `${indent}<array>\n${items}\n${indent}</array>`;
}

/**
 * Key/value pairs as they appear inside a plist's top-level `<dict>`.
 *
 * Deliberately a fragment rather than a whole document: both Info.plist and the
 * entitlements file already exist in a bare project, so "add these keys" is the
 * instruction, and a full document would invite replacing the file.
 */
export function renderPlistEntries(entries: Record<string, PlistValue>): string {
  return Object.keys(entries)
    .sort()
    .map((key) => {
      const value = entries[key];
      if (value === undefined) {
        throw new Error(`No value for ${key}`);
      }
      return `<key>${key}</key>\n${renderPlistValue(value, '')}`;
    })
    .join('\n');
}

/** Keys present (or changed) with the plugin applied that were not there before. */
export function plistAdditions(
  baseline: Record<string, unknown>,
  applied: Record<string, unknown>,
): Record<string, PlistValue> {
  const additions: Record<string, PlistValue> = {};

  for (const [key, value] of Object.entries(applied)) {
    if (JSON.stringify(baseline[key]) === JSON.stringify(value)) {
      continue;
    }
    if (typeof value === 'string') {
      additions[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      additions[key] = value as string[];
    } else {
      throw new Error(`Cannot render ${key}: only strings and string arrays are documented.`);
    }
  }

  return additions;
}

/* -------------------------------------------------------------------------- */
/* Android manifest                                                           */
/* -------------------------------------------------------------------------- */

type AndroidManifest = AndroidConfig.Manifest.AndroidManifest;
type ManifestIntentFilter = AndroidConfig.Manifest.ManifestIntentFilter;

function attributes(record: Record<string, string | undefined>): string {
  return Object.entries(record)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
}

function renderIntentFilter(filter: ManifestIntentFilter, indent: string): string {
  const lines = [`${indent}<intent-filter>`];

  for (const action of filter.action ?? []) {
    lines.push(`${indent}  <action ${attributes(action.$)} />`);
  }
  for (const category of filter.category ?? []) {
    lines.push(`${indent}  <category ${attributes(category.$)} />`);
  }
  for (const data of filter.data ?? []) {
    lines.push(`${indent}  <data ${attributes(data.$)} />`);
  }

  lines.push(`${indent}</intent-filter>`);
  return lines.join('\n');
}

function mainActivity(manifest: AndroidManifest): ActivityWithMetaData {
  const activity = manifest.manifest.application?.[0]?.activity?.find(
    (candidate) => candidate.$['android:name'] === '.MainActivity',
  );
  if (activity === undefined) {
    throw new Error('The introspected manifest has no .MainActivity');
  }
  return activity as ActivityWithMetaData;
}

/**
 * Everything the plugin added to the manifest, as an XML sketch.
 *
 * Four places are compared, which is every place the plugin writes to. A new
 * kind of edit would need a case here, and the documentation test fails loudly
 * rather than quietly omitting it.
 */
export function renderManifestAdditions(
  baseline: AndroidManifest,
  applied: AndroidManifest,
): string {
  const sections: string[] = [];

  const before = new Set(
    (baseline.manifest['uses-permission'] ?? []).map((item) => item.$['android:name']),
  );
  const permissions = (applied.manifest['uses-permission'] ?? [])
    .map((item) => item.$['android:name'])
    .filter((name) => !before.has(name));
  for (const name of permissions) {
    sections.push(`<uses-permission android:name="${name}" />`);
  }

  const featuresBefore = new Set(
    (baseline.manifest['uses-feature'] ?? []).map((item) => JSON.stringify(item.$)),
  );
  for (const feature of applied.manifest['uses-feature'] ?? []) {
    if (!featuresBefore.has(JSON.stringify(feature.$))) {
      sections.push(`<uses-feature ${attributes(feature.$)} />`);
    }
  }

  const baseActivity = mainActivity(baseline);
  const activity = mainActivity(applied);

  const changedAttributes: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(activity.$)) {
    if (baseActivity.$[key] !== value) {
      changedAttributes[key] = value;
    }
  }

  const addedFilters = (activity['intent-filter'] ?? []).filter(isNfcIntentFilter);
  const addedMetaData = (activity['meta-data'] ?? []).filter(
    (item) => item.$['android:name'] === TECH_DISCOVERED_ACTION,
  );

  if (
    Object.keys(changedAttributes).length > 0 ||
    addedFilters.length > 0 ||
    addedMetaData.length > 0
  ) {
    const lines = [
      `<activity android:name=".MainActivity" ${attributes(changedAttributes)}>`,
      // This is an edit to the activity a project already has, not a new one, and
      // a snippet that looks like a whole element invites replacing it.
      '  <!-- your existing intent filters stay here -->',
    ];
    for (const filter of addedFilters) {
      lines.push(renderIntentFilter(filter, '  '));
    }
    for (const item of addedMetaData) {
      lines.push(`  <meta-data ${attributes(item.$)} />`);
    }
    lines.push('</activity>');
    sections.push(lines.join('\n'));
  }

  return sections.join('\n');
}

/** The generated `res/xml/nfc_kit_tech_filter.xml`, or an empty string. */
export function renderTechFilter(props: ResolvedProps): string {
  return props.android.techLists.length === 0
    ? ''
    : XML.format(buildTechFilterDocument(props.android.techLists)).trim();
}

/* -------------------------------------------------------------------------- */
/* Recipes                                                                    */
/* -------------------------------------------------------------------------- */

export interface RenderedSetup {
  readonly entitlements: string;
  readonly infoPlist: string;
  readonly manifest: string;
  readonly techFilter: string;
}

let baseline: IntrospectionResult | undefined;

/** Renders one set of plugin options into the four documentable snippets. */
export async function renderSetupAsync(
  props: NfcKitPluginProps | undefined,
  resolved: ResolvedProps,
): Promise<RenderedSetup> {
  baseline ??= await introspectAsync(undefined, {}, { applyPlugin: false });
  const applied = await introspectAsync(props);

  return {
    entitlements: renderPlistEntries(plistAdditions(baseline.entitlements, applied.entitlements)),
    infoPlist: renderPlistEntries(plistAdditions(baseline.infoPlist, applied.infoPlist)),
    manifest: renderManifestAdditions(baseline.manifest, applied.manifest),
    techFilter: renderTechFilter(resolved),
  };
}
