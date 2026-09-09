import type { NfcError } from '../../errors.js';
import { CONTRACT_VERSION } from '../contract.js';
import {
  getNativeModule,
  isNativePlatform,
  platform,
  setNativeModuleForTests,
  tryGetNativeModule,
} from '../module.js';
import { FakeNativeModule } from './fakeNative.js';

afterEach(() => {
  setNativeModuleForTests(undefined);
});

describe('platform detection', () => {
  it('reports a native platform under the test preset', () => {
    // jest-expo defaults to iOS, so this is the iOS branch.
    expect(platform).toBe('ios');
    expect(isNativePlatform).toBe(true);
  });
});

describe('getNativeModule', () => {
  it('returns the module when the contract versions agree', () => {
    const fake = new FakeNativeModule();
    setNativeModuleForTests(fake);

    expect(getNativeModule()).toBe(fake);
  });

  it('explains what to do when the module is not installed', () => {
    // The most common cause by far: a JavaScript reload after installing the
    // package, or an attempt to run in Expo Go.
    setNativeModuleForTests(null);

    try {
      getNativeModule();
      throw new Error('should have thrown');
    } catch (thrown) {
      const error = thrown as NfcError;
      expect(error.code).toBe('contractMismatch');
      expect(error.message).toContain('Expo Go');
      expect(error.message).toContain('expo run:');
      expect(error.message).toContain('rebuilding');
    }
  });

  it('reports a binary older than the bundle, and says why that happens', () => {
    setNativeModuleForTests(new FakeNativeModule({ contractVersion: CONTRACT_VERSION - 1 }));

    try {
      getNativeModule();
      throw new Error('should have thrown');
    } catch (thrown) {
      const error = thrown as NfcError;
      expect(error.code).toBe('contractMismatch');
      expect(error.message).toContain('older than the JavaScript bundle');
      expect(error.message).toContain('over the air');
      expect(error.nativeCode).toBe(`contract:${CONTRACT_VERSION - 1}`);
    }
  });

  it('reports a binary newer than the bundle', () => {
    setNativeModuleForTests(new FakeNativeModule({ contractVersion: CONTRACT_VERSION + 1 }));

    try {
      getNativeModule();
      throw new Error('should have thrown');
    } catch (thrown) {
      const error = thrown as NfcError;
      expect(error.message).toContain('newer than the JavaScript bundle');
      expect(error.message).toContain('stale bundle');
    }
  });

  it('handles a binary that reports no version at all', () => {
    const fake = new FakeNativeModule();
    // A binary from before the contract version existed.
    (fake as { contractVersion: unknown }).contractVersion = undefined;
    setNativeModuleForTests(fake);

    try {
      getNativeModule();
      throw new Error('should have thrown');
    } catch (thrown) {
      expect((thrown as NfcError).nativeCode).toBe('contract:-1');
    }
  });

  it('checks the contract only once', () => {
    const fake = new FakeNativeModule();
    let reads = 0;
    Object.defineProperty(fake, 'contractVersion', {
      get: () => {
        reads += 1;
        return CONTRACT_VERSION;
      },
    });
    setNativeModuleForTests(fake);

    getNativeModule();
    getNativeModule();
    getNativeModule();

    expect(reads).toBe(1);
  });
});

describe('tryGetNativeModule', () => {
  it('returns the module when it is usable', () => {
    const fake = new FakeNativeModule();
    setNativeModuleForTests(fake);

    expect(tryGetNativeModule()).toBe(fake);
  });

  it('returns null instead of throwing when the module is missing', () => {
    // The availability checks need to answer "no", not blow up.
    setNativeModuleForTests(null);
    expect(tryGetNativeModule()).toBeNull();
  });

  it('returns null on a contract mismatch too', () => {
    setNativeModuleForTests(new FakeNativeModule({ contractVersion: 999 }));
    expect(tryGetNativeModule()).toBeNull();
  });
});
