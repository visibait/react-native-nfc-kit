import {
  applyDispatchPermission,
  applyNfcToActivity,
  buildNdefIntentFilters,
  buildTechFilterDocument,
  buildTechIntentFilter,
  buildTechMetaData,
  DISPATCH_NFC_MESSAGE_PERMISSION,
  isNfcIntentFilter,
  NDEF_DISCOVERED_ACTION,
  NFC_FEATURE,
  TECH_DISCOVERED_ACTION,
  upsertNfcFeature,
  type ActivityWithMetaData,
} from '../androidManifest';
import type { AndroidConfig } from 'expo/config-plugins';
import { resolveProps, type NfcKitPluginProps } from '../types';

const LAUNCHER_FILTER = {
  action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
  category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
};

function activity(): ActivityWithMetaData {
  return {
    $: { 'android:name': '.MainActivity' },
    'intent-filter': [structuredClone(LAUNCHER_FILTER)],
  };
}

function apply(target: ActivityWithMetaData, props: NfcKitPluginProps): void {
  applyNfcToActivity(target, resolveProps(props));
}

describe('buildNdefIntentFilters', () => {
  it('emits only the attributes that were given', () => {
    // Android reads an absent attribute as "match anything"; an empty one narrows
    // the filter to a value that cannot occur.
    expect(buildNdefIntentFilters([{ scheme: 'ventry' }])[0]?.data).toEqual([
      { $: { 'android:scheme': 'ventry' } },
    ]);
  });

  it('emits every attribute of a fully specified filter', () => {
    const [filter] = buildNdefIntentFilters([
      { mimeType: 'text/plain', scheme: 'https', host: 'ventry.es', pathPrefix: '/t' },
    ]);

    expect(filter?.data).toEqual([
      {
        $: {
          'android:mimeType': 'text/plain',
          'android:scheme': 'https',
          'android:host': 'ventry.es',
          'android:pathPrefix': '/t',
        },
      },
    ]);
  });

  it('gives each configured filter its own intent-filter element', () => {
    // Sibling <data> elements inside one filter combine attribute by attribute,
    // so merging these would match an https URI OR any text/plain payload --
    // considerably wider than the two rules the config describes.
    const filters = buildNdefIntentFilters([{ scheme: 'https' }, { mimeType: 'text/plain' }]);

    expect(filters).toHaveLength(2);
    expect(filters[0]?.data).toEqual([{ $: { 'android:scheme': 'https' } }]);
    expect(filters[1]?.data).toEqual([{ $: { 'android:mimeType': 'text/plain' } }]);
  });

  it('marks each filter as DEFAULT so it can be started from a dispatch', () => {
    const [filter] = buildNdefIntentFilters([{ scheme: 'ventry' }]);

    expect(filter?.category).toEqual([
      { $: { 'android:name': 'android.intent.category.DEFAULT' } },
    ]);
    expect(filter?.action).toEqual([{ $: { 'android:name': NDEF_DISCOVERED_ACTION } }]);
  });
});

describe('the tech-list filter', () => {
  it('carries the action alone, with the technologies in the resource', () => {
    expect(buildTechIntentFilter()).toEqual({
      action: [{ $: { 'android:name': TECH_DISCOVERED_ACTION } }],
    });
  });

  it('points its meta-data at the generated resource', () => {
    expect(buildTechMetaData().$).toEqual({
      'android:name': TECH_DISCOVERED_ACTION,
      'android:resource': '@xml/nfc_kit_tech_filter',
    });
  });

  it('maps friendly names to android.nfc.tech classes', () => {
    expect(buildTechFilterDocument([['isoDep', 'ndef'], ['iso15693']])).toEqual({
      resources: {
        'tech-list': [
          { tech: ['android.nfc.tech.IsoDep', 'android.nfc.tech.Ndef'] },
          { tech: ['android.nfc.tech.NfcV'] },
        ],
      },
    });
  });

  it('keeps each list separate, since a tag must match one list in full', () => {
    const document = buildTechFilterDocument([['nfcA'], ['nfcB']]);

    expect(document.resources['tech-list']).toHaveLength(2);
  });
});

describe('isNfcIntentFilter', () => {
  it('claims the actions this plugin writes', () => {
    expect(isNfcIntentFilter(buildTechIntentFilter())).toBe(true);
    expect(isNfcIntentFilter(buildNdefIntentFilters([{ scheme: 'a' }])[0]!)).toBe(true);
  });

  it('leaves everything else alone', () => {
    expect(isNfcIntentFilter(LAUNCHER_FILTER)).toBe(false);
    expect(isNfcIntentFilter({})).toBe(false);
  });
});

