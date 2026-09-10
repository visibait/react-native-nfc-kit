import { WarningAggregator, type AndroidConfig } from 'expo/config-plugins';

import {
  APDU_SERVICE_RESOURCE,
  BIND_NFC_SERVICE_PERMISSION,
  applyHceService,
  applyHceStrings,
  HCE_DESCRIPTION_STRING,
  HCE_SERVICE_CLASS,
  HOST_APDU_SERVICE_ACTION,
  HOST_APDU_SERVICE_META_DATA,
  aidGroupStringName,
  buildApduServiceDocument,
  buildHceService,
  buildHceStrings,
  isHceService,
} from '../androidHce';
import { NfcKitPluginError, resolveProps, type NfcKitPluginProps } from '../types';
import { introspectAsync } from './introspect';

const HCE: NfcKitPluginProps = {
  android: {
    hce: {
      description: 'Ventry building access',
      aidGroups: [{ description: 'Doors', aids: ['F0010203040506'] }],
    },
  },
};

function expectRejected(props: NfcKitPluginProps, ...fragments: string[]): void {
  let thrown: unknown;
  try {
    resolveProps(props);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(NfcKitPluginError);
  for (const fragment of fragments) {
    expect((thrown as Error).message).toContain(fragment);
  }
}

describe('the HCE service declaration', () => {
  it('carries what the platform needs to bind it', () => {
    // Both of these are required rather than chosen: the NFC system service binds
    // this from another process, and the permission is what makes it the only
    // thing that can. Omitting either produces a service Android never uses.
    const service = buildHceService();

    expect(service.$['android:name']).toBe(HCE_SERVICE_CLASS);
    expect(service.$['android:exported']).toBe('true');
    expect(service.$['android:permission']).toBe(BIND_NFC_SERVICE_PERMISSION);
  });

  it('answers the host APDU service action', () => {
    expect(buildHceService()['intent-filter']).toEqual([
      { action: [{ $: { 'android:name': HOST_APDU_SERVICE_ACTION } }] },
    ]);
  });

  it('points its meta-data at the generated resource', () => {
    const metaData = (
      buildHceService() as { 'meta-data'?: AndroidConfig.Manifest.ManifestMetaData[] }
    )['meta-data'];

    expect(metaData).toEqual([
      {
        $: {
          'android:name': HOST_APDU_SERVICE_META_DATA,
          'android:resource': `@xml/${APDU_SERVICE_RESOURCE}`,
        },
      },
    ]);
  });

  it('recognises its own service and nothing else', () => {
    expect(isHceService(buildHceService())).toBe(true);
    expect(
      isHceService({ $: { 'android:name': 'com.other.Service' } } as ReturnType<
        typeof buildHceService
      >),
    ).toBe(false);
  });
});

describe('the generated apduservice resource', () => {
  it('references string resources rather than literals', () => {
    // The platform rejects a literal here, and these strings are user-visible in
    // system settings, so they have to be translatable anyway.
    const document = buildApduServiceDocument(resolveProps(HCE));
    const root = document['host-apdu-service'] as { $: Record<string, string> };

    expect(root.$['android:description']).toBe(`@string/${HCE_DESCRIPTION_STRING}`);
  });

  it('writes one aid-filter per AID, uppercased', () => {
    const props = resolveProps({
      android: {
        hce: {
          description: 'Access',
          aidGroups: [{ description: 'Doors', aids: ['f0010203040506', 'A0000002471001'] }],
        },
      },
    });
    const root = buildApduServiceDocument(props)['host-apdu-service'] as {
      'aid-group': { $: Record<string, string>; 'aid-filter': { $: Record<string, string> }[] }[];
    };

    expect(root['aid-group']).toHaveLength(1);
    expect(root['aid-group'][0]?.['aid-filter']).toEqual([
      { $: { 'android:name': 'F0010203040506' } },
      { $: { 'android:name': 'A0000002471001' } },
    ]);
  });

  it('writes every group in the other category', () => {
    // Payment needs a banner drawable and the user choosing the app as their
    // default wallet, neither of which a config plugin can arrange.
    const props = resolveProps({
      android: {
        hce: {
          description: 'Access',
          aidGroups: [
            { description: 'Doors', aids: ['F0010203040506'] },
            { description: 'Lockers', aids: ['F0060504030201'] },
          ],
        },
      },
    });
    const root = buildApduServiceDocument(props)['host-apdu-service'] as {
      'aid-group': { $: Record<string, string> }[];
    };

    expect(root['aid-group'].map((group) => group.$['android:category'])).toEqual([
      'other',
      'other',
    ]);
    expect(root['aid-group'][1]?.$['android:description']).toBe(`@string/${aidGroupStringName(1)}`);
  });

  it('defaults to answering without the device being unlocked', () => {
    const root = buildApduServiceDocument(resolveProps(HCE))['host-apdu-service'] as {
      $: Record<string, string>;
    };

    expect(root.$['android:requireDeviceUnlock']).toBe('false');
  });

  it('honours requireDeviceUnlock', () => {
    const props = resolveProps({
      android: {
        hce: {
          description: 'Access',
          aidGroups: [{ description: 'Doors', aids: ['F0010203040506'] }],
          requireDeviceUnlock: true,
        },
      },
    });
    const root = buildApduServiceDocument(props)['host-apdu-service'] as {
      $: Record<string, string>;
    };

    expect(root.$['android:requireDeviceUnlock']).toBe('true');
  });

  it('refuses to build when card emulation is not configured', () => {
    // Reaching this with no options is a programming mistake, not a case to
    // paper over with an empty document that would register no AIDs.
    expect(() => buildApduServiceDocument(resolveProps({}))).toThrow();
  });
});

describe('the strings it writes', () => {
  it('names one per description, marked untranslatable', () => {
    // Generated content: an app that wants these translated should provide its own
    // strings.xml rather than have this overwrite a translation on every prebuild.
    expect(buildHceStrings(resolveProps(HCE))).toEqual([
      {
        $: { name: HCE_DESCRIPTION_STRING, translatable: 'false' },
        _: 'Ventry building access',
      },
      { $: { name: aidGroupStringName(0), translatable: 'false' }, _: 'Doors' },
    ]);
  });

  it('writes none when card emulation is off', () => {
    expect(buildHceStrings(resolveProps({}))).toEqual([]);
  });
});

describe('validation', () => {
  it('rejects an empty description', () => {
    expectRejected(
      {
        android: {
          hce: { description: '   ', aidGroups: [{ description: 'a', aids: ['F001020304'] }] },
        },
      },
      'android.hce.description is empty',
    );
  });

  it('rejects a service that answers for nothing', () => {
    expectRejected(
      { android: { hce: { description: 'Access', aidGroups: [] } } },
      'would answer for nothing',
    );
  });

  it('rejects a group with no description', () => {
    expectRejected(
      {
        android: {
          hce: { description: 'Access', aidGroups: [{ description: '', aids: ['F001020304'] }] },
        },
      },
      'aidGroups[0].description is empty',
    );
  });

  it('rejects a group with no AIDs', () => {
    expectRejected(
      {
        android: {
          hce: { description: 'Access', aidGroups: [{ description: 'Doors', aids: [] }] },
        },
      },
      'matches nothing',
    );
  });

  it('rejects an AID that is not plain hexadecimal', () => {
    expectRejected(
      {
        android: {
          hce: {
            description: 'Access',
            aidGroups: [{ description: 'Doors', aids: ['0xF001020304'] }],
          },
        },
      },
      'not plain hexadecimal',
    );
  });

  it('rejects an AID outside the ISO 7816 length range', () => {
    expectRejected(
      {
        android: {
          hce: { description: 'Access', aidGroups: [{ description: 'Doors', aids: ['F001'] }] },
        },
      },
      '5 to 16 bytes',
    );
  });

  it('rejects the same AID twice in one group, whatever the case', () => {
    expectRejected(
      {
        android: {
          hce: {
            description: 'Access',
            aidGroups: [{ description: 'Doors', aids: ['F0010203040506', 'f0010203040506'] }],
          },
        },
      },
      'twice',
    );
  });
});

describe('applied through prebuild', () => {
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    warnings = jest.spyOn(WarningAggregator, 'addWarningAndroid').mockImplementation(() => {});
  });

  afterEach(() => {
    warnings.mockRestore();
  });

  function services(
    manifest: AndroidConfig.Manifest.AndroidManifest,
  ): NonNullable<AndroidConfig.Manifest.ManifestApplication['service']> {
    return manifest.manifest.application?.[0]?.service ?? [];
  }

  it('declares no service at all when card emulation is not configured', async () => {
    // An app that only reads tags must not be registered as a card emulator, or
    // terminals will select it and get nothing.
    const { manifest } = await introspectAsync();

    expect(services(manifest).filter(isHceService)).toHaveLength(0);
  });

  it('declares the service when it is', async () => {
    const { manifest } = await introspectAsync(HCE);

    expect(services(manifest).filter(isHceService)).toHaveLength(1);
  });

  it('writes the description as a string resource prebuild can compile', async () => {
    const { strings } = await introspectAsync(HCE);

    expect(strings).toContainEqual({
      $: { name: HCE_DESCRIPTION_STRING, translatable: 'false' },
      _: 'Ventry building access',
    });
  });
});

