import { NfcError } from '../../errors.js';
import { NATIVE_EVENT_NAMES } from '../../native/contract.js';
import { FakeNativeModule, fakeTagInfo } from '../../native/__tests__/fakeNative.js';
import { setNativeModuleForTests } from '../../native/module.js';
import { onBackgroundTag, withLaunchTag } from '../background.js';
import { nfc } from '../nfc.js';
import { getActiveSessionIdForTests, resetActiveSessionForTests } from '../session.js';

/**
 * The failure users report as "it works the first five times".
 *
 * A session or a listener that is not released leaves nothing visibly wrong: the
 * next scan works, and the one after that, until the platform refuses because the
 * controller is still held or a handle map has grown without bound. Nothing in a
 * single-pass test notices, because a single pass is exactly the case that works.
 *
 * So this runs each entry point many times and then asserts that the library is
 * back where it started: no active session, no native listeners, every tag handle
 * released. It is the automatable half of the soak procedure in the device matrix —
 * it proves the bookkeeping is sound, and a device proves the radio is.
 */

const ITERATIONS = 30;

let native: FakeNativeModule;

beforeEach(() => {
  native = new FakeNativeModule();
  setNativeModuleForTests(native);
});

afterEach(() => {
  setNativeModuleForTests(undefined);
  resetActiveSessionForTests();
});

/**
 * Lets every queued handler run to completion.
 *
 * A microtask flush is not enough here: the background and emulation queues chain
 * one promise per delivery, so thirty deliveries need thirty rounds. Yielding to the
 * macrotask queue drains all of them, and doing it a few times covers work that
 * schedules more work.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Total listeners the library currently holds on the native module. */
function nativeListeners(): number {
  return NATIVE_EVENT_NAMES.reduce((total, event) => total + native.listenerCount(event), 0);
}

/** Waits for the session to exist, then hands it a tag. */
async function deliverTag(iteration: number): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
  const call = native.callsTo('startSession').at(-1);
  if (call === undefined) {
    throw new Error(`No session started on iteration ${iteration}`);
  }
  native.emitTagDiscovered(call.args[0] as string, fakeTagInfo({ handleId: `h${iteration}` }));
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}

describe(`${ITERATIONS} iterations of`, () => {
  it('withTag leaves no session, no listener and no handle behind', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const pending = nfc.withTag({ tech: ['ndef'] }, (tag) => tag.idHex);
      await deliverTag(i);
      await pending;
    }

    expect(native.callsTo('startSession')).toHaveLength(ITERATIONS);
    expect(native.callsTo('closeSession')).toHaveLength(ITERATIONS);
    expect(getActiveSessionIdForTests()).toBeNull();
    expect(nativeListeners()).toBe(0);
  });

  it('withTag cleans up just as well when the work throws every time', async () => {
    // The path that leaks in practice: a `finally` that is skipped, or a listener
    // attached before the throw and removed after it.
    for (let i = 0; i < ITERATIONS; i += 1) {
      const pending = nfc.withTag({ tech: ['ndef'] }, () => {
        throw new NfcError({ code: 'ndefMalformed', message: 'bad', platform: 'android' });
      });
      await deliverTag(i);
      await expect(pending).rejects.toMatchObject({ code: 'ndefMalformed' });
    }

    expect(native.callsTo('closeSession')).toHaveLength(ITERATIONS);
    expect(getActiveSessionIdForTests()).toBeNull();
    expect(nativeListeners()).toBe(0);
  });

  it('openSession releases everything on close', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const session = await nfc.openSession({ tech: ['ndef'] });
      await session.close();
    }

    expect(native.callsTo('closeSession')).toHaveLength(ITERATIONS);
    expect(getActiveSessionIdForTests()).toBeNull();
    expect(nativeListeners()).toBe(0);
  });

  it('onTag unsubscribes cleanly every time', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const subscription = nfc.onTag({ tech: ['ndef'] }, () => {});
      await deliverTag(i);
      subscription.remove();
      for (let flush = 0; flush < 8; flush += 1) {
        await Promise.resolve();
      }
    }

    expect(getActiveSessionIdForTests()).toBeNull();
    expect(nativeListeners()).toBe(0);
  });

  it('onAvailabilityChange detaches from native when the last listener goes', async () => {
    // The one that grew unbounded in the library being replaced: a receiver
    // registered per call and never unregistered, one leak per screen.
    for (let i = 0; i < ITERATIONS; i += 1) {
      const first = nfc.onAvailabilityChange(() => {});
      const second = nfc.onAvailabilityChange(() => {});
      native.emitAvailabilityChanged(true, true);
      first.remove();
      second.remove();
    }

    expect(native.listenerCount('onAvailabilityChanged')).toBe(0);
  });

  it('withLaunchTag releases each tag it hands out', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      native.setLaunchTag(fakeTagInfo({ handleId: `bg${i}` }));
      await withLaunchTag({ native, platform: 'android' }, (tag) => tag.idHex);
    }

    expect(native.callsTo('releaseTag')).toHaveLength(ITERATIONS);
  });

  it('onBackgroundTag releases every delivered tag and unsubscribes', async () => {
    const subscription = onBackgroundTag({ native, platform: 'android' }, () => {});

    for (let i = 0; i < ITERATIONS; i += 1) {
      native.emitBackgroundTag(fakeTagInfo({ handleId: `bg${i}` }));
    }
    await settle();
    subscription.remove();

    expect(native.callsTo('releaseTag')).toHaveLength(ITERATIONS);
    expect(native.listenerCount('onBackgroundTag')).toBe(0);
  });

  it('a mixture of all of them ends with nothing held', async () => {
    // Interleaved rather than in blocks, because a leak that only shows when one
    // entry point follows another is exactly the kind a per-entry-point test misses.
    for (let i = 0; i < ITERATIONS; i += 1) {
      const availability = nfc.onAvailabilityChange(() => {});

      const pending = nfc.withTag({ tech: ['ndef'] }, (tag) => tag.idHex);
      await deliverTag(i);
      await pending;

      const session = await nfc.openSession({ tech: ['ndef'] });
      await session.close();

      const stream = nfc.onTag({ tech: ['ndef'] }, () => {});
      stream.remove();
      availability.remove();

      for (let flush = 0; flush < 8; flush += 1) {
        await Promise.resolve();
      }
    }

    expect(getActiveSessionIdForTests()).toBeNull();
    expect(nativeListeners()).toBe(0);
  });
});
