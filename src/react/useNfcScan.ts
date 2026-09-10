import { useCallback, useEffect, useRef, useState } from 'react';

import { nfc } from '../core/nfc.js';
import type { ScanOptions } from '../core/session.js';
import type { Tag } from '../core/tag.js';
import { NfcError } from '../errors.js';
import { platform } from '../native/module.js';

export type NfcScanState = 'idle' | 'scanning' | 'success' | 'error';

export interface UseNfcScanResult<T> {
  /**
   * Starts a scan. Never rejects: the outcome lands in `state`, `data` and
   * `error`, which is what a button's `onPress` wants.
   *
   * Resolves to `null` when the scan failed or was cancelled.
   */
  readonly scan: () => Promise<T | null>;
  /**
   * The same scan, but it rejects, for imperative flows.
   *
   * It rejects with exactly what was thrown, so an error your own `work` threw
   * comes back unchanged. `error` below is normalised to an `NfcError` instead,
   * because a state field needs one type.
   */
  readonly scanAsync: () => Promise<T>;
  /** Cancels a scan in progress. Safe to call when nothing is running. */
  readonly cancel: () => void;
  /** Returns to `idle`, clearing `data` and `error`. */
  readonly reset: () => void;
  readonly state: NfcScanState;
  readonly scanning: boolean;
  readonly data: T | null;
  readonly error: NfcError | null;
}

/** Turns anything thrown into an `NfcError`, so `error` has one type. */
function toNfcError(cause: unknown): NfcError {
  return NfcError.is(cause)
    ? cause
    : new NfcError({
        code: 'internalError',
        message: cause instanceof Error ? cause.message : 'The scan failed.',
        platform,
        cause,
      });
}

/**
 * One scan, driven from a component.
 *
 * ```tsx
 * const { scan, cancel, scanning, data, error } = useNfcScan(async (tag) => {
 *   if (!tag.is('ndef')) throw new Error('Not an NDEF tag');
 *   return tag.readNdef();
 * }, { tech: ['ndef'], timeoutMs: 20_000 });
 *
 * <Button title={scanning ? 'Cancel' : 'Scan'} onPress={scanning ? cancel : scan} />
 * ```
 *
 * Three things this handles that hand-written versions usually do not:
 *
 * - **Unmounting cancels the scan.** Navigating away mid-scan would otherwise
 *   leave the iOS sheet up and Android's NFC controller held, and the next scan
 *   fails with `systemBusy` for reasons that are nowhere on screen.
 * - **A second `scan()` while one is running joins the first** rather than
 *   starting a second session. A double tap is not a request for two sessions.
 * - **`work` and `options` are read at call time**, so they never need to be
 *   memoised and a stale closure cannot read last render's state.
 *
 * Cancelling settles as `idle` rather than `error`: the user asked for it, so
 * there is nothing to report to them.
 */
export function useNfcScan<T>(
  work: (tag: Tag) => Promise<T> | T,
  options: ScanOptions,
): UseNfcScanResult<T> {
  const [state, setState] = useState<NfcScanState>('idle');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<NfcError | null>(null);

  // Latest values, read when the scan actually starts. Without this, `scan`
  // would have to change identity on every render to stay correct, which turns
  // every `useEffect` that depends on it into a loop.
  //
  // Assigned after commit rather than during render: a render React discards
  // must not leave a mutation behind. A scan always starts from an event
  // handler, which runs after the commit, so it never reads a stale value.
  const latest = useRef({ work, options });
  useEffect(() => {
    latest.current = { work, options };
  });

  const mountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<Promise<T> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Cancels rather than merely ignoring the result: the session is real and
      // outlives the component unless something ends it.
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setState('idle');
    setData(null);
    setError(null);
  }, []);

  const scanAsync = useCallback((): Promise<T> => {
    const existing = inFlightRef.current;
    if (existing !== null) {
      return existing;
    }

    const controller = new AbortController();
    const { signal: callerSignal, ...rest } = latest.current.options;

    // A signal passed in the options still works: whichever fires first wins.
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) {
        controller.abort(callerSignal.reason);
      } else {
        callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), {
          once: true,
        });
      }
    }

    controllerRef.current = controller;
    setState('scanning');
    setError(null);

    const promise = Promise.resolve(
      nfc.withTag({ ...rest, signal: controller.signal }, (tag) => latest.current.work(tag)),
    );

    inFlightRef.current = promise;

    void promise.then(
      (value) => {
        inFlightRef.current = null;
        controllerRef.current = null;
        if (mountedRef.current) {
          setData(value);
          setState('success');
        }
      },
      (cause: unknown) => {
        inFlightRef.current = null;
        controllerRef.current = null;
        if (!mountedRef.current) {
          return;
        }
        const nfcError = toNfcError(cause);
        // Cancellation is not a failure to report; the user asked for it.
        if (nfcError.code === 'aborted' || nfcError.code === 'userCancelled') {
          setState('idle');
          return;
        }
        setError(nfcError);
        setState('error');
      },
    );

    return promise;
  }, []);

  const scan = useCallback((): Promise<T | null> => scanAsync().catch(() => null), [scanAsync]);

  return { scan, scanAsync, cancel, reset, state, scanning: state === 'scanning', data, error };
}
