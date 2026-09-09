/**
 * Turning whatever crosses the native boundary into an `NfcError`.
 *
 * This is the only place that does it. In the library being replaced the
 * equivalent wrapper had to be applied by hand at roughly sixty call sites, and
 * was forgotten at two of them -- so those two rejected with a bare string, and
 * no caller could tell until it happened in production. Making it structural
 * rather than a matter of discipline is the whole point.
 *
 * Native is responsible for choosing the code. JS only validates that the code is
 * one it knows, and never guesses from a message string: the previous generation
 * encoded an `NSError` into `"domain:code"` so JavaScript could re-parse it
 * through a twenty-three branch ladder into empty `Error` subclasses with no
 * message and no code, discarding the underlying error on the way.
 */

import { NfcError, isNfcErrorCode, type NfcErrorCode, type NfcPlatform } from '../errors.js';
import type { NativeErrorPayload } from './contract.js';

/** Shape Expo Modules gives a rejection raised from Swift or Kotlin. */
interface CodedErrorLike {
  code?: unknown;
  message?: unknown;
  nativeCode?: unknown;
  recoverable?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Converts anything thrown across the boundary into an `NfcError`.
 *
 * An `NfcError` passes through untouched, so wrapping twice is harmless and the
 * original code survives. An unrecognised code becomes `internalError` with the
 * original preserved in `nativeCode` -- never silently remapped to something
 * plausible, because a code this build does not know about most likely means the
 * native binary is newer than the JavaScript.
 */
export function toNfcError(
  thrown: unknown,
  platform: NfcPlatform,
  fallbackMessage: string,
): NfcError {
  if (NfcError.is(thrown)) {
    return thrown;
  }

  const candidate = (thrown ?? {}) as CodedErrorLike;
  const rawCode = asString(candidate.code);
  const message = asString(candidate.message) ?? fallbackMessage;

  if (rawCode !== undefined && isNfcErrorCode(rawCode)) {
    return new NfcError({
      code: rawCode,
      message,
      platform,
      ...(asString(candidate.nativeCode) === undefined
        ? {}
        : { nativeCode: asString(candidate.nativeCode) as string }),
      ...(typeof candidate.recoverable === 'boolean' ? { recoverable: candidate.recoverable } : {}),
      cause: thrown,
    });
  }

  return new NfcError({
    code: 'internalError',
    message:
      rawCode === undefined
        ? message
        : `${message} (native reported the unrecognised code "${rawCode}"; the native binary may be newer than the JavaScript bundle)`,
    platform,
    ...(rawCode === undefined ? {} : { nativeCode: rawCode }),
    cause: thrown,
  });
}

/**
 * Validates an error payload that arrived on an event.
 *
 * Events cannot reject, so native attaches an error object instead. It goes
 * through the same validation as a rejection: a code JS does not recognise is
 * reported as `internalError` rather than trusted.
 */
export function fromNativeErrorPayload(
  payload: NativeErrorPayload,
  platform: NfcPlatform,
): NfcError {
  const code: NfcErrorCode = isNfcErrorCode(payload.code) ? payload.code : 'internalError';
  const suffix = code === payload.code ? '' : ` (unrecognised native code "${payload.code}")`;

  return new NfcError({
    code,
    message: `${payload.message}${suffix}`,
    platform,
    ...(payload.nativeCode === null ? {} : { nativeCode: payload.nativeCode }),
    ...(payload.recoverable === null ? {} : { recoverable: payload.recoverable }),
  });
}

/**
 * Wraps a native call so its rejection is always an `NfcError`.
 *
 * Applied once, in the module boundary, rather than at every call site.
 */
export async function callNative<T>(
  platform: NfcPlatform,
  what: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (thrown) {
    throw toNfcError(thrown, platform, `${what} failed.`);
  }
}
