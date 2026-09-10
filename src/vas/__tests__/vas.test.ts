import { resetActiveSessionForTests } from '../../core/session.js';
import { NfcError } from '../../errors.js';
import { FakeNativeModule } from '../../native/__tests__/fakeNative.js';
import { setNativeModuleForTests } from '../../native/module.js';
import { VAS_STATUS, vas } from '../vas.js';

let native: FakeNativeModule;

beforeEach(() => {
  native = new FakeNativeModule();
  setNativeModuleForTests(native);
});

afterEach(() => {
  setNativeModuleForTests(undefined);
  resetActiveSessionForTests();
});

const PASS = 'pass.es.ventry.entrada';

describe('isSupported', () => {
  it('reports what the platform says', async () => {
    await expect(vas.isSupported()).resolves.toBe(false);

    native.vasSupported = true;
    await expect(vas.isSupported()).resolves.toBe(true);
  });
});

describe('read', () => {
  it('asks for the pass types it was given', async () => {
    await vas.read({
      configurations: [{ passTypeIdentifier: PASS }],
      alertMessage: 'Hold the pass near the phone',
    });

    expect(native.vasOptions).toEqual({
      configurations: [{ mode: 'normal', passTypeIdentifier: PASS, url: null }],
      alertMessage: 'Hold the pass near the phone',
    });
  });

  it('defaults to the mode that actually reads a pass', async () => {
    await vas.read({ configurations: [{ passTypeIdentifier: PASS }] });

    expect(native.vasOptions?.configurations[0]?.mode).toBe('normal');
  });

  it('passes several pass types through, which is how a till accepts more than one', async () => {
    await vas.read({
      configurations: [
        { passTypeIdentifier: PASS },
        { passTypeIdentifier: 'pass.es.ventry.abono', mode: 'urlOnly', url: 'https://ventry.es' },
      ],
    });

    expect(native.vasOptions?.configurations).toEqual([
      { mode: 'normal', passTypeIdentifier: PASS, url: null },
      { mode: 'urlOnly', passTypeIdentifier: 'pass.es.ventry.abono', url: 'https://ventry.es' },
    ]);
  });

  it('decodes the pass payload and the token', async () => {
    native.vasResponses = [
      {
        status: VAS_STATUS.success,
        statusName: 'success',
        vasDataHex: 'deadbeef',
        mobileTokenHex: '0102',
      },
    ];

    const [response] = await vas.read({ configurations: [{ passTypeIdentifier: PASS }] });

    expect(response).toEqual({
      status: 0x9000,
      statusName: 'success',
      vasData: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      mobileToken: new Uint8Array([0x01, 0x02]),
    });
  });

  it('reports a pass the phone does not hold, by name', async () => {
    // A named status is the difference between "the user has no such pass" and
    // "something went wrong", which a bare 0x6A83 does not tell anyone.
    native.vasResponses = [
      {
        status: VAS_STATUS.dataNotFound,
        statusName: 'dataNotFound',
        vasDataHex: '',
        mobileTokenHex: '',
      },
    ];

    const [response] = await vas.read({ configurations: [{ passTypeIdentifier: PASS }] });

    expect(response?.statusName).toBe('dataNotFound');
    expect(response?.vasData).toHaveLength(0);
  });

  it('calls an unrecognised status unknown rather than trusting it', async () => {
    native.vasResponses = [
      { status: 0x6f00, statusName: 'somethingNew', vasDataHex: '', mobileTokenHex: '' },
    ];

    const [response] = await vas.read({ configurations: [{ passTypeIdentifier: PASS }] });

    expect(response?.statusName).toBe('unknown');
    expect(response?.status).toBe(0x6f00);
  });

  it('uses the same status word scheme as the rest of the library', () => {
    // Not a separate set of numbers: `success` here is the `9000` that every APDU
    // in this library answers with.
    expect(VAS_STATUS.success).toBe(0x9000);
    expect(VAS_STATUS.wrongLength).toBe(0x6700);
  });

  describe('rejects a request that would ask for nothing', () => {
    it('with no configurations', async () => {
      await expect(vas.read({ configurations: [] })).rejects.toMatchObject({
        code: 'invalidArgument',
      });
      expect(native.callsTo('readVas')).toHaveLength(0);
    });

    it('with an empty pass type identifier', async () => {
      await expect(
        vas.read({ configurations: [{ passTypeIdentifier: '  ' }] }),
      ).rejects.toBeInstanceOf(NfcError);
    });

    it('with a mode that is not a mode', async () => {
      await expect(
        vas.read({
          configurations: [{ passTypeIdentifier: PASS, mode: 'full' as 'normal' }],
        }),
      ).rejects.toMatchObject({ code: 'invalidArgument' });
    });

    it('with urlOnly and no url', async () => {
      // CoreNFC accepts this and then hands the pass nothing, so it is caught here.
      await expect(
        vas.read({ configurations: [{ passTypeIdentifier: PASS, mode: 'urlOnly' }] }),
      ).rejects.toMatchObject({ code: 'invalidArgument' });
    });
  });

  it('surfaces a missing entitlement as such', async () => {
    // The only way to discover it: there is no API that reports whether Apple
    // granted the entitlement, so the first read is the test.
    native.rejectWith(
      'readVas',
      new NfcError({
        code: 'entitlementMissing',
        message: 'The session was refused.',
        platform: 'ios',
      }),
    );

    await expect(
      vas.read({ configurations: [{ passTypeIdentifier: PASS }] }),
    ).rejects.toMatchObject({ code: 'entitlementMissing' });
  });
});
