/**
 * Cancellation and deadlines.
 *
 * Every awaitable in the public API accepts an `AbortSignal` and a `timeoutMs`.
 * The library being replaced had neither: a native method that never invoked its
 * callback leaked the promise for the lifetime of the process, and the only
 * timeout anywhere was CoreNFC's own 60 second session limit surfacing as an
 * opaque error code.
 *
 * ## What cancellation can and cannot do
 *
 * Being honest about this matters more than the feature itself. Expo Modules has
 * no way to cancel a native call in flight. So aborting an operation settles the
 * JavaScript promise immediately, but the native work continues to completion --
 * a `transceive` already on the wire will finish talking to the tag.
 *
 * What actually stops the hardware is closing the session, which drops reader mode
 * on Android and invalidates the session on iOS. `withTag` always does that on the
 * way out, including when the abort is what caused the exit, so the observable
 * behaviour is what a caller expects. The distinction only shows up if you abort
 * an operation and then keep using the same tag.
 */

import { NfcError } from '../errors.js';

export interface Deadline {
  /** Rejects with `aborted` when the signal fires. */
  readonly signal?: AbortSignal | undefined;
  /** Rejects with `timeout` after this many milliseconds. */
  readonly timeoutMs?: number | undefined;
}

/** The error an aborted operation rejects with. */
export function abortedError(what: string): NfcError {
  return new NfcError({
    code: 'aborted',
    message: `${what} was aborted.`,
  });
}

/** The error a timed-out operation rejects with. */
export function timeoutError(what: string, timeoutMs: number): NfcError {
  return new NfcError({
    code: 'timeout',
    message: `${what} did not complete within ${timeoutMs} ms.`,
  });
}

/**
 * Reads the reason an `AbortSignal` carries, preserving an `NfcError` if that is
 * what the caller aborted with.
 */
function reasonToError(signal: AbortSignal, what: string): NfcError {
  const { reason } = signal;
  if (NfcError.is(reason)) {
    return reason;
  }
  return new NfcError({
    code: 'aborted',
    message: `${what} was aborted.`,
    ...(reason === undefined ? {} : { cause: reason }),
  });
}

/**
 * Races `promise` against an abort signal and an optional timeout.
 *
 * The timer is always cleared and the abort listener always removed, whichever
 * way the race ends. Leaking either would keep a Node process alive or hold a
 * closure over a tag that is long gone.
 */
export function withDeadline<T>(promise: Promise<T>, deadline: Deadline, what: string): Promise<T> {
  const { signal, timeoutMs } = deadline;

  if (signal?.aborted === true) {
    // Already aborted before the call: do not start waiting at all.
    return Promise.reject(reasonToError(signal, what));
  }

  // Deliberately not an `async` function, so this really is the same promise
  // rather than a fresh one wrapping it. Most calls take no deadline at all.
  if (signal === undefined && timeoutMs === undefined) {
    return promise;
  }

  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return Promise.reject(
      new NfcError({
        code: 'invalidArgument',
        message: `timeoutMs must be a positive finite number, received ${timeoutMs}.`,
      }),
    );
  }

  return race(promise, signal, timeoutMs, what);
}

async function race<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    return await new Promise<T>((resolve, reject) => {
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          reject(timeoutError(what, timeoutMs));
        }, timeoutMs);
      }

      if (signal !== undefined) {
        onAbort = () => {
          reject(reasonToError(signal, what));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined && signal !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Like {@link withDeadline}, but takes a thunk so the work is never started when
 * the signal has already fired.
 *
 * The difference is not cosmetic. `withDeadline` receives a promise, which means
 * the call it wraps has already been made -- so an operation aborted before it
 * began would still reach the tag, and on Android that means an exchange over the
 * air that nobody is waiting for. Prefer this wherever the work touches hardware.
 */
export async function runWithDeadline<T>(
  start: () => Promise<T>,
  deadline: Deadline,
  what: string,
): Promise<T> {
  if (deadline.signal?.aborted === true) {
    throw reasonToError(deadline.signal, what);
  }
  return withDeadline(start(), deadline, what);
}

/**
 * A promise that can be settled from elsewhere.
 *
 * Used to hand a tag from the native discovery event to whoever is awaiting one.
 * It refuses to settle twice: resolving an already-settled deferred is a no-op
 * rather than a throw, because native delivering the same event twice is a bug
 * that should not become a crash in the caller's code.
 *
 * That failure mode is not hypothetical. The equivalent in the library being
 * replaced invoked its callback twice on one iOS path, which is fatal under the
 * New Architecture, and the Android side caught the resulting exception and
 * discarded it.
 */
export class Deferred<T> {
  readonly promise: Promise<T>;

  private settleResolve!: (value: T) => void;
  private settleReject!: (error: unknown) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.settleResolve = resolve;
      this.settleReject = reject;
    });
  }

  get isSettled(): boolean {
    return this.settled;
  }

  resolve(value: T): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.settleResolve(value);
  }

  reject(error: unknown): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.settleReject(error);
  }
}
