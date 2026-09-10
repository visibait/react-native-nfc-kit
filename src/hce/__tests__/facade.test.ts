import { FakeNativeModule } from '../../native/__tests__/fakeNative.js';
import { setNativeModuleForTests } from '../../native/module.js';
import { statusResponse, StatusWord } from '../apdu.js';
import { hce } from '../facade.js';
import { resetHceForTests } from '../session.js';

/**
 * The facade is five delegations, which is exactly where calling the wrong
 * function hides: every one of these would still type-check while doing the wrong
 * thing, and none of them is reached by the tests that inject dependencies
 * directly.
 */

let native: FakeNativeModule;

beforeEach(() => {
  native = new FakeNativeModule();
  setNativeModuleForTests(native);
});

afterEach(() => {
  setNativeModuleForTests(undefined);
  resetHceForTests();
});

describe('the hce facade', () => {
  it('asks native whether card emulation is possible', async () => {
    native.hceSupported = false;

    await expect(hce.isSupported()).resolves.toBe(false);
    expect(native.callsTo('isHceSupported')).toHaveLength(1);
  });

  it('asks native whether observe mode is possible', async () => {
    native.observeModeSupported = true;

    await expect(hce.isObserveModeSupported()).resolves.toBe(true);
    expect(native.callsTo('isObserveModeSupported')).toHaveLength(1);
  });

  it('starts a session using the handler it was given', async () => {
    const session = await hce.start({ onCommand: () => statusResponse(StatusWord.ok) });

    expect(native.hceStarted).toBe(true);
    await session.stop();
    expect(native.hceStarted).toBe(false);
  });

  it('emulates an NDEF tag holding the message it was given', async () => {
    const message = new Uint8Array([0xd0, 0x00, 0x00]);
    const session = await hce.emulateNdef(message);

    expect(session.message).toEqual(message);
    await session.stop();
  });

  it('passes emulation options through', async () => {
    const session = await hce.emulateNdef(new Uint8Array(), { aids: ['F0010203040506'] });

    expect(native.hceOptions?.aids).toEqual(['F0010203040506']);
    await session.stop();
  });
});
