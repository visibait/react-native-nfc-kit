import { act, renderHook, waitFor } from '@testing-library/react-native';

import { resetActiveSessionForTests } from '../../core/session.js';
import type { Tag } from '../../core/tag.js';
import { FakeNativeModule, fakeTagInfo } from '../../native/__tests__/fakeNative.js';
import { setNativeModuleForTests } from '../../native/module.js';
import { useNfcTagStream, type UseNfcTagStreamOptions } from '../useNfcTagStream.js';

let native: FakeNativeModule;

beforeEach(() => {
  native = new FakeNativeModule();
  setNativeModuleForTests(native);
});

afterEach(() => {
  setNativeModuleForTests(undefined);
  resetActiveSessionForTests();
});

function startedSessionId(): string {
  const call = native.lastCallTo('startSession');
  if (call === undefined) {
    throw new Error('startSession was never called');
  }
  return call.args[0] as string;
}

async function deliverTag(sessionCount = 1): Promise<void> {
  await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(sessionCount));
  await act(() => {
    native.emitTagDiscovered(startedSessionId(), fakeTagInfo());
  });
}

describe('useNfcTagStream', () => {
  it('starts a session on mount and reports itself active', async () => {
    const { result } = await renderHook(() => useNfcTagStream({ tech: ['isoDep'] }, () => {}));

    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));
    expect(result.current.active).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('passes the reader options through to native', async () => {
    await renderHook(() =>
      useNfcTagStream(
        { tech: ['isoDep'], android: { presenceCheckDelayMs: 500, skipNdefCheck: true } },
        () => {},
      ),
    );

    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));
    expect(native.lastCallTo('startSession')?.args[1]).toMatchObject({
      techs: ['isoDep'],
      androidPresenceCheckDelayMs: 500,
      androidSkipNdefCheck: true,
    });
  });

  it('delivers tags to the listener', async () => {
    const seen: (Uint8Array | null)[] = [];
    await renderHook(() =>
      useNfcTagStream({ tech: ['ndef'] }, (tag: Tag) => {
        seen.push(tag.id);
      }),
    );

    await deliverTag();

    await waitFor(() => expect(seen).toHaveLength(1));
  });

  it('stops the session on unmount', async () => {
    // A stream left running holds Android's NFC controller, so the next screen
    // that wants a tag cannot have one -- and nothing on that screen says why.
    const { unmount } = await renderHook(() => useNfcTagStream({ tech: ['ndef'] }, () => {}));
    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));

    await unmount();

    await waitFor(() => expect(native.callsTo('closeSession')).toHaveLength(1));
  });

  it('does not start while disabled, and starts when enabled', async () => {
    const { result, rerender } = await renderHook(
      ({ enabled }: { enabled: boolean }) => useNfcTagStream({ tech: ['ndef'], enabled }, () => {}),
      { initialProps: { enabled: false } },
    );

    expect(result.current.active).toBe(false);
    expect(native.callsTo('startSession')).toHaveLength(0);

    await rerender({ enabled: true });

    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));
    expect(result.current.active).toBe(true);
  });

  it('stops when disabled again', async () => {
    const { result, rerender } = await renderHook(
      ({ enabled }: { enabled: boolean }) => useNfcTagStream({ tech: ['ndef'], enabled }, () => {}),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));

    await rerender({ enabled: false });

    await waitFor(() => expect(native.callsTo('closeSession')).toHaveLength(1));
    expect(result.current.active).toBe(false);
  });

  it('does not restart when the options object is recreated with the same values', async () => {
    // An inline object literal is a new object every render. Depending on its
    // identity would restart reader mode on every render, which presents as "NFC
    // randomly stops working" long before it presents as a dependency bug.
    const { rerender } = await renderHook(
      ({ label }: { label: string }) =>
        useNfcTagStream({ tech: ['ndef'] }, () => {
          void label;
        }),
      { initialProps: { label: 'a' } },
    );
    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));

    await rerender({ label: 'b' });
    await rerender({ label: 'c' });

    expect(native.callsTo('startSession')).toHaveLength(1);
  });

  it('restarts when the options actually change', async () => {
    const { rerender } = await renderHook(
      ({ tech }: { tech: UseNfcTagStreamOptions['tech'] }) => useNfcTagStream({ tech }, () => {}),
      { initialProps: { tech: ['ndef'] as UseNfcTagStreamOptions['tech'] } },
    );
    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));

    await rerender({ tech: ['isoDep'] });

    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(2));
    expect(native.lastCallTo('startSession')?.args[1]).toMatchObject({ techs: ['isoDep'] });
  });

  it('always calls the listener from the latest render', async () => {
    const seen: string[] = [];
    const { rerender } = await renderHook(
      ({ label }: { label: string }) =>
        useNfcTagStream({ tech: ['ndef'] }, () => {
          seen.push(label);
        }),
      { initialProps: { label: 'first' } },
    );
    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));

    await rerender({ label: 'second' });
    await deliverTag();

    // A stale closure here would silently act on last render's state, which is
    // the single most common bug in hand-written versions of this.
    await waitFor(() => expect(seen).toEqual(['second']));
  });

  it('surfaces a stream failure and stops reporting itself active', async () => {
    const { result } = await renderHook(() => useNfcTagStream({ tech: ['ndef'] }, () => {}));
    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));

    await act(() => {
      native.emitSessionInvalidated(startedSessionId(), {
        code: 'sessionTimeout',
        message: 'The session reached the 60 second limit.',
        nativeCode: 'NFCReaderError:201',
        recoverable: null,
      });
    });

    // This is the ordinary end of a stream on iOS, not an exceptional case.
    await waitFor(() => expect(result.current.error?.code).toBe('sessionTimeout'));
    expect(result.current.active).toBe(false);
  });

  it('clears a previous error when it restarts', async () => {
    const { result, rerender } = await renderHook(
      ({ tech }: { tech: UseNfcTagStreamOptions['tech'] }) => useNfcTagStream({ tech }, () => {}),
      { initialProps: { tech: ['ndef'] as UseNfcTagStreamOptions['tech'] } },
    );
    await waitFor(() => expect(native.callsTo('startSession')).toHaveLength(1));

    await act(() => {
      native.emitSessionInvalidated(startedSessionId(), {
        code: 'sessionTimeout',
        message: 'The session reached the 60 second limit.',
        nativeCode: null,
        recoverable: null,
      });
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());

    await rerender({ tech: ['isoDep'] });

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.active).toBe(true);
  });
});