describe('applyHceService', () => {
  function application(
    services?: NonNullable<AndroidConfig.Manifest.ManifestApplication['service']>,
  ): AndroidConfig.Manifest.ManifestApplication {
    return {
      $: { 'android:name': '.MainApplication' },
      ...(services ? { service: services } : {}),
    };
  }

  const foreign = {
    $: { 'android:name': 'com.other.SyncService' },
  } as NonNullable<AndroidConfig.Manifest.ManifestApplication['service']>[number];

  it('is idempotent: applying twice leaves one declaration', () => {
    // Prebuild is re-run constantly, and a bare project's manifest already has
    // the service. Two declarations of the same service is not a build error, so
    // nobody notices until something else breaks.
    const target = application();
    const props = resolveProps(HCE);

    applyHceService(target, props);
    applyHceService(target, props);

    expect(target.service?.filter(isHceService)).toHaveLength(1);
  });

  it('removes the service when card emulation is switched off', () => {
    const target = application();

    applyHceService(target, resolveProps(HCE));
    applyHceService(target, resolveProps({}));

    expect(target).not.toHaveProperty('service');
  });

  it('leaves other services alone', () => {
    const target = application([foreign]);

    applyHceService(target, resolveProps(HCE));
    expect(target.service?.[0]).toBe(foreign);

    applyHceService(target, resolveProps({}));
    expect(target.service).toEqual([foreign]);
  });
});

