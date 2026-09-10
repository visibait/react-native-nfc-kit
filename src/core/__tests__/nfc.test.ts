import type { NfcError } from '../../errors.js';
import { FakeNativeModule, fakeTagInfo } from '../../native/__tests__/fakeNative.js';
import { setNativeModuleForTests } from '../../native/module.js';
import { nfc } from '../nfc.js';
import { resetActiveSessionForTests } from '../session.js';
import type { Tag } from '../tag.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function startedSessionId(native: FakeNativeModule): string {
  const call = native.lastCallTo('startSession');
  if (call === undefined) {
    throw new Error('startSession was never called');
  }
  return call.args[0] as string;
}

let native: FakeNativeModule;

beforeEach(() => {
  native = new FakeNativeModule();
  setNativeModuleForTests(native);
});

afterEach(() => {
  setNativeModuleForTests(undefined);
  resetActiveSessionForTests();
});

describe('availability', () => {
  it('reports what native says', async () => {
    native.supported = true;
    native.enabled = false;

    await expect(nfc.isSupported()).resolves.toBe(true);
    await expect(nfc.isEnabled()).resolves.toBe(false);
  });

  it('answers false rather than throwing when the native module is missing', async () => {
    // So a screen can hide its NFC affordance without a try/catch. Every other
    // call throws contractMismatch with instructions instead.
    setNativeModuleForTests(null);

    await expect(nfc.isSupported()).resolves.toBe(false);
    await expect(nfc.isEnabled()).resolves.toBe(false);
  });

  it('reports support, enablement and capabilities together', async () => {
    native.supported = true;
    native.enabled = true;

    const availability = await nfc.getAvailability();

    expect(availability.supported).toBe(true);
    expect(availability.enabled).toBe(true);
    expect(availability.capabilities?.platform).toBe('android');
    expect(availability.capabilities?.osVersion).toBe('15');
  });

  it('reports everything unavailable when the module is missing', async () => {
    setNativeModuleForTests(null);

    await expect(nfc.getAvailability()).resolves.toEqual({
      supported: false,
      enabled: false,
      capabilities: null,
    });
  });

  it('propagates a native failure rather than reporting a false negative', async () => {
    native.rejectWith('isSupported', { code: 'internalError', message: 'adapter died' });

    await expect(nfc.isSupported()).rejects.toMatchObject({ code: 'internalError' });
  });
});

describe('capabilities', () => {
  it('exposes what this device can do, without a round trip', () => {
    expect(nfc.capabilities).toMatchObject({
      platform: 'android',
      tagLost: 'polled',
      perSessionConfig: false,
      hce: false,
      backgroundReading: true,
    });
  });

  it('drops technology names this build has no capability for', () => {
    // A native binary newer than the bundle may report something new; surfacing a
    // name no guard can match would be worse than omitting it.
    setNativeModuleForTests(
      new FakeNativeModule({ capabilities: { techs: ['ndef', 'somethingNewer', 'isoDep'] } }),
    );

    expect(nfc.capabilities?.techs).toEqual(['ndef', 'isoDep']);
  });

  it('is null when NFC is unavailable', () => {
    setNativeModuleForTests(null);
    expect(nfc.capabilities).toBeNull();
  });

  describe('supports', () => {
    it('is true for a reachable technology and false otherwise', () => {
      setNativeModuleForTests(
        new FakeNativeModule({ capabilities: { techs: ['ndef', 'isoDep'] } }),
      );

      expect(nfc.supports('ndef')).toBe(true);
      expect(nfc.supports('mifareClassic')).toBe(false);
    });

    it('keeps working when destructured off the facade', () => {
      // Reading module state rather than `this` is what makes this safe, and
      // destructuring a facade is a normal thing to do.
      const { supports } = nfc;
      expect(supports('ndef')).toBe(true);
    });

    it('is false when NFC is unavailable', () => {
      setNativeModuleForTests(null);
      expect(nfc.supports('ndef')).toBe(false);
    });
  });
});

