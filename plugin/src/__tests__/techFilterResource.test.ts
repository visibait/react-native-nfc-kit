import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ExportedConfig } from 'expo/config-plugins';

import { resolveProps, type NfcKitPluginProps, type TechName } from '../types';
import {
  apduServicePath,
  techFilterPath,
  withAndroidTechFilterResource,
  writeApduServiceAsync,
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

describe('the generated HCE service resource', () => {
  let platformProjectRoot: string;

  const HCE = {
    android: {
      hce: {
        description: 'Ventry building access',
        aidGroups: [{ description: 'Doors', aids: ['F0010203040506'] }],
      },
    },
  } satisfies NfcKitPluginProps;

  beforeEach(() => {
    platformProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfc-kit-hce-'));
  });

  afterEach(() => {
    fs.rmSync(platformProjectRoot, { recursive: true, force: true });
  });

  it('lands where the meta-data points', () => {
    expect(apduServicePath(platformProjectRoot)).toBe(
      path.join(platformProjectRoot, 'app', 'src', 'main', 'res', 'xml', 'nfc_kit_apduservice.xml'),
    );
  });

  it('declares the AIDs the terminal will select', async () => {
    await writeApduServiceAsync(platformProjectRoot, resolveProps(HCE));

    const xml = fs.readFileSync(apduServicePath(platformProjectRoot), 'utf8');
    expect(xml).toContain('<host-apdu-service');
    expect(xml).toContain('android:name="F0010203040506"');
    expect(xml).toContain('android:category="other"');
    expect(xml).toContain('@string/nfc_kit_hce_description');
  });

  it('is stable across runs, so prebuild produces no spurious diff', async () => {
    await writeApduServiceAsync(platformProjectRoot, resolveProps(HCE));
    const first = fs.readFileSync(apduServicePath(platformProjectRoot), 'utf8');

    await writeApduServiceAsync(platformProjectRoot, resolveProps(HCE));

    expect(fs.readFileSync(apduServicePath(platformProjectRoot), 'utf8')).toBe(first);
  });

  it('removes the resource once card emulation is switched off', async () => {
    // A stale resource keeps the declared service pointing at real AIDs, so
    // terminals keep selecting an app that no longer intends to answer.
    await writeApduServiceAsync(platformProjectRoot, resolveProps(HCE));
    await writeApduServiceAsync(platformProjectRoot, resolveProps({}));

    expect(fs.existsSync(apduServicePath(platformProjectRoot))).toBe(false);
  });

  it('does not mind being asked to remove a file that is not there', async () => {
    await expect(
      writeApduServiceAsync(platformProjectRoot, resolveProps({})),
    ).resolves.toBeUndefined();
  });

  it('is written by the registered mod alongside the tech filter', async () => {
    const config = withAndroidTechFilterResource(
      { name: 'fixture', slug: 'fixture' } as ExportedConfig,
      resolveProps(HCE),
    ) as ExportedConfig;
    const mod = config.mods?.android?.dangerous;

    await mod?.({
      ...config,
      modRequest: { platformProjectRoot, nextMod: (next: unknown) => next },
      modResults: {},
    } as Parameters<NonNullable<typeof mod>>[0]);

    expect(fs.existsSync(apduServicePath(platformProjectRoot))).toBe(true);
  });
});
