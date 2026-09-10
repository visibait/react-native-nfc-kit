import { act, renderHook, waitFor } from '@testing-library/react-native';

import { resetActiveSessionForTests } from '../../core/session.js';
import type { Tag } from '../../core/tag.js';
import { NfcError } from '../../errors.js';
import { FakeNativeModule, fakeTagInfo } from '../../native/__tests__/fakeNative.js';
import { setNativeModuleForTests } from '../../native/module.js';
import { useNfcScan } from '../useNfcScan.js';

let native: FakeNativeModule;

beforeEach(() => {
  native = new FakeNativeModule();
  setNativeModuleForTests(native);
});

afterEach(() => {
  setNativeModuleForTests(undefined);
  resetActiveSessionForTests();
});

/** The session id native was last asked to start. */
function startedSessionId(): string {
  const call = native.lastCallTo('startSession');
  if (call === undefined) {
    throw new Error('startSession was never called');
  }
  return call.args[0] as string;
}

/**
 * Waits for the nth session to exist, then hands it a tag.
 *
 * The count matters because a test that scans twice would otherwise deliver the
 * second tag to the first session's id.
 */
async function deliverTag(sessionCount = 1): Promise<void> {
  await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(sessionCount));
  await act(() => {
    native.emitTagDiscovered(startedSessionId(), fakeTagInfo());
  });
}

const OPTIONS = { tech: ['ndef'] } as const;