describe('openSettings', () => {
  it('asks native to open the system NFC screen', async () => {
    await nfc.openSettings();
    expect(native.callsTo('openSettings')).toHaveLength(1);
  });

  it('throws with rebuild instructions when the native module is missing', async () => {
    setNativeModuleForTests(null);

    await nfc.openSettings().catch((error: NfcError) => {
      expect(error.code).toBe('contractMismatch');
      expect(error.message).toContain('Expo Go');
    });
  });
});

describe('onAvailabilityChange', () => {
  it('attaches to native only while somebody is listening', () => {
    expect(native.listenerCount('onAvailabilityChanged')).toBe(0);

    const subscription = nfc.onAvailabilityChange(jest.fn());
    expect(native.listenerCount('onAvailabilityChanged')).toBe(1);

    subscription.remove();
    expect(native.listenerCount('onAvailabilityChanged')).toBe(0);
  });

  it('attaches once for several listeners', () => {
    const first = nfc.onAvailabilityChange(jest.fn());
    const second = nfc.onAvailabilityChange(jest.fn());

    expect(native.listenerCount('onAvailabilityChanged')).toBe(1);

    first.remove();
    expect(native.listenerCount('onAvailabilityChanged')).toBe(1);

    second.remove();
    expect(native.listenerCount('onAvailabilityChanged')).toBe(0);
  });

  it('reports the new state with capabilities attached', () => {
    const listener = jest.fn();
    const subscription = nfc.onAvailabilityChange(listener);

    native.emitAvailabilityChanged(true, false);

    expect(listener).toHaveBeenCalledWith({
      supported: true,
      enabled: false,
      capabilities: expect.objectContaining({ platform: 'android' }),
    });

    subscription.remove();
  });

  it('does not throw when NFC is unavailable', () => {
    setNativeModuleForTests(null);

    const subscription = nfc.onAvailabilityChange(jest.fn());
    expect(() => subscription.remove()).not.toThrow();
  });
});

describe('withTag', () => {
  it('runs the callback with a tag and closes the session', async () => {
    const pending = nfc.withTag({ tech: ['ndef'] }, (tag) => tag.idHex);
    await flush();
    native.emitTagDiscovered(startedSessionId(native));

    await expect(pending).resolves.toBe('04a2b3c4d5e6f0');
    expect(native.callsTo('closeSession')).toHaveLength(1);
  });
});

describe('openSession', () => {
  it('hands back a session the caller manages', async () => {
    const session = await nfc.openSession({ tech: ['ndef'] });

    expect(session.closed).toBe(false);
    await session.close();
    expect(session.closed).toBe(true);
  });
});