describe('applyHceStrings', () => {
  it('replaces its own strings rather than appending to them', () => {
    const resources: { string?: AndroidConfig.Resources.ResourceItemXML[] } = {};

    applyHceStrings(resources, resolveProps(HCE));
    applyHceStrings(resources, resolveProps(HCE));

    expect(resources.string).toHaveLength(2);
  });

  it('drops the string for a group that no longer exists', () => {
    // Named by index, so a removed group leaves an orphan that nothing
    // references and nobody notices.
    const resources: { string?: AndroidConfig.Resources.ResourceItemXML[] } = {};
    const twoGroups = resolveProps({
      android: {
        hce: {
          description: 'Access',
          aidGroups: [
            { description: 'Doors', aids: ['F0010203040506'] },
            { description: 'Lockers', aids: ['F0060504030201'] },
          ],
        },
      },
    });

    applyHceStrings(resources, twoGroups);
    expect(resources.string?.map((item) => item.$.name)).toContain(aidGroupStringName(1));

    applyHceStrings(resources, resolveProps(HCE));
    expect(resources.string?.map((item) => item.$.name)).not.toContain(aidGroupStringName(1));
  });

  it('keeps strings it does not own', () => {
    const appName = { $: { name: 'app_name' }, _: 'Ventry' };
    const resources = { string: [appName] };

    applyHceStrings(resources, resolveProps(HCE));
    expect(resources.string[0]).toBe(appName);

    applyHceStrings(resources, resolveProps({}));
    expect(resources.string).toEqual([appName]);
  });
});
