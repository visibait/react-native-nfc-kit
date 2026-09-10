import { decideDispatchPermission, resolveTargetSdkVersion } from '../targetSdk';

describe('resolveTargetSdkVersion', () => {
  it('reads an explicit targetSdkVersion from expo-build-properties', () => {
    expect(
      resolveTargetSdkVersion({
        plugins: [['expo-build-properties', { android: { targetSdkVersion: 37 } }]],
      }),
    ).toBe(37);
  });

  it('accepts the plugin referenced by path', () => {
    expect(
      resolveTargetSdkVersion({
        plugins: [['./node_modules/expo-build-properties', { android: { targetSdkVersion: 35 } }]],
      }),
    ).toBe(35);
  });

  it('takes the last entry when the plugin is listed more than once', () => {
    // Expo applies plugins in order, so the later one is what actually lands.
    expect(
      resolveTargetSdkVersion({
        plugins: [
          ['expo-build-properties', { android: { targetSdkVersion: 35 } }],
          ['expo-build-properties', { android: { targetSdkVersion: 37 } }],
        ],
      }),
    ).toBe(37);
  });

  it('ignores an earlier entry that carries no target SDK', () => {
    expect(
      resolveTargetSdkVersion({
        plugins: [
          ['expo-build-properties', { android: { targetSdkVersion: 37 } }],
          ['expo-build-properties', { android: { compileSdkVersion: 37 } }],
        ],
      }),
    ).toBe(37);
  });

  describe('returns undefined rather than guessing', () => {
    it('when there are no plugins at all', () => {
      expect(resolveTargetSdkVersion({})).toBeUndefined();
      expect(resolveTargetSdkVersion({ plugins: undefined })).toBeUndefined();
    });

    it('when plugins is not an array', () => {
      expect(resolveTargetSdkVersion({ plugins: 'expo-build-properties' })).toBeUndefined();
    });

    it('when the plugin is listed without options', () => {
      expect(resolveTargetSdkVersion({ plugins: ['expo-build-properties'] })).toBeUndefined();
      expect(resolveTargetSdkVersion({ plugins: [['expo-build-properties']] })).toBeUndefined();
    });

    it('when a different plugin sets a targetSdkVersion', () => {
      expect(
        resolveTargetSdkVersion({
          plugins: [['some-other-plugin', { android: { targetSdkVersion: 37 } }]],
        }),
      ).toBeUndefined();
    });

    it('when the name merely contains the package name', () => {
      expect(
        resolveTargetSdkVersion({
          plugins: [['my-expo-build-properties-fork', { android: { targetSdkVersion: 37 } }]],
        }),
      ).toBeUndefined();
    });

    it('when the plugin entry is not named by a string', () => {
      // An inline plugin function is a legitimate entry; it just is not this one.
      expect(
        resolveTargetSdkVersion({
          plugins: [[() => ({}), { android: { targetSdkVersion: 37 } }]],
        }),
      ).toBeUndefined();
      expect(
        resolveTargetSdkVersion({ plugins: [[null, { android: { targetSdkVersion: 37 } }]] }),
      ).toBeUndefined();
    });

    it('when the value is not an integer', () => {
      const notIntegers = ['37', 37.5, null, undefined, {}];

      for (const targetSdkVersion of notIntegers) {
        expect(
          resolveTargetSdkVersion({
            plugins: [['expo-build-properties', { android: { targetSdkVersion } }]],
          }),
        ).toBeUndefined();
      }
    });

    it('when the options are shaped unexpectedly', () => {
      const badOptions = [null, 'android', { android: null }, { android: 'yes' }, {}];

      for (const options of badOptions) {
        expect(
          resolveTargetSdkVersion({ plugins: [['expo-build-properties', options]] }),
        ).toBeUndefined();
      }
    });
  });
});

describe('decideDispatchPermission', () => {
  const enabled = { backgroundReadingEnabled: true } as const;

  describe('when set explicitly', () => {
    it('obeys true even with no background reading', () => {
      expect(
        decideDispatchPermission({
          setting: true,
          backgroundReadingEnabled: false,
          targetSdkVersion: 30,
        }),
      ).toEqual({ apply: true });
    });

    it('obeys false even on API 37', () => {
      expect(
        decideDispatchPermission({ setting: false, ...enabled, targetSdkVersion: 37 }),
      ).toEqual({ apply: false });
    });
  });

  describe('on auto', () => {
    it('does nothing without background reading, since reader mode gets no intents', () => {
      expect(
        decideDispatchPermission({
          setting: 'auto',
          backgroundReadingEnabled: false,
          targetSdkVersion: 37,
        }),
      ).toEqual({ apply: false });
    });

    it('applies the permission from API 37 up', () => {
      expect(
        decideDispatchPermission({ setting: 'auto', ...enabled, targetSdkVersion: 37 }),
      ).toEqual({ apply: true });
      expect(
        decideDispatchPermission({ setting: 'auto', ...enabled, targetSdkVersion: 38 }),
      ).toEqual({ apply: true });
    });

    it('withholds it below API 37', () => {
      // The permission does not exist on those platforms, so nothing can hold it
      // and the activity becomes undispatchable -- the same failure it is meant
      // to prevent, on every older device instead of the new ones.
      expect(
        decideDispatchPermission({ setting: 'auto', ...enabled, targetSdkVersion: 36 }),
      ).toEqual({ apply: false });
    });

    it('warns rather than guessing when the target SDK is unknown', () => {
      const decision = decideDispatchPermission({
        setting: 'auto',
        ...enabled,
        targetSdkVersion: undefined,
      });

      expect(decision.apply).toBe(false);
      expect(decision.warning).toContain('DISPATCH_NFC_MESSAGE');
      expect(decision.warning).toContain('dispatchNfcMessagePermission');
    });

    it('stays silent in every case it can decide', () => {
      const decided = [
        decideDispatchPermission({ setting: 'auto', ...enabled, targetSdkVersion: 37 }),
        decideDispatchPermission({ setting: 'auto', ...enabled, targetSdkVersion: 36 }),
        decideDispatchPermission({
          setting: 'auto',
          backgroundReadingEnabled: false,
          targetSdkVersion: undefined,
        }),
        decideDispatchPermission({ setting: true, ...enabled, targetSdkVersion: undefined }),
      ];

      for (const decision of decided) {
        expect(decision.warning).toBeUndefined();
      }
    });
  });
});
