/**
 * Options accepted by the `react-native-nfc-kit` Expo config plugin.
 *
 * Three principles govern this schema, each one a reaction to a concrete way the
 * existing ecosystem gets it wrong:
 *
 * 1. **No over-asking.** Entitlements are requested for what the implementation
 *    actually uses and nothing more.
 * 2. **Independent switches.** No single flag gates both an iOS and an Android
 *    behaviour, so turning one off cannot silently turn the other off too.
 * 3. **Loud failure at prebuild.** A combination that would silently match no tag
 *    is rejected here, where the message is read, rather than written into a
 *    manifest that looks plausible and never fires.
 */

/* -------------------------------------------------------------------------- */
/* Technology names                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Technology names, identical to the ones the runtime API uses.
 *
 * Duplicated from `src/native/contract.ts` rather than imported: the plugin is a
 * separate TypeScript project with its own `rootDir`, and reaching across would
 * put library source into the plugin's build output. A test in the plugin suite
 * compares the two lists, so the duplication cannot drift unnoticed.
 */
export const TECH_NAMES = [
  'ndef',
  'ndefFormatable',
  'isoDep',
  'iso15693',
  'felica',
  'mifareUltralight',
  'mifareClassic',
  'nfcA',
  'nfcB',
  'nfcBarcode',
] as const;

export type TechName = (typeof TECH_NAMES)[number];

/**
 * Friendly name to the `android.nfc.tech` class a tech-list filter must name.
 *
 * Mirrors `TechRegistry` in `android/src/main/java/com/nfckit/tech/TechAdapter.kt`,
 * where every entry carries the same fully-qualified class name.
 */
export const ANDROID_TECH_CLASSES: Record<TechName, string> = {
  ndef: 'android.nfc.tech.Ndef',
  ndefFormatable: 'android.nfc.tech.NdefFormatable',
  isoDep: 'android.nfc.tech.IsoDep',
  iso15693: 'android.nfc.tech.NfcV',
  felica: 'android.nfc.tech.NfcF',
  mifareUltralight: 'android.nfc.tech.MifareUltralight',
  mifareClassic: 'android.nfc.tech.MifareClassic',
  nfcA: 'android.nfc.tech.NfcA',
  nfcB: 'android.nfc.tech.NfcB',
  nfcBarcode: 'android.nfc.tech.NfcBarcode',
};

/* -------------------------------------------------------------------------- */
/* iOS                                                                        */
/* -------------------------------------------------------------------------- */

export interface IosPluginProps {
  /**
   * Which values to write to `com.apple.developer.nfc.readersession.formats`.
   *
   * - `'tag'` is required by `NFCTagReaderSession`, which is what this library
   *   uses for every technology, NDEF included.
   * - `'ndef'` is required by `NFCNDEFReaderSession`. On its own it does not let
   *   this library open a session today; it exists for apps that also drive
   *   CoreNFC directly.
   *
   * Defaults to `['tag']`. A default that read narrower than the implementation
   * needs would be worse than the honest wider one, because it fails at runtime
   * with an error that never mentions entitlements.
   */
  formats?: readonly ('ndef' | 'tag')[];

  /**
   * AIDs for `com.apple.developer.nfc.readersession.iso7816.select-identifiers`.
   *
   * iOS does not deliver an ISO 7816 tag to the app unless the AID being selected
   * appears here. This is the single most common reason an ISO-DEP tag works on
   * Android and appears not to exist at all on iOS.
   *
   * Worth knowing: including `D2760000850101`, the NDEF application AID, makes a
   * DESFire tag arrive as an ISO 7816 tag rather than a MIFARE one. Omit it if
   * you want the MIFARE interface.
   */
  selectIdentifiers?: readonly string[];

  /**
   * FeliCa system codes for `com.apple.developer.nfc.readersession.felica.systemcodes`.
   *
   * As with AIDs, a FeliCa tag whose system code is not listed never reaches the
   * app. `FFFF` is the wildcard.
   */
  felicaSystemCodes?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Android                                                                    */
/* -------------------------------------------------------------------------- */

/** One `ACTION_NDEF_DISCOVERED` filter: a tag matching it can launch the app. */
export interface NdefIntentFilter {
  /** MIME type to match, e.g. `text/plain` or `application/vnd.example`. */
  mimeType?: string;
  /** URI scheme to match, e.g. `https`. */
  scheme?: string;
  /** URI host to match, e.g. `example.com`. Requires `scheme`. */
  host?: string;
  /** URI path prefix to match, e.g. `/tickets`. Requires `scheme`. */
  pathPrefix?: string;
}

export interface BackgroundReadingProps {
  /**
   * NDEF filters, matched against the first record of the tag's message.
   *
   * Each entry becomes one `<intent-filter>` for `ACTION_NDEF_DISCOVERED`.
   *
   * One caveat that catches people out: from Android 16, an NDEF tag holding an
   * `http` or `https` URI dispatches `ACTION_VIEW` instead, so a scheme filter
   * for those two will not fire on newer devices. Filters on your own scheme or
   * on a MIME type are unaffected.
   */
  ndef?: readonly NdefIntentFilter[];

