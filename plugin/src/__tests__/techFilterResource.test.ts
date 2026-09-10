import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ExportedConfig } from 'expo/config-plugins';

import { resolveProps, type TechName } from '../types';
import {
  techFilterPath,
  withAndroidTechFilterResource,
  writeTechFilterAsync,
} from '../withAndroidNfc';

/**
 * Runs the dangerous mod the plugin actually registers.
 *
 * Expo's introspection compiler skips dangerous mods, since they touch the file
 * system — so nothing else in this suite exercises the wiring between the mod and
 * the writer. Driving the registered mod directly closes that gap without
 * scaffolding a whole Android project.
 */
async function runTechFilterMod(
  platformProjectRoot: string,
  techLists: readonly (readonly TechName[])[],
): Promise<void> {
  const config = withAndroidTechFilterResource(
    { name: 'fixture', slug: 'fixture' } as ExportedConfig,
    resolveProps({ android: { backgroundReading: { techLists } } }),
  ) as ExportedConfig;

  const mod = config.mods?.android?.dangerous;
  expect(mod).toBeDefined();

  await mod?.({
    ...config,
    modRequest: { platformProjectRoot, nextMod: (next: unknown) => next },
    modResults: {},
  } as Parameters<NonNullable<typeof mod>>[0]);
}

describe('the generated tech-filter resource', () => {
  let platformProjectRoot: string;

  beforeEach(() => {
    platformProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfc-kit-res-'));
  });

  afterEach(() => {
    fs.rmSync(platformProjectRoot, { recursive: true, force: true });
  });

  function read(): string {
    return fs.readFileSync(techFilterPath(platformProjectRoot), 'utf8');
  }

  it('lands where the Android Gradle plugin looks for it', () => {
    expect(techFilterPath(platformProjectRoot)).toBe(
      path.join(platformProjectRoot, 'app', 'src', 'main', 'res', 'xml', 'nfc_kit_tech_filter.xml'),
    );
  });

  it('creates the res/xml folder, which a fresh project does not have', async () => {
    await writeTechFilterAsync(platformProjectRoot, [['isoDep']]);

    expect(fs.existsSync(techFilterPath(platformProjectRoot))).toBe(true);
  });

  it('writes one tech-list per configured alternative', async () => {
    await writeTechFilterAsync(platformProjectRoot, [['isoDep', 'ndef'], ['iso15693']]);

    const xml = read();
    expect(xml).toContain('<tech>android.nfc.tech.IsoDep</tech>');
    expect(xml).toContain('<tech>android.nfc.tech.Ndef</tech>');
    expect(xml).toContain('<tech>android.nfc.tech.NfcV</tech>');
    expect(xml.match(/<tech-list>/g)).toHaveLength(2);
  });

  it('is stable across runs, so prebuild produces no spurious diff', async () => {
    await writeTechFilterAsync(platformProjectRoot, [['nfcA']]);
    const first = read();

    await writeTechFilterAsync(platformProjectRoot, [['nfcA']]);

    expect(read()).toBe(first);
  });

  it('removes a stale resource once the tech lists are dropped', async () => {
    // A leftover resource still compiles and is still referenced by nothing, so
    // it never announces itself as the reason behaviour did not change.
    await writeTechFilterAsync(platformProjectRoot, [['nfcA']]);
    await writeTechFilterAsync(platformProjectRoot, []);

    expect(fs.existsSync(techFilterPath(platformProjectRoot))).toBe(false);
  });

  it('does not mind being asked to remove a file that is not there', async () => {
    await expect(writeTechFilterAsync(platformProjectRoot, [])).resolves.toBeUndefined();
  });

  describe('through the registered mod', () => {
    it('writes the resource where prebuild would put it', async () => {
      await runTechFilterMod(platformProjectRoot, [['felica']]);

      expect(read()).toContain('<tech>android.nfc.tech.NfcF</tech>');
    });

    it('removes it again when the config no longer asks for one', async () => {
      await runTechFilterMod(platformProjectRoot, [['felica']]);
      await runTechFilterMod(platformProjectRoot, []);

      expect(fs.existsSync(techFilterPath(platformProjectRoot))).toBe(false);
    });
  });
});