describe('useNfcScan', () => {
  it('starts idle and holds no result', async () => {
    const { result } = await renderHook(() => useNfcScan(async (tag) => tag.id, OPTIONS));

    expect(result.current.state).toBe('idle');
    expect(result.current.scanning).toBe(false);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('reports the work function result', async () => {
    const { result } = await renderHook(() =>
      useNfcScan(async (tag: Tag) => (tag.is('ndef') ? 'read' : 'other'), OPTIONS),
    );

    let scan!: Promise<string | null>;
    await act(() => {
      scan = result.current.scan();
    });
    expect(result.current.scanning).toBe(true);

    await deliverTag();

    await expect(scan).resolves.toBe('read');
    await waitFor(() => expect(result.current.state).toBe('success'));
    expect(result.current.data).toBe('read');
  });

  it('closes the session even when the work throws', async () => {
    const { result } = await renderHook(() =>
      useNfcScan(() => {
        throw new NfcError({ code: 'ndefMalformed', message: 'bad record', platform: 'android' });
      }, OPTIONS),
    );

    await act(() => {
      void result.current.scan();
    });
    await deliverTag();

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error?.code).toBe('ndefMalformed');
    // The leak this prevents is not abstract: an unclosed session keeps the iOS
    // sheet up and holds Android's controller, and the next scan fails.
    expect(native.callsTo('closeSession')).toHaveLength(1);
  });

  it('resolves scan() to null on failure rather than rejecting', async () => {
    // `onPress={scan}` is the normal way to call this, and a rejected floating
    // promise there is an unhandled rejection in the app, not a caught error.
    const { result } = await renderHook(() =>
      useNfcScan(() => {
        throw new Error('boom');
      }, OPTIONS),
    );

    let scan!: Promise<unknown>;
    await act(() => {
      scan = result.current.scan();
    });
    await deliverTag();

    await expect(scan).resolves.toBeNull();
    await waitFor(() => expect(result.current.state).toBe('error'));
  });

  it('rejects from scanAsync, handing back exactly what was thrown', async () => {
    // `error` is normalised to an NfcError so the state has one type; scanAsync
    // is not, so a caller's own domain error survives the round trip.
    class TicketRejected extends Error {}

    const { result } = await renderHook(() =>
      useNfcScan(() => {
        throw new TicketRejected('expired');
      }, OPTIONS),
    );

    let scan!: Promise<unknown>;
    await act(() => {
      scan = result.current.scanAsync();
    });
    await deliverTag();

    await expect(scan).rejects.toBeInstanceOf(TicketRejected);
    await waitFor(() => expect(result.current.error).toBeInstanceOf(NfcError));
  });

  it('rejects from scanAsync with an NfcError when NFC itself failed', async () => {
    const { result } = await renderHook(() => useNfcScan(async (tag: Tag) => tag.id, OPTIONS));

    let scan!: Promise<unknown>;
    await act(() => {
      scan = result.current.scanAsync();
    });
    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));

    await act(() => {
      native.emitSessionInvalidated(startedSessionId(), {
        code: 'tagLost',
        message: 'The tag moved away.',
        nativeCode: null,
        recoverable: null,
      });
    });

    await expect(scan).rejects.toBeInstanceOf(NfcError);
  });

  it('wraps a non-NfcError throw so error always has a code', async () => {
    const { result } = await renderHook(() =>
      useNfcScan(() => {
        throw new Error('boom');
      }, OPTIONS),
    );

    await act(() => {
      void result.current.scan();
    });
    await deliverTag();

    await waitFor(() => expect(result.current.error?.code).toBe('internalError'));
    expect(result.current.error?.message).toBe('boom');
  });

  it('describes a throw that was not an Error at all', async () => {
    // `throw 'expired'` happens, and an error state reading "undefined" helps
    // nobody.
    const { result } = await renderHook(() =>
      useNfcScan(() => {
        throw 'expired';
      }, OPTIONS),
    );

    await act(() => {
      void result.current.scan();
    });
    await deliverTag();

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error?.message).toBe('The scan failed.');
    expect(result.current.error?.cause).toBe('expired');
  });

  it('joins a second scan to the first instead of opening two sessions', async () => {
    // A double tap is not a request for two sessions, and the second would fail
    // with `systemBusy` for reasons that are nowhere on screen.
    const { result } = await renderHook(() => useNfcScan(async (tag: Tag) => tag.id, OPTIONS));

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(() => {
      first = result.current.scan();
      second = result.current.scan();
    });

    await deliverTag();
    await Promise.all([first, second]);

    expect(native.callsTo('startSession')).toHaveLength(1);
  });

  it('can scan again after finishing', async () => {
    const { result } = await renderHook(() => useNfcScan(async (tag: Tag) => tag.id, OPTIONS));

    await act(() => {
      void result.current.scan();
    });
    await deliverTag();
    await waitFor(() => expect(result.current.state).toBe('success'));

    await act(() => {
      void result.current.scan();
    });
    await deliverTag(2);

    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(2));
  });

  describe('cancelling', () => {
    it('returns to idle rather than reporting an error', async () => {
      const { result } = await renderHook(() => useNfcScan(async (tag: Tag) => tag.id, OPTIONS));

      await act(() => {
        void result.current.scan();
      });
      await waitFor(() => expect(result.current.scanning).toBe(true));

      await act(() => {
        result.current.cancel();
      });

      // The user asked for it, so there is nothing to report back to them.
      await waitFor(() => expect(result.current.state).toBe('idle'));
      expect(result.current.error).toBeNull();
    });

    it('closes the session', async () => {
      const { result } = await renderHook(() => useNfcScan(async (tag: Tag) => tag.id, OPTIONS));

      await act(() => {
        void result.current.scan();
      });
      await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));

      await act(() => {
        result.current.cancel();
      });

      await waitFor(() => expect(native.callsTo('closeSession')).toHaveLength(1));
    });

    it('does nothing when no scan is running', async () => {
      const { result } = await renderHook(() => useNfcScan(async (tag: Tag) => tag.id, OPTIONS));

      expect(() => result.current.cancel()).not.toThrow();
      expect(native.callsTo('startSession')).toHaveLength(0);
    });

    it('honours a signal passed in the options', async () => {
      const controller = new AbortController();
      const { result } = await renderHook(() =>
        useNfcScan(async (tag: Tag) => tag.id, { tech: ['ndef'], signal: controller.signal }),
      );

      await act(() => {
        void result.current.scan();
      });
      await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));

      await act(() => {
        controller.abort();
      });

      await waitFor(() => expect(result.current.state).toBe('idle'));
      expect(native.callsTo('closeSession')).toHaveLength(1);
    });

    it('never starts when the options signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const { result } = await renderHook(() =>
        useNfcScan(async (tag: Tag) => tag.id, { tech: ['ndef'], signal: controller.signal }),
      );

      await act(() => {
        void result.current.scan();
      });

      await waitFor(() => expect(result.current.state).toBe('idle'));
      expect(native.callsTo('startSession')).toHaveLength(0);
    });
  });

  it('cancels the scan when the component unmounts', async () => {
    // Navigating away mid-scan otherwise leaves the sheet up on iOS and the
    // controller held on Android, and the failure surfaces on some later screen.
    const { result, unmount } = await renderHook(() =>
      useNfcScan(async (tag: Tag) => tag.id, OPTIONS),
    );

    await act(() => {
      void result.current.scan();
    });
    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));

    await unmount();

    await waitFor(() => expect(native.callsTo('closeSession')).toHaveLength(1));
  });

  it('does not set state when the work finishes after unmount', async () => {
    // Unmount cancels the session, but work already in flight is the caller's
    // own promise and finishes on its own schedule. React logs an act() warning
    // for a state update outside a render pass, so an unguarded one shows here.
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    let finishWork!: (value: string) => void;

    try {
      const { result, unmount } = await renderHook(() =>
        useNfcScan(
          () =>
            new Promise<string>((resolve) => {
              finishWork = resolve;
            }),
          OPTIONS,
        ),
      );

      await act(() => {
        void result.current.scan();
      });
      await deliverTag();
      await unmount();

      await act(() => {
        finishWork('done');
      });

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reads the work function and options at call time', async () => {
    // Otherwise `scan` has to change identity every render to stay correct, and
    // every effect that depends on it becomes a loop.
    const { result, rerender } = await renderHook(
      ({ label }: { label: string }) => useNfcScan(() => label, { tech: ['ndef'] }),
      { initialProps: { label: 'first' } },
    );

    const initialScan = result.current.scan;
    await rerender({ label: 'second' });
    expect(result.current.scan).toBe(initialScan);

    await act(() => {
      void result.current.scan();
    });
    await deliverTag();

    await waitFor(() => expect(result.current.data).toBe('second'));
  });

  it('clears state on reset', async () => {
    const { result } = await renderHook(() => useNfcScan(async (tag: Tag) => tag.id, OPTIONS));

    await act(() => {
      void result.current.scan();
    });
    await deliverTag();
    await waitFor(() => expect(result.current.state).toBe('success'));

    await act(() => {
      result.current.reset();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
