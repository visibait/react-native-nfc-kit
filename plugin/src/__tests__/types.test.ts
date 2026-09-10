import { TAG_TECH_NAMES } from '../../../src/native/contract';
import {
  ANDROID_TECH_CLASSES,
  DEFAULT_READER_USAGE_DESCRIPTION,
  NfcKitPluginError,
  resolveProps,
  TECH_NAMES,
  type NfcKitPluginProps,
} from '../types';

/** Asserts that resolving these options fails, and that the message says why. */
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

describe('technology names', () => {
  it('match the runtime contract exactly', () => {
    // The plugin cannot import from `src` at build time -- separate project,
    // separate rootDir -- so the list is duplicated. This test is the reason
    // that duplication is safe: renaming a technology in one place and not the
    // other fails here rather than producing a tech filter for a name the
    // runtime no longer uses.
    expect([...TECH_NAMES].sort()).toEqual([...TAG_TECH_NAMES].sort());
  });

  it('map every name to an android.nfc.tech class', () => {
    expect(Object.keys(ANDROID_TECH_CLASSES).sort()).toEqual([...TECH_NAMES].sort());
    for (const className of Object.values(ANDROID_TECH_CLASSES)) {
      expect(className).toMatch(/^android\.nfc\.tech\.[A-Z]\w+$/);
    }
  });

  it('map to distinct classes', () => {
    const classes = Object.values(ANDROID_TECH_CLASSES);
    expect(new Set(classes).size).toBe(classes.length);
  });
});

describe('resolveProps defaults', () => {
  it('asks for the TAG format, which is what the implementation uses', () => {
    // Every technology, NDEF included, goes through NFCTagReaderSession. A
    // narrower default would read better and fail at runtime.
    expect(resolveProps(undefined).ios.formats).toEqual(['tag']);
  });

  it('supplies a non-empty usage description', () => {
    // CoreNFC refuses to create a session when this key is missing or blank, and
    // says nothing about Info.plist when it does.
    expect(resolveProps(undefined).readerUsageDescription).toBe(DEFAULT_READER_USAGE_DESCRIPTION);
    expect(DEFAULT_READER_USAGE_DESCRIPTION.trim().length).toBeGreaterThan(0);
  });

  it('leaves NFC hardware optional', () => {
    expect(resolveProps(undefined).android.requireNfcHardware).toBe(false);
  });

  it('reports background reading as off when nothing is configured', () => {
    expect(resolveProps(undefined).android.backgroundReadingEnabled).toBe(false);
    expect(
      resolveProps({ android: { backgroundReading: {} } }).android.backgroundReadingEnabled,
    ).toBe(false);
  });

  it('reports background reading as on for either kind of filter', () => {
    const withNdef = resolveProps({
      android: { backgroundReading: { ndef: [{ mimeType: 'text/plain' }] } },
    });
    const withTechLists = resolveProps({
      android: { backgroundReading: { techLists: [['ndef']] } },
    });

    expect(withNdef.android.backgroundReadingEnabled).toBe(true);
    expect(withTechLists.android.backgroundReadingEnabled).toBe(true);
  });

  it('leaves the dispatch permission unresolved, since it needs the target SDK', () => {
    expect(resolveProps(undefined).android.dispatchNfcMessagePermission).toBe('auto');
    expect(
      resolveProps({ android: { dispatchNfcMessagePermission: false } }).android
        .dispatchNfcMessagePermission,
    ).toBe(false);
  });
});

