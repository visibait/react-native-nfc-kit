/**
 * The native module boundary.
 *
 * Exactly one `requireOptionalNativeModule` call exists in this library, and it is
 * here. Everything above this file receives an already-validated module, or a
 * well-formed error explaining what to do about it.
 *
 * Two failures are worth diagnosing properly rather than letting them surface as
 * "undefined is not a function", because between them they account for most of the
 * support traffic any native library gets:
 *
 * - **The native module is missing.** Almost always a JavaScript-only reload after
 *   installing the package, or an attempt to run in Expo Go, which cannot load
 *   custom native code at all.
 * - **The native module is present but older than the JavaScript.** The bundle
 *   reloads over the air; the binary does not. The result is a method that simply
 *   is not there, with nothing to say why.
 *
 * The module name is written as a literal below rather than through the
 * `NATIVE_MODULE_NAME` constant, which reads worse but is deliberate: `jest-expo`
 * finds a package's mock by regex-matching the call site's source text, so the
 * literal is what lets consumers' tests pick up the mock this package ships in
 * `mocks/NfcKit.ts`.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { NfcError, type NfcPlatform } from '../errors.js';
import { CONTRACT_VERSION, NATIVE_MODULE_NAME, type NativeNfcKitModule } from './contract.js';

/** Which platform this bundle is running on, in this library's own terms. */
export const platform: NfcPlatform =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

/** Whether this platform can host the native module at all. */
export const isNativePlatform: boolean = platform === 'ios' || platform === 'android';

/**
 * Test seam.
 *
 * The library's own tests inject a fake here rather than relying on `jest-expo`'s
 * mock discovery, which works by walking the stack and regex-matching source text.
 * That mechanism is fine for consumers but too indirect to build this library's
 * own test suite on: a refactor that moves this call would silently disable every
 * mock. `undefined` means "not overridden".
 */
let injected: NativeNfcKitModule | null | undefined;

let resolved: NativeNfcKitModule | null | undefined;

/** Set once the version check has run, so the comparison happens only on first use. */
let contractChecked = false;

function resolveModule(): NativeNfcKitModule | null {
  if (injected !== undefined) {
    return injected;
  }
  if (resolved === undefined) {
    resolved = requireOptionalNativeModule('NfcKit') as NativeNfcKitModule | null;
  }
  return resolved;
}

function missingModuleError(): NfcError {
  if (!isNativePlatform) {
    return new NfcError({
      code: 'unsupportedPlatform',
      message:
        `NFC is not available on ${Platform.OS}. The NDEF codec at ` +
        `"react-native-nfc-kit/ndef" is pure TypeScript and does work here.`,
      platform,
    });
  }

  return new NfcError({
    code: 'contractMismatch',
    message:
      `The native module "${NATIVE_MODULE_NAME}" is not installed in this app. ` +
      'NFC requires custom native code, so it cannot run in Expo Go: build a ' +
      'development build with "npx expo run:android", "npx expo run:ios" or ' +
      '"eas build". If you already have one, it needs rebuilding after installing ' +
      'this package -- reloading the JavaScript bundle alone is not enough.',
    platform,
  });
}

function contractMismatchError(nativeVersion: number): NfcError {
  const direction =
    nativeVersion < CONTRACT_VERSION
      ? 'The native binary is older than the JavaScript bundle, which is what happens ' +
        'when the bundle reloads over the air but the app was not rebuilt.'
      : 'The native binary is newer than the JavaScript bundle, which usually means a ' +
        'stale bundle is being served.';

  return new NfcError({
    code: 'contractMismatch',
    message:
      `react-native-nfc-kit expects native contract version ${CONTRACT_VERSION} but the ` +
      `installed binary reports ${nativeVersion}. ${direction} Rebuild the development ` +
      'build to bring them back into agreement.',
    platform,
    nativeCode: `contract:${nativeVersion}`,
  });
}

/**
 * Returns the native module, or throws an `NfcError` that says what to do.
 *
 * The contract check runs once, on first access, rather than at import time: a
 * module that throws while being imported takes the whole bundle down, and an app
 * that merely imports this package without using it should still start.
 */
export function getNativeModule(): NativeNfcKitModule {
  const module = resolveModule();
  if (module === null) {
    throw missingModuleError();
  }

  if (!contractChecked) {
    const nativeVersion = module.contractVersion;
    if (nativeVersion !== CONTRACT_VERSION) {
      throw contractMismatchError(typeof nativeVersion === 'number' ? nativeVersion : -1);
    }
    contractChecked = true;
  }

  return module;
}

/**
 * The native module if it is usable, or `null`.
 *
 * For the availability checks, which should answer "no" rather than throw when NFC
 * cannot work here at all.
 */
export function tryGetNativeModule(): NativeNfcKitModule | null {
  try {
    return getNativeModule();
  } catch {
    return null;
  }
}

/**
 * Replaces the native module for the duration of a test.
 *
 * Pass `null` to simulate a device where the module is not installed, or
 * `undefined` to stop overriding.
 */
export function setNativeModuleForTests(module: NativeNfcKitModule | null | undefined): void {
  injected = module;
  contractChecked = false;
}