describe('onTag', () => {
  it('delivers every tag until the subscription is removed', async () => {
    const seen: (string | null)[] = [];
    const subscription = nfc.onTag({ tech: ['ndef'] }, (tag) => {
      seen.push(tag.idHex);
    });

    await flush();
    const sessionId = startedSessionId(native);

    native.emitTagDiscovered(sessionId, fakeTagInfo({ handleId: 'h1', idHex: 'aa' }));
    await flush();
    native.emitTagDiscovered(sessionId, fakeTagInfo({ handleId: 'h2', idHex: 'bb' }));
    await flush();

    expect(seen).toEqual(['aa', 'bb']);

    subscription.remove();
    await flush();
    expect(native.callsTo('closeSession')).toHaveLength(1);
  });

  it('waits for a slow listener before taking the next tag', async () => {
    // Overlapping work on one reader is never what the caller meant, and on
    // Android it would interleave exchanges on the same hardware.
    const order: string[] = [];
    let release: (() => void) | undefined;

    const subscription = nfc.onTag({ tech: ['ndef'] }, async (tag) => {
      order.push(`start ${tag.idHex}`);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push(`end ${tag.idHex}`);
    });

    await flush();
    const sessionId = startedSessionId(native);

    native.emitTagDiscovered(sessionId, fakeTagInfo({ handleId: 'h1', idHex: 'aa' }));
    await flush();
    native.emitTagDiscovered(sessionId, fakeTagInfo({ handleId: 'h2', idHex: 'bb' }));
    await flush();

    // The second tag is queued, not delivered, while the first is still running.
    expect(order).toEqual(['start aa']);

    release?.();
    await flush();
    expect(order).toEqual(['start aa', 'end aa', 'start bb']);

    release?.();
    subscription.remove();
    await flush();
  });

  it('reports a stream failure through onError', async () => {
    const onError = jest.fn();
    native.rejectWith('startSession', { code: 'nfcDisabled', message: 'NFC is off' });

    nfc.onTag({ tech: ['ndef'], onError }, jest.fn());
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as NfcError).code).toBe('nfcDisabled');
  });

  it('reports the platform ending the session', async () => {
    const onError = jest.fn();
    nfc.onTag({ tech: ['ndef'], onError }, jest.fn());
    await flush();

    native.emitSessionInvalidated(startedSessionId(native), {
      code: 'sessionTimeout',
      message: 'The 60 second limit elapsed',
      nativeCode: null,
      recoverable: null,
    });
    await flush();

    expect((onError.mock.calls[0]![0] as NfcError).code).toBe('sessionTimeout');
  });

  it('logs when a failure has nowhere to go', async () => {
    // onTag returns a subscription rather than a promise, so without onError a
    // rejection would be entirely silent.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    native.rejectWith('startSession', { code: 'nfcDisabled', message: 'NFC is off' });

    nfc.onTag({ tech: ['ndef'] }, jest.fn());
    await flush();

    expect(consoleError).toHaveBeenCalledWith(
      '[react-native-nfc-kit] Tag stream failed with no onError handler:',
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it('stays quiet when the session ends because the caller unsubscribed', async () => {
    const onError = jest.fn();
    const subscription = nfc.onTag({ tech: ['ndef'], onError }, jest.fn());
    await flush();

    subscription.remove();
    await flush();

    // Unsubscribing is the expected way out, not a failure.
    expect(onError).not.toHaveBeenCalled();
  });

  it('treats removing twice as a no-op', async () => {
    const subscription = nfc.onTag({ tech: ['ndef'] }, jest.fn());
    await flush();

    subscription.remove();
    subscription.remove();
    await flush();

    expect(native.callsTo('closeSession')).toHaveLength(1);
  });

  it('closes the session even when unsubscribed before it finished opening', async () => {
    const subscription = nfc.onTag({ tech: ['ndef'] }, jest.fn());
    subscription.remove();
    await flush();

    expect(native.callsTo('closeSession')).toHaveLength(1);
    expect(native.listenerCount('onTagDiscovered')).toBe(0);
  });

  it('does not deliver a tag that arrives after unsubscribing', async () => {
    const listener = jest.fn<void, [Tag]>();
    const subscription = nfc.onTag({ tech: ['ndef'] }, listener);
    await flush();
    const sessionId = startedSessionId(native);

    subscription.remove();
    native.emitTagDiscovered(sessionId);
    await flush();

    expect(listener).not.toHaveBeenCalled();
  });

  it('releases the radio so a later scan can start', async () => {
    const subscription = nfc.onTag({ tech: ['ndef'] }, jest.fn());
    await flush();
    subscription.remove();
    await flush();

    const session = await nfc.openSession({ tech: ['ndef'] });
    await session.close();
  });
});

describe('background tags', () => {
  it('answers null when no tag launched the app', async () => {
    await expect(nfc.withLaunchTag(() => 'ran')).resolves.toBeNull();
  });

  it('hands the launch tag to the callback and releases it', async () => {
    native.setLaunchTag(fakeTagInfo({ handleId: 'bg-1' }));

    await expect(nfc.withLaunchTag((tag) => tag.idHex)).resolves.toBe('04a2b3c4d5e6f0');
    expect(native.lastCallTo('releaseTag')?.args[0]).toBe('bg-1');
  });

  it('delivers tags dispatched while the app runs', async () => {
    const listener = jest.fn();
    const subscription = nfc.onBackgroundTag(listener);

    native.emitBackgroundTag();
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);

    subscription.remove();
    native.emitBackgroundTag();
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
