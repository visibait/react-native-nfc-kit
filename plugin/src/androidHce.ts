import type { AndroidConfig } from 'expo/config-plugins';

import type { ResolvedProps } from './types';

type ManifestApplication = AndroidConfig.Manifest.ManifestApplication;
type ManifestService = NonNullable<ManifestApplication['service']>[number];
type ResourceItemXML = AndroidConfig.Resources.ResourceItemXML;

/**
 * The service Android binds when a terminal selects one of the app's AIDs.
 *
 * It lives in the app's manifest rather than this library's, so an app that does
 * not emulate a card never registers an HCE service at all. The class ships
 * either way; only the declaration is conditional.
 */
export const HCE_SERVICE_CLASS = 'com.nfckit.hce.NfcKitHostApduService';

export const HOST_APDU_SERVICE_ACTION = 'android.nfc.cardemulation.action.HOST_APDU_SERVICE';
export const HOST_APDU_SERVICE_META_DATA = 'android.nfc.cardemulation.host_apdu_service';
export const BIND_NFC_SERVICE_PERMISSION = 'android.permission.BIND_NFC_SERVICE';

/** Base name of the generated resource, without extension or `@xml/` prefix. */
export const APDU_SERVICE_RESOURCE = 'nfc_kit_apduservice';

/** String resource holding the service description. */
export const HCE_DESCRIPTION_STRING = 'nfc_kit_hce_description';

/** String resource holding one AID group's description. */
export function aidGroupStringName(index: number): string {
  return `nfc_kit_hce_group_${index}`;
}

/**
 * Builds the `<service>` declaration.
 *
 * `android:exported="true"` and the `BIND_NFC_SERVICE` permission are both
 * required and are not a choice: the NFC system service is what binds this, from
 * another process, and the permission is what makes it the only thing that can.
 * Omitting either produces a service the platform silently never uses.
 */
export function buildHceService(): ManifestService {
  return {
    $: {
      'android:name': HCE_SERVICE_CLASS,
      'android:exported': 'true',
      'android:permission': BIND_NFC_SERVICE_PERMISSION,
    },
    'intent-filter': [{ action: [{ $: { 'android:name': HOST_APDU_SERVICE_ACTION } }] }],
    'meta-data': [
      {
        $: {
          'android:name': HOST_APDU_SERVICE_META_DATA,
          'android:resource': `@xml/${APDU_SERVICE_RESOURCE}`,
        },
      },
    ],
  } as ManifestService;
}

export function isHceService(service: ManifestService): boolean {
  return service.$['android:name'] === HCE_SERVICE_CLASS;
}

/**
 * The XML document for `res/xml/nfc_kit_apduservice.xml`, as an object tree.
 *
 * Every description is a string resource reference rather than a literal, because
 * that is what the platform requires here — a literal is rejected at build time,
 * and these strings are user-visible in system settings, so they need to be
 * translatable anyway.
 *
 * Only the `other` category is written. The `payment` category additionally needs
 * a 260x96 banner drawable and the user actively choosing the app as their default
 * wallet, neither of which a config plugin can arrange; see `docs/setup/hce.md`.
 */
export function buildApduServiceDocument(props: ResolvedProps): {
  'host-apdu-service': Record<string, unknown>;
} {
  const hce = props.android.hce;
  if (hce === null) {
    throw new Error('buildApduServiceDocument called with card emulation disabled');
  }

  return {
    'host-apdu-service': {
      $: {
        'xmlns:android': 'http://schemas.android.com/apk/res/android',
        'android:description': `@string/${HCE_DESCRIPTION_STRING}`,
        'android:requireDeviceUnlock': hce.requireDeviceUnlock ? 'true' : 'false',
      },
      'aid-group': hce.aidGroups.map((group, index) => ({
        $: {
          'android:description': `@string/${aidGroupStringName(index)}`,
          'android:category': 'other',
        },
        'aid-filter': group.aids.map((aid) => ({ $: { 'android:name': aid.toUpperCase() } })),
      })),
    },
  };
}

/** The string resources the generated XML references. */
export function buildHceStrings(props: ResolvedProps): ResourceItemXML[] {
  const hce = props.android.hce;
  if (hce === null) {
    return [];
  }

  return [
    { $: { name: HCE_DESCRIPTION_STRING, translatable: 'false' }, _: hce.description },
    ...hce.aidGroups.map((group, index) => ({
      $: { name: aidGroupStringName(index), translatable: 'false' },
      _: group.description,
    })),
  ];
}

/** Names of every string resource this plugin owns, for removal. */
export function hceStringNames(groupCount: number): string[] {
  return [
    HCE_DESCRIPTION_STRING,
    ...Array.from({ length: groupCount }, (_unused, index) => aidGroupStringName(index)),
  ];
}

/**
 * Adds or removes the HCE service on an application element, in place.
 *
 * Idempotent by construction: the service is dropped and rebuilt from the current
 * options, so applying this to a manifest that already has it -- a repeated
 * prebuild, or a bare project's own manifest -- leaves one copy rather than two.
 *
 * Removal matters as much as addition. A service left declared after the option is
 * dropped keeps the app registered as a card emulator, so terminals keep selecting
 * it and getting `6F00` from a handler that no longer exists.
 */
export function applyHceService(application: ManifestApplication, props: ResolvedProps): void {
  const preserved = (application.service ?? []).filter((service) => !isHceService(service));
  const services = props.android.hce === null ? preserved : [...preserved, buildHceService()];

  if (services.length > 0) {
    application.service = services;
  } else {
    delete application.service;
  }
}

/**
 * Rewrites the string resources this plugin owns, in place.
 *
 * Owned strings are cleared first so a renamed description or a removed AID group
 * does not leave an orphan behind that nothing references and nobody notices.
 */
export function applyHceStrings(
  resources: { string?: ResourceItemXML[] },
  props: ResolvedProps,
): void {
  const owned = new Set(hceStringNames(MAX_TRACKED_AID_GROUPS));
  const kept = (resources.string ?? []).filter((item) => !owned.has(item.$.name));
  const next = [...kept, ...buildHceStrings(props)];

  if (next.length > 0) {
    resources.string = next;
  } else {
    delete resources.string;
  }
}

/**
 * How many AID-group strings are cleared before rewriting them.
 *
 * The strings are named by index, so removing a group has to remove its string
 * too. A fixed upper bound is enough: nothing sane declares more groups than this,
 * and clearing a name that was never written costs nothing.
 */
const MAX_TRACKED_AID_GROUPS = 32;