describe('applyNfcToActivity', () => {
  it('keeps filters it does not own', () => {
    const target = activity();

    apply(target, { android: { backgroundReading: { ndef: [{ scheme: 'ventry' }] } } });

    expect(target['intent-filter']?.[0]).toEqual(LAUNCHER_FILTER);
  });

  it('is idempotent: applying twice leaves one copy of each filter', () => {
    // Prebuild is re-run constantly. A plugin that appends would grow the
    // manifest a filter at a time, and duplicated filters still work -- which is
    // exactly why nobody notices until something else breaks.
    const props = {
      android: { backgroundReading: { ndef: [{ scheme: 'ventry' }], techLists: [['ndef']] } },
    } satisfies NfcKitPluginProps;
    const once = activity();
    const twice = activity();

    apply(once, props);
    apply(twice, props);
    apply(twice, props);

    expect(twice).toEqual(once);
    expect(twice['intent-filter']).toHaveLength(3);
    expect(twice['meta-data']).toHaveLength(1);
  });

  it('removes filters that the options no longer ask for', () => {
    const target = activity();

    apply(target, { android: { backgroundReading: { ndef: [{ scheme: 'ventry' }] } } });
    apply(target, {});

    expect(target['intent-filter']).toEqual([LAUNCHER_FILTER]);
  });

  it('removes the tech meta-data when the tech lists go away', () => {
    const target = activity();

    apply(target, { android: { backgroundReading: { techLists: [['ndef']] } } });
    expect(target['meta-data']).toHaveLength(1);

    apply(target, {});
    expect(target['meta-data']).toBeUndefined();
  });

  it('preserves meta-data belonging to someone else', () => {
    const target = activity();
    const foreign = { $: { 'android:name': 'com.other.KEY', 'android:value': 'x' } };
    target['meta-data'] = [foreign];

    apply(target, { android: { backgroundReading: { techLists: [['ndef']] } } });
    expect(target['meta-data']).toEqual([foreign, buildTechMetaData()]);

    apply(target, {});
    expect(target['meta-data']).toEqual([foreign]);
  });

  it('drops the intent-filter key entirely when nothing is left', () => {
    const target: ActivityWithMetaData = { $: { 'android:name': '.MainActivity' } };

    apply(target, { android: { backgroundReading: { ndef: [{ scheme: 'ventry' }] } } });
    apply(target, {});

    // An empty array would serialise to nothing useful and reads as an oversight.
    expect(target).not.toHaveProperty('intent-filter');
  });
});

describe('applyDispatchPermission', () => {
  it('sets the permission when asked', () => {
    const target = activity();

    applyDispatchPermission(target, true);

    expect(target.$['android:permission']).toBe(DISPATCH_NFC_MESSAGE_PERMISSION);
  });

  it('removes its own permission when no longer asked for', () => {
    const target = activity();

    applyDispatchPermission(target, true);
    applyDispatchPermission(target, false);

    expect(target.$['android:permission']).toBeUndefined();
  });

  it('never touches a permission someone else set', () => {
    const target = activity();
    target.$['android:permission'] = 'com.ventry.permission.PRIVATE';

    applyDispatchPermission(target, false);

    expect(target.$['android:permission']).toBe('com.ventry.permission.PRIVATE');
  });
});

describe('upsertNfcFeature', () => {
  function manifest(
    features?: AndroidConfig.Manifest.AndroidManifest['manifest']['uses-feature'],
  ): AndroidConfig.Manifest.AndroidManifest {
    return {
      manifest: {
        $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
        queries: [],
        ...(features ? { 'uses-feature': features } : {}),
      },
    };
  }

  it('adds the feature as optional by default', () => {
    // `required="true"` removes every device without an NFC controller from the
    // app's Play Store audience, which is a decision the developer makes, not one
    // that follows from installing this library.
    const target = manifest();

    upsertNfcFeature(target, false);

    expect(target.manifest['uses-feature']).toEqual([
      { $: { 'android:name': NFC_FEATURE, 'android:required': 'false' } },
    ]);
  });

  it('adds it as required when asked', () => {
    const target = manifest();

    upsertNfcFeature(target, true);

    expect(target.manifest['uses-feature']?.[0]?.$['android:required']).toBe('true');
  });

  it('updates an existing entry instead of adding a second one', () => {
    const target = manifest([{ $: { 'android:name': NFC_FEATURE, 'android:required': 'false' } }]);

    upsertNfcFeature(target, true);

    expect(target.manifest['uses-feature']).toHaveLength(1);
    expect(target.manifest['uses-feature']?.[0]?.$['android:required']).toBe('true');
  });

  it('leaves other features alone', () => {
    const camera = {
      $: { 'android:name': 'android.hardware.camera', 'android:required': 'true' },
    } as const;
    const target = manifest([camera]);

    upsertNfcFeature(target, false);

    expect(target.manifest['uses-feature']).toEqual([
      camera,
      { $: { 'android:name': NFC_FEATURE, 'android:required': 'false' } },
    ]);
  });
});
