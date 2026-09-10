import { act, renderHook, waitFor } from '@testing-library/react-native';

import { resetActiveSessionForTests } from '../../core/session.js';
import { FakeNativeModule } from '../../native/__tests__/fakeNative.js';
import { setNativeModuleForTests } from '../../native/module.js';
import { useNfcAvailability } from '../useNfcAvailability.js';

let native: FakeNativeModule;

beforeEach(() => {
  native = new FakeNativeModule();
  setNativeModuleForTests(native);
});

afterEach(() => {
  setNativeModuleForTests(undefined);
  resetActiveSessionForTests();
});

describe('useNfcAvailability', () => {
  it('is loading, not unsupported, while the answer is still pending', async () => {
    // Rendering "this device has no NFC" on a device that has it, for however
    // many frames the round trip takes, is the whole reason `loading` exists.
    native.hangOn('isSupported');

    const { result } = await renderHook(() => useNfcAvailability());

    expect(result.current.loading).toBe(true);
    expect(result.current.ready).toBe(false);
  });

  it('reports what native says', async () => {
    native.supported = true;
    native.enabled = true;

    const { result } = await renderHook(() => useNfcAvailability());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.supported).toBe(true);
    expect(result.current.enabled).toBe(true);
    expect(result.current.ready).toBe(true);
    expect(result.current.capabilities?.platform).toBe('android');
  });

  it('is not ready when the hardware is there but NFC is switched off', async () => {
    native.enabled = false;

    const { result } = await renderHook(() => useNfcAvailability());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.supported).toBe(true);
    expect(result.current.ready).toBe(false);
  });

  it('follows the user switching NFC off while the screen is open', async () => {
    const { result } = await renderHook(() => useNfcAvailability());
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(() => {
      native.emitAvailabilityChanged(true, false);
    });

    expect(result.current.enabled).toBe(false);
    expect(result.current.ready).toBe(false);

    await act(() => {
      native.emitAvailabilityChanged(true, true);
    });

    expect(result.current.ready).toBe(true);
  });

  it('detaches from native on unmount', async () => {
    const { result, unmount } = await renderHook(() => useNfcAvailability());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(native.listenerCount('onAvailabilityChanged')).toBe(1);

    await unmount();

    expect(native.listenerCount('onAvailabilityChanged')).toBe(0);
  });

  it('ignores an availability change that lands after unmount', async () => {
    const { result, unmount } = await renderHook(() => useNfcAvailability());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await unmount();

    // Nothing is listening any more, so this reaches nobody -- which is the
    // point: a change arriving after unmount must not set state.
    expect(() => native.emitAvailabilityChanged(false, false)).not.toThrow();
    expect(native.listenerCount('onAvailabilityChanged')).toBe(0);
  });

  it('re-reads on refresh', async () => {
    native.supported = false;
    const { result } = await renderHook(() => useNfcAvailability());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.supported).toBe(false);

    native.supported = true;
    await act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.supported).toBe(true));
  });

  it('keeps exactly one native listener across a refresh', async () => {
    const { result } = await renderHook(() => useNfcAvailability());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => {
      result.current.refresh();
    });
    await act(() => {
      result.current.refresh();
    });

    expect(native.listenerCount('onAvailabilityChanged')).toBe(1);
  });

  it('does not set state when the answer arrives after unmount', async () => {
    // Navigating away mid-call is ordinary. React logs an act() warning for a
    // state update outside a render pass, so an unguarded one is visible here.
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    native.hangOn('isSupported');

    try {
      const { unmount } = await renderHook(() => useNfcAvailability());
      await unmount();

      await act(() => {
        native.settlePending('isSupported');
      });

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reports unavailable rather than throwing when there is no native module', async () => {
    // `null` is "the module is not installed", which is what a bare JS bundle
    // running against a client built before this library was added looks like.
    setNativeModuleForTests(null);

    const { result } = await renderHook(() => useNfcAvailability());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.supported).toBe(false);
    expect(result.current.capabilities).toBeNull();
  });
});