  /**
   * Tech-list filters, matched against the technologies the tag supports.
   *
   * Each inner array is one `<tech-list>`, and a tag matches when it supports
   * **every** technology in that list. Separate lists are alternatives, so
   * `[['isoDep'], ['mifareUltralight']]` matches either, while
   * `[['isoDep', 'ndef']]` matches only tags that are both.
   *
   * These are written to `res/xml/nfc_kit_tech_filter.xml` and referenced from an
   * `ACTION_TECH_DISCOVERED` filter.
   */
  techLists?: readonly (readonly TechName[])[];
}

export interface AndroidPluginProps {
  /**
   * Whether NFC hardware is required to install the app.
   *
   * Defaults to `false`, which keeps the app installable on devices without an
   * NFC controller. `true` removes those devices from your Play Store audience
   * entirely, so it is only right when the app is useless without NFC.
   */
  requireNfcHardware?: boolean;

  /**
   * Intent filters that let a tag launch or foreground the app.
   *
   * Reader mode — `nfc.withTag`, `nfc.openSession`, `nfc.onTag` — needs none of
   * this. Configure it only to handle tags tapped while the app is closed or in
   * the background.
   */
  backgroundReading?: BackgroundReadingProps;

  /**
   * Whether to protect the main activity with `android.permission.DISPATCH_NFC_MESSAGE`.
   *
   * From Android 17 (API 37), an activity receiving NFC intents must be protected
   * by this permission when the app targets an SDK above `BAKLAVA`, so that only
   * the NFC system service can dispatch to it.
   *
   * The trap is that `android:permission` on an activity applies on **every**
   * Android version, and a permission the running platform does not define can be
   * held by nobody — so applying it on a device older than API 37 stands to block
   * the very dispatch it is meant to secure. That is why `'auto'` is narrow:
   *
   * - `'auto'` (the default) applies it only when background reading is
   *   configured **and** a target SDK of 37 or higher can be read out of the
   *   project. When background reading is on and the target SDK cannot be
   *   determined, the plugin warns rather than guessing.
   * - `true` and `false` decide it outright.
   *
   * Provisional: the behaviour above follows from the Android 17 documentation
   * and has not been validated on API 37 hardware.
   */
  dispatchNfcMessagePermission?: 'auto' | boolean;
}

/* -------------------------------------------------------------------------- */
/* Top level                                                                  */
/* -------------------------------------------------------------------------- */

export interface NfcKitPluginProps {
  /**
   * Value written to `NFCReaderUsageDescription` in Info.plist.
   *
   * iOS requires this key to be present and non-empty; session creation fails
   * outright when it is missing, with an error that never mentions Info.plist.
   * A default is supplied so that cannot happen by accident.
   */
  readerUsageDescription?: string;
  ios?: IosPluginProps;
  android?: AndroidPluginProps;
}

/** Every option resolved to a concrete value, with nothing left optional. */
export interface ResolvedProps {
  readonly readerUsageDescription: string;
  readonly ios: {
    readonly formats: readonly ('ndef' | 'tag')[];
    readonly selectIdentifiers: readonly string[];
    readonly felicaSystemCodes: readonly string[];
  };
  readonly android: {
    readonly requireNfcHardware: boolean;
    readonly ndefIntentFilters: readonly NdefIntentFilter[];
    readonly techLists: readonly (readonly TechName[])[];
    readonly backgroundReadingEnabled: boolean;
    /** `'auto'` is still unresolved here; deciding it needs the target SDK. */
    readonly dispatchNfcMessagePermission: 'auto' | boolean;
  };
}

export const DEFAULT_READER_USAGE_DESCRIPTION = 'Hold your device near an NFC tag to read it.';

/** Maps the plugin's lowercase format names to Apple's entitlement values. */
export const ENTITLEMENT_FORMAT_VALUES: Record<'ndef' | 'tag', string> = {
  ndef: 'NDEF',
  tag: 'TAG',
};

/** The API level at which `DISPATCH_NFC_MESSAGE` starts being required. */
export const DISPATCH_NFC_MESSAGE_MIN_SDK = 37;

export class NfcKitPluginError extends Error {
  constructor(message: string) {
    super(`[react-native-nfc-kit] ${message}`);
    this.name = 'NfcKitPluginError';
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const HEX_ONLY = /^[0-9a-fA-F]+$/;

/**
 * Checks one hex-string option.
 *
 * Apple reads these as raw hex, so a lowercase value is fine but a stray `0x`
 * prefix, a separator or an odd digit count produces an entitlement that matches
 * nothing — with no error anywhere, on device or at build time.
 */
function assertHex(value: string, label: string, byteLengths?: readonly number[]): void {
  if (!HEX_ONLY.test(value)) {
    throw new NfcKitPluginError(
      `${label} is "${value}", which is not plain hexadecimal. Write the bytes only: no "0x" ` +
        'prefix, no spaces and no separators.',
    );
  }
  if (value.length % 2 !== 0) {
    throw new NfcKitPluginError(
      `${label} is "${value}", which has an odd number of hex digits and so is not a whole ` +
        'number of bytes.',
    );
  }
  const byteLength = value.length / 2;
  if (byteLengths && !byteLengths.includes(byteLength)) {
    throw new NfcKitPluginError(
      `${label} is ${byteLength} byte(s); it must be ${byteLengths.join(' or ')} byte(s).`,
    );
  }
}

function assertValidNdefFilter(filter: NdefIntentFilter, index: number): void {
  const at = `android.backgroundReading.ndef[${index}]`;

  if (filter.mimeType === undefined && filter.scheme === undefined) {
    throw new NfcKitPluginError(
      `${at} has neither a mimeType nor a scheme, so Android would match it against nothing. ` +
        'Give it one, or remove the entry.',
    );
  }
  if (
    filter.scheme === undefined &&
    (filter.host !== undefined || filter.pathPrefix !== undefined)
  ) {
    throw new NfcKitPluginError(
      `${at} sets a host or pathPrefix without a scheme. Android ignores both unless a scheme is ` +
        'present, so the filter would be far wider than it looks.',
    );
  }
  if (filter.mimeType !== undefined && !filter.mimeType.includes('/')) {
    throw new NfcKitPluginError(
      `${at} has mimeType "${filter.mimeType}", which is not a type/subtype pair.`,
    );
  }
  if (filter.scheme !== undefined && filter.scheme.includes(':')) {
    throw new NfcKitPluginError(
      `${at} has scheme "${filter.scheme}". Write the scheme alone, without "://" or a colon.`,
    );
  }
  if (filter.pathPrefix !== undefined && !filter.pathPrefix.startsWith('/')) {
    throw new NfcKitPluginError(
      `${at} has pathPrefix "${filter.pathPrefix}", which must start with "/".`,
    );
  }
}

function assertValidTechList(list: readonly TechName[], index: number): void {
  const at = `android.backgroundReading.techLists[${index}]`;

  if (list.length === 0) {
    throw new NfcKitPluginError(
      `${at} is empty. An empty tech-list matches every tag, which is almost never what is meant; ` +
        'name the technologies you handle.',
    );
  }
  for (const tech of list) {
    if (!(tech in ANDROID_TECH_CLASSES)) {
      throw new NfcKitPluginError(
        `${at} contains "${tech}", which is not a technology name. Valid names: ` +
          `${TECH_NAMES.join(', ')}.`,
      );
    }
  }
  const duplicate = list.find((tech, i) => list.indexOf(tech) !== i);
  if (duplicate !== undefined) {
    throw new NfcKitPluginError(`${at} lists "${duplicate}" twice.`);
  }
}

/**
 * Fills in defaults and rejects anything that would silently do nothing.
 *
 * Every case validated here is a mistake that produces no error at build time, no
 * error at runtime, and simply never matches a tag. Those are worth being strict
 * about: failing here costs one prebuild.
 */
export function resolveProps(props: NfcKitPluginProps | undefined): ResolvedProps {
  const formats = props?.ios?.formats ?? ['tag'];
  if (formats.length === 0) {
    throw new NfcKitPluginError(
      'ios.formats is empty. Without a reader-session format iOS refuses to create a session at ' +
        'all; use at least ["tag"].',
    );
  }
  for (const format of formats) {
    if (format !== 'ndef' && format !== 'tag') {
      throw new NfcKitPluginError(
        `ios.formats contains "${String(format)}"; the only values are "ndef" and "tag".`,
      );
    }
  }

  const selectIdentifiers = props?.ios?.selectIdentifiers ?? [];
  selectIdentifiers.forEach((aid, i) => {
    // ISO 7816-4 puts an AID at 5 to 16 bytes. Apple rejects anything else when
    // the provisioning profile is built, which is a long way from here.
    assertHex(aid, `ios.selectIdentifiers[${i}]`);
    const bytes = aid.length / 2;
    if (bytes < 5 || bytes > 16) {
      throw new NfcKitPluginError(
        `ios.selectIdentifiers[${i}] is ${bytes} bytes; an ISO 7816 AID is 5 to 16 bytes.`,
      );
    }
  });

  const felicaSystemCodes = props?.ios?.felicaSystemCodes ?? [];
  felicaSystemCodes.forEach((code, i) => {
    assertHex(code, `ios.felicaSystemCodes[${i}]`, [2]);
  });

  const ndefIntentFilters = props?.android?.backgroundReading?.ndef ?? [];
  ndefIntentFilters.forEach(assertValidNdefFilter);

  const techLists = props?.android?.backgroundReading?.techLists ?? [];
  techLists.forEach(assertValidTechList);

  return {
    readerUsageDescription: props?.readerUsageDescription ?? DEFAULT_READER_USAGE_DESCRIPTION,
    ios: { formats, selectIdentifiers, felicaSystemCodes },
    android: {
      requireNfcHardware: props?.android?.requireNfcHardware ?? false,
      ndefIntentFilters,
      techLists,
      backgroundReadingEnabled: ndefIntentFilters.length > 0 || techLists.length > 0,
      dispatchNfcMessagePermission: props?.android?.dispatchNfcMessagePermission ?? 'auto',
    },
  };
}
