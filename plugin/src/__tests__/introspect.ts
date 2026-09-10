import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AndroidConfig, ExportedConfig } from 'expo/config-plugins';
import { compileModsAsync } from 'expo/config-plugins';

import type { ActivityWithMetaData } from '../androidManifest';
import withNfcKit from '../index';
import type { NfcKitPluginProps } from '../types';

/**
 * Runs the real plugin through Expo's introspection compiler.
 *
 * Introspection evaluates the Info.plist, entitlements and AndroidManifest mods
 * against Expo's own prebuild templates without touching a project on disk, so
 * these tests exercise the same code path `expo prebuild` does — the mods
 * themselves, in the order the plugin composes them — rather than a reimplemented
 * approximation of it. Anything that only reads correctly in a hand-built fixture
 * is not evidence about what prebuild produces.
 */
export interface IntrospectionResult {
  readonly manifest: AndroidConfig.Manifest.AndroidManifest;
  readonly mainActivity: ActivityWithMetaData;
  readonly infoPlist: Record<string, unknown>;
  readonly entitlements: Record<string, unknown>;
  /** `res/values/strings.xml` items, which the HCE resource references. */
  readonly strings: readonly AndroidConfig.Resources.ResourceItemXML[];
}

type BaseConfig = Partial<ExportedConfig> & Pick<ExportedConfig, 'name' | 'slug'>;

function baseConfig(overrides: Partial<ExportedConfig> = {}): BaseConfig {
  return { name: 'nfc-kit-fixture', slug: 'nfc-kit-fixture', ...overrides };
}

export async function introspectAsync(
  props?: NfcKitPluginProps,
  overrides: Partial<ExportedConfig> = {},
  // `applyPlugin: false` gives the untouched prebuild templates, which the setup
  // documentation is diffed against so a snippet cannot omit something.
  { applyPlugin = true }: { applyPlugin?: boolean } = {},
): Promise<IntrospectionResult> {
  // A real directory, because a dangerous mod that slipped through would
  // otherwise write somewhere unpredictable. Nothing is expected to appear here.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfc-kit-plugin-'));

  try {
    const base = baseConfig(overrides) as ExportedConfig;
    const config = applyPlugin ? withNfcKit(base, props) : base;
    const compiled = await compileModsAsync(config, {
      projectRoot,
      introspect: true,
      platforms: ['android', 'ios'],
      assertMissingModProviders: false,
      ignoreExistingNativeFiles: true,
    });

    const results = compiled._internal?.modResults;
    const manifest = results?.android?.manifest as AndroidConfig.Manifest.AndroidManifest;
    const application = manifest.manifest.application?.[0];
    const mainActivity = application?.activity?.find(
      (activity) => activity.$['android:name'] === '.MainActivity',
    ) as ActivityWithMetaData;

    const strings = results?.android?.strings as
      { resources?: { string?: AndroidConfig.Resources.ResourceItemXML[] } } | undefined;

    return {
      manifest,
      mainActivity,
      infoPlist: (results?.ios?.infoPlist ?? {}) as Record<string, unknown>,
      entitlements: (results?.ios?.entitlements ?? {}) as Record<string, unknown>,
      strings: strings?.resources?.string ?? [],
    };
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

/** The `android:name` of every action in an activity's intent filters. */
export function intentFilterActions(activity: ActivityWithMetaData): string[][] {
  return (activity['intent-filter'] ?? []).map((filter) =>
    (filter.action ?? []).map((action) => action.$['android:name']),
  );
}