describe('resolveProps validation', () => {
  it('rejects an empty format list', () => {
    expectRejected({ ios: { formats: [] } }, 'ios.formats is empty');
  });

  it('rejects a format that is not a format', () => {
    expectRejected({ ios: { formats: ['vas' as 'tag'] } }, '"ndef" and "tag"');
  });

  describe('AIDs and system codes', () => {
    it('rejects a 0x prefix', () => {
      expectRejected({ ios: { selectIdentifiers: ['0xA0000002471001'] } }, 'not plain hexadecimal');
    });

    it('rejects separators', () => {
      expectRejected({ ios: { selectIdentifiers: ['A0 00 00 02 47 10 01'] } }, 'no separators');
    });

    it('rejects an odd number of digits', () => {
      expectRejected({ ios: { selectIdentifiers: ['A000000247100'] } }, 'odd number of hex digits');
    });

    it('rejects an AID outside the ISO 7816 length range', () => {
      expectRejected({ ios: { selectIdentifiers: ['A0000002'] } }, '5 to 16 bytes');
      expectRejected({ ios: { selectIdentifiers: ['A0'.repeat(17)] } }, '5 to 16 bytes');
    });

    it('accepts an AID at both ends of the range', () => {
      const props = resolveProps({
        ios: { selectIdentifiers: ['A0'.repeat(5), 'A0'.repeat(16)] },
      });
      expect(props.ios.selectIdentifiers).toHaveLength(2);
    });

    it('rejects a FeliCa system code that is not two bytes', () => {
      expectRejected({ ios: { felicaSystemCodes: ['12FC00'] } }, 'must be 2 byte(s)');
    });

    it('accepts the FeliCa wildcard', () => {
      expect(resolveProps({ ios: { felicaSystemCodes: ['FFFF'] } }).ios.felicaSystemCodes).toEqual([
        'FFFF',
      ]);
    });
  });

  describe('NDEF intent filters', () => {
    it('rejects a filter that matches nothing', () => {
      expectRejected({ android: { backgroundReading: { ndef: [{}] } } }, 'neither a mimeType nor');
    });

    it('rejects a host without a scheme, which silently widens the filter', () => {
      expectRejected(
        { android: { backgroundReading: { ndef: [{ mimeType: 'text/plain', host: 'a.com' }] } } },
        'without a scheme',
      );
    });

    it('rejects a mime type that is not a type/subtype pair', () => {
      expectRejected(
        { android: { backgroundReading: { ndef: [{ mimeType: 'text' }] } } },
        'not a type/subtype pair',
      );
    });

    it('rejects a scheme written as a URL prefix', () => {
      expectRejected(
        { android: { backgroundReading: { ndef: [{ scheme: 'https://' }] } } },
        'without "://" or a colon',
      );
    });

    it('rejects a path prefix that does not start with a slash', () => {
      expectRejected(
        { android: { backgroundReading: { ndef: [{ scheme: 'https', pathPrefix: 'tickets' }] } } },
        'must start with "/"',
      );
    });

    it('names the offending entry by index', () => {
      expectRejected(
        {
          android: {
            backgroundReading: {
              ndef: [{ mimeType: 'text/plain' }, { mimeType: 'text/plain' }, {}],
            },
          },
        },
        'android.backgroundReading.ndef[2]',
      );
    });

    it('accepts a fully specified filter', () => {
      const props = resolveProps({
        android: {
          backgroundReading: {
            ndef: [{ scheme: 'https', host: 'ventry.es', pathPrefix: '/t' }],
          },
        },
      });
      expect(props.android.ndefIntentFilters).toHaveLength(1);
    });
  });

  describe('tech lists', () => {
    it('rejects an empty list, which would match every tag', () => {
      expectRejected({ android: { backgroundReading: { techLists: [[]] } } }, 'matches every tag');
    });

    it('rejects an unknown technology and lists the valid ones', () => {
      expectRejected(
        { android: { backgroundReading: { techLists: [['mifareDesfire' as 'ndef']] } } },
        'is not a technology name',
        'mifareUltralight',
      );
    });

    it('rejects a repeated technology', () => {
      expectRejected(
        { android: { backgroundReading: { techLists: [['ndef', 'ndef']] } } },
        'lists "ndef" twice',
      );
    });

    it('accepts several lists as alternatives', () => {
      const props = resolveProps({
        android: { backgroundReading: { techLists: [['isoDep'], ['mifareUltralight', 'ndef']] } },
      });
      expect(props.android.techLists).toEqual([['isoDep'], ['mifareUltralight', 'ndef']]);
    });
  });
});
