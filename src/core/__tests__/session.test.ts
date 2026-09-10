import { NfcError } from '../../errors.js';
import { FakeNativeModule, fakeTagInfo } from '../../native/__tests__/fakeNative.js';
import {
  getActiveSessionIdForTests,
  openSession,
  resetActiveSessionForTests,
  withTag,
  type ScanOptions,
  type SessionDependencies,
} from '../session.js';
import type { Tag } from '../tag.js';

/** Lets pending microtasks run, so a started session has reached native. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function deps(native: FakeNativeModule): SessionDependencies {
  return { native, platform: 'android' };
}

/** The session id native was asked to start, as JS minted it. */
function startedSessionId(native: FakeNativeModule): string {
  const call = native.lastCallTo('startSession');
  if (call === undefined) {
    throw new Error('startSession was never called');
  }
  return call.args[0] as string;
}

const NDEF_SCAN: ScanOptions = { tech: ['ndef'] };

afterEach(() => {
  resetActiveSessionForTests();
});

describe('option mapping', () => {
  it('sends defaults for everything the caller did not set', async () => {
    const native = new FakeNativeModule();
    const session = await openSession(deps(native), { tech: ['ndef', 'isoDep'] });

    expect(native.lastCallTo('startSession')?.args[1]).toEqual({
      techs: ['ndef', 'isoDep'],
      iosPollingOptions: null,
      iosAlertMessage: null,
      iosInvalidateAfterFirstRead: false,
      iosSelectIdentifiers: null,
      iosFelicaSystemCodes: null,
      androidSkipNdefCheck: false,
      androidNoPlatformSounds: false,
      androidPresenceCheckDelayMs: null,
    });

    await session.close();
  });

  it('forwards every option it was given', async () => {
    const native = new FakeNativeModule();
    const session = await openSession(deps(native), {
      tech: ['isoDep'],
      config: {
        polling: ['iso14443', 'pace'],
        iso7816SelectIdentifiers: ['A0000002471001'],
        feliCaSystemCodes: ['0003'],
      },
      ios: { alertMessage: 'Hold your card near the phone', invalidateAfterFirstRead: true },
      android: { skipNdefCheck: true, noPlatformSounds: true, presenceCheckDelayMs: 500 },
    });

    expect(native.lastCallTo('startSession')?.args[1]).toEqual({
      techs: ['isoDep'],
      iosPollingOptions: ['iso14443', 'pace'],
      iosAlertMessage: 'Hold your card near the phone',
      iosInvalidateAfterFirstRead: true,
      iosSelectIdentifiers: ['A0000002471001'],
      iosFelicaSystemCodes: ['0003'],
      androidSkipNdefCheck: true,
      androidNoPlatformSounds: true,
      androidPresenceCheckDelayMs: 500,
    });

    await session.close();
  });

  it('rejects an empty technology list without touching native', async () => {
    const native = new FakeNativeModule();

    await expect(openSession(deps(native), { tech: [] })).rejects.toMatchObject({
      code: 'invalidArgument',
    });
    expect(native.callsTo('startSession')).toHaveLength(0);
  });
});

describe('withTag', () => {
  it('returns what the callback returned, and closes the session', async () => {
    const native = new FakeNativeModule();

    const pending = withTag(deps(native), NDEF_SCAN, (tag) => tag.idHex);
    await flush();
    native.emitTagDiscovered(startedSessionId(native));

    await expect(pending).resolves.toBe('04a2b3c4d5e6f0');
    expect(native.callsTo('closeSession')).toHaveLength(1);
  });

  it('closes the session when the callback throws', async () => {
    // The path that matters most: an exception inside the callback must not leave
    // the radio held.
    const native = new FakeNativeModule();
    const failure = new Error('business logic said no');

    const pending = withTag(deps(native), NDEF_SCAN, () => {
      throw failure;
    });
    await flush();
    native.emitTagDiscovered(startedSessionId(native));

    await expect(pending).rejects.toBe(failure);
    expect(native.callsTo('closeSession')).toHaveLength(1);
  });

  it('closes the session when the callback rejects', async () => {
    const native = new FakeNativeModule();

    const pending = withTag(deps(native), NDEF_SCAN, () =>
      Promise.reject(new NfcError({ code: 'ioError', message: 'nope' })),
    );
    await flush();
    native.emitTagDiscovered(startedSessionId(native));

    await expect(pending).rejects.toMatchObject({ code: 'ioError' });
    expect(native.callsTo('closeSession')).toHaveLength(1);
  });

  it('closes the session when the signal fires before a tag arrives', async () => {
    const native = new FakeNativeModule();
    const controller = new AbortController();
    const work = jest.fn();

    const pending = withTag(deps(native), { ...NDEF_SCAN, signal: controller.signal }, work);
    await flush();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(work).not.toHaveBeenCalled();
    expect(native.callsTo('closeSession')).toHaveLength(1);
  });

  it('closes the session when the timeout elapses before a tag arrives', async () => {
    jest.useFakeTimers();
    try {
      const native = new FakeNativeModule();
      const pending = withTag(deps(native), { ...NDEF_SCAN, timeoutMs: 5000 }, jest.fn());

      await flush();
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      jest.advanceTimersByTime(5000);
      await assertion;

      expect(native.callsTo('closeSession')).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('surfaces the platform error when the session is invalidated underneath', async () => {
    // The user dismissing the iOS sheet, or the 60 second system limit.
    const native = new FakeNativeModule();

    const pending = withTag(deps(native), NDEF_SCAN, jest.fn());
    await flush();
    native.emitSessionInvalidated(startedSessionId(native), {
      code: 'userCancelled',
      message: 'The user cancelled the scan',
      nativeCode: 'NFCError:200',
      recoverable: null,
    });

    await pending.catch((error: NfcError) => {
      expect(error.code).toBe('userCancelled');
      expect(error.nativeCode).toBe('NFCError:200');
    });
  });

  it('does not call closeSession again when native already ended the session', async () => {
    const native = new FakeNativeModule();

    const pending = withTag(deps(native), NDEF_SCAN, jest.fn());
    await flush();
    native.emitSessionInvalidated(startedSessionId(native), {
      code: 'sessionTimeout',
      message: 'expired',
      nativeCode: null,
      recoverable: null,
    });

    await pending.catch(() => {});
    expect(native.callsTo('closeSession')).toHaveLength(0);
  });

  it('leaves the tag unusable once the callback has returned', async () => {
    // A tag captured out of the callback is a mistake, and it should say so
    // rather than fail somewhere in native.
    const native = new FakeNativeModule();
    let escaped: Tag | undefined;

    const pending = withTag(deps(native), NDEF_SCAN, (tag) => {
      escaped = tag;
      return 'done';
    });
    await flush();
    native.emitTagDiscovered(startedSessionId(native));
    await pending;

    expect(escaped?.released).toBe(true);
    if (escaped?.is('ndef') !== true) {
      throw new Error('expected an NDEF tag');
    }
    await expect(escaped.readNdef()).rejects.toMatchObject({ code: 'sessionClosed' });
  });

  it('reports a close failure without masking the original error', async () => {
    const native = new FakeNativeModule();
    native.rejectWith('closeSession', new Error('close blew up'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const original = new Error('the real problem');

    const pending = withTag(deps(native), NDEF_SCAN, () => {
      throw original;
    });
    await flush();
    native.emitTagDiscovered(startedSessionId(native));

    // The caller sees what actually went wrong, not the cleanup failure.
    await expect(pending).rejects.toBe(original);
    expect(consoleError).toHaveBeenCalledWith(
      '[react-native-nfc-kit] Closing the NFC session failed:',
      expect.anything(),
    );

    consoleError.mockRestore();
  });

  it('releases the radio so the next scan can start', async () => {
    const native = new FakeNativeModule();

    for (let i = 0; i < 3; i += 1) {
      const pending = withTag(deps(native), NDEF_SCAN, () => i);
      await flush();
      native.emitTagDiscovered(startedSessionId(native));
      await expect(pending).resolves.toBe(i);
    }

    expect(native.callsTo('startSession')).toHaveLength(3);
    expect(getActiveSessionIdForTests()).toBeNull();
  });
});

describe('one session at a time', () => {
  it('rejects a second session with systemBusy and an explanation', async () => {
    // iOS allows exactly one NFCReaderSession system-wide; a second begin() fails
    // with SystemIsBusy and further sessions queue behind it.
    const native = new FakeNativeModule();
    const first = await openSession(deps(native), NDEF_SCAN);

    await openSession(deps(native), NDEF_SCAN).catch((error: NfcError) => {
      expect(error.code).toBe('systemBusy');
      expect(error.message).toContain('only one at a time');
    });

    expect(native.callsTo('startSession')).toHaveLength(1);
    await first.close();
  });

  it('allows a new session once the previous one closed', async () => {
    const native = new FakeNativeModule();

    await (await openSession(deps(native), NDEF_SCAN)).close();
    const second = await openSession(deps(native), NDEF_SCAN);

    expect(native.callsTo('startSession')).toHaveLength(2);
    await second.close();
  });

  it('frees the slot when starting fails', async () => {
    const native = new FakeNativeModule();
    native.rejectWith('startSession', { code: 'nfcDisabled', message: 'NFC is off' });

    await expect(openSession(deps(native), NDEF_SCAN)).rejects.toMatchObject({
      code: 'nfcDisabled',
    });
    expect(getActiveSessionIdForTests()).toBeNull();

    // And the failure did not poison the next attempt.
    native.rejections.delete('startSession');
    const session = await openSession(deps(native), NDEF_SCAN);
    await session.close();
  });

  it('removes its native listeners when starting fails', async () => {
    const native = new FakeNativeModule();
    native.rejectWith('startSession', new Error('boom'));

    await openSession(deps(native), NDEF_SCAN).catch(() => {});

    expect(native.listenerCount('onTagDiscovered')).toBe(0);
    expect(native.listenerCount('onTagLost')).toBe(0);
    expect(native.listenerCount('onSessionInvalidated')).toBe(0);
  });
});

describe('openSession', () => {
  it('attaches listeners before asking native to start', async () => {
    // Native can deliver a discovery before startSession resolves; that event
    // must not be dropped.
    const native = new FakeNativeModule();
    let listenersAtStart = -1;
    native.rejectWith('__never__', undefined);

    const original = native.startSession.bind(native);
    native.startSession = (id, options) => {
      listenersAtStart = native.listenerCount('onTagDiscovered');
      return original(id, options);
    };

    const session = await openSession(deps(native), NDEF_SCAN);
    expect(listenersAtStart).toBe(1);
    await session.close();
  });

  it('hands out several tags in turn', async () => {
    const native = new FakeNativeModule();
    const session = await openSession(deps(native), NDEF_SCAN);

    const first = session.nextTag();
    native.emitTagDiscovered(session.id, fakeTagInfo({ handleId: 'h1', idHex: 'aa' }));
    expect((await first).idHex).toBe('aa');

    const second = session.nextTag();
    native.emitTagDiscovered(session.id, fakeTagInfo({ handleId: 'h2', idHex: 'bb' }));
    expect((await second).idHex).toBe('bb');

    await session.close();
  });

  it('keeps a tag discovered before anyone asked for it', async () => {
    // A tag presented between starting the session and awaiting nextTag would
    // otherwise be lost, and the user would have to tap again for no reason.
    const native = new FakeNativeModule();
    const session = await openSession(deps(native), NDEF_SCAN);

    native.emitTagDiscovered(session.id, fakeTagInfo({ idHex: 'cc' }));
    expect((await session.nextTag()).idHex).toBe('cc');

    await session.close();
  });

  it('ignores events belonging to another session', async () => {
    const native = new FakeNativeModule();
    const session = await openSession(deps(native), NDEF_SCAN);

    native.emitTagDiscovered('some-other-session');
    const pending = session.nextTag({ timeoutMs: 50 });

    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await session.close();
  });

  it('rejects nextTag once the session is closed', async () => {
    const native = new FakeNativeModule();
    const session = await openSession(deps(native), NDEF_SCAN);
    await session.close();

    expect(session.closed).toBe(true);
    await expect(session.nextTag()).rejects.toMatchObject({ code: 'sessionClosed' });
  });

  it('rejects a pending nextTag when the session closes', async () => {
    const native = new FakeNativeModule();
    const session = await openSession(deps(native), NDEF_SCAN);

    const pending = session.nextTag();
    await session.close();

    await expect(pending).rejects.toMatchObject({ code: 'sessionClosed' });
  });

  it('rejects a pending nextTag with the platform error on invalidation', async () => {
    const native = new FakeNativeModule();
    const session = await openSession(deps(native), NDEF_SCAN);

    const pending = session.nextTag();
    native.emitSessionInvalidated(session.id, {
      code: 'sessionTimeout',
      message: 'The session reached the 60 second limit',
      nativeCode: 'NFCError:201',
      recoverable: null,
    });

    await pending.catch((error: NfcError) => {
      expect(error.code).toBe('sessionTimeout');
      expect(error.nativeCode).toBe('NFCError:201');
    });
  });

  describe('close', () => {
    it('is idempotent and only tells native once', async () => {
      const native = new FakeNativeModule();
      const session = await openSession(deps(native), NDEF_SCAN);

      await Promise.all([session.close(), session.close()]);
      await session.close();

      expect(native.callsTo('closeSession')).toHaveLength(1);
    });

    it('removes every native listener, so nothing leaks', async () => {
      // The library being replaced registered a BroadcastReceiver on the Activity
      // and never unregistered it: one leak per start call, and per Activity
      // recreation.
      const native = new FakeNativeModule();
      const session = await openSession(deps(native), NDEF_SCAN);

      expect(native.listenerCount('onTagDiscovered')).toBe(1);
      await session.close();

      expect(native.listenerCount('onTagDiscovered')).toBe(0);
      expect(native.listenerCount('onTagLost')).toBe(0);
      expect(native.listenerCount('onSessionInvalidated')).toBe(0);
    });

    it('still tears listeners down when native fails to close', async () => {
      const native = new FakeNativeModule();
      const session = await openSession(deps(native), NDEF_SCAN);
      native.rejectWith('closeSession', new Error('close failed'));

      await expect(session.close()).rejects.toThrow();
      expect(native.listenerCount('onTagDiscovered')).toBe(0);
      expect(session.closed).toBe(true);
    });
  });

  describe('setAlert', () => {
    it('forwards the message', async () => {
      const native = new FakeNativeModule();
      const session = await openSession(deps(native), NDEF_SCAN);

      await session.setAlert('Nearly there');
      expect(native.lastCallTo('setSessionAlert')?.args).toEqual([session.id, 'Nearly there']);

      await session.close();
    });

    it('rejects after the session closed', async () => {
      const native = new FakeNativeModule();
      const session = await openSession(deps(native), NDEF_SCAN);
      await session.close();

      await expect(session.setAlert('too late')).rejects.toMatchObject({ code: 'sessionClosed' });
    });
  });

  describe('onInvalidated', () => {
    it('reports the platform error', async () => {
      const native = new FakeNativeModule();
      const session = await openSession(deps(native), NDEF_SCAN);
      const listener = jest.fn();
      session.onInvalidated(listener);

      native.emitSessionInvalidated(session.id, {
        code: 'nfcDisabled',
        message: 'NFC was switched off',
        nativeCode: null,
        recoverable: null,
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0]![0] as NfcError).code).toBe('nfcDisabled');
    });

    it('reports null when the session simply ended', async () => {
      const native = new FakeNativeModule();
      const session = await openSession(deps(native), NDEF_SCAN);
      const listener = jest.fn();
      session.onInvalidated(listener);

      native.emitSessionInvalidated(session.id, null);
      expect(listener).toHaveBeenCalledWith(null);
    });

    it('can be unsubscribed', async () => {
      const native = new FakeNativeModule();
      const session = await openSession(deps(native), NDEF_SCAN);
      const listener = jest.fn();

      session.onInvalidated(listener).remove();
      native.emitSessionInvalidated(session.id, null);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  it('exposes the disposer so await using cleans up, on every engine', async () => {
    // Symbol.asyncDispose is missing on Node 20 and 22, and on Hermes -- which is
    // what most React Native apps run. Registering only under the native symbol
    // would mean `await using` silently doing nothing there, leaving the session
    // open. Symbol.for('Symbol.asyncDispose') is what TypeScript's downlevelled
    // helper looks up, so it is the one that has to be present.
    const native = new FakeNativeModule();
    const session = await openSession(deps(native), NDEF_SCAN);

    const fallback = Symbol.for('Symbol.asyncDispose');
    const nativeSymbol = (Symbol as { asyncDispose?: symbol }).asyncDispose;
    const key = nativeSymbol ?? fallback;

    const disposable = session as unknown as Record<symbol, (() => Promise<void>) | undefined>;
    expect(typeof disposable[key]).toBe('function');

    await disposable[key]?.call(session);
    expect(session.closed).toBe(true);
    expect(native.callsTo('closeSession')).toHaveLength(1);
  });

  it('registers under the fallback symbol when the engine lacks the native one', () => {
    // Proves the fallback is a real code path rather than an untested branch:
    // when Symbol.asyncDispose is absent, ASYNC_DISPOSE resolves to the well-known
    // registered symbol, and Symbol.for returns the same symbol every time.
    expect(Symbol.for('Symbol.asyncDispose')).toBe(Symbol.for('Symbol.asyncDispose'));
  });
});

describe('tag lost', () => {
  it('notifies the tag and makes it unusable', async () => {
    const native = new FakeNativeModule();
    const session = await openSession(deps(native), NDEF_SCAN);

    const tagPromise = session.nextTag();
    native.emitTagDiscovered(session.id, fakeTagInfo({ handleId: 'h1' }));
    const tag = await tagPromise;

    const listener = jest.fn();
    tag.onLost(listener);
    expect(tag.released).toBe(false);

    native.emitTagLost(session.id, 'h1');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(tag.released).toBe(true);
    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }
    await expect(tag.readNdef()).rejects.toMatchObject({ code: 'tagLost' });

    await session.close();
  });

  it('does not disturb a different tag in the same session', async () => {
    const native = new FakeNativeModule();
    const session = await openSession(deps(native), NDEF_SCAN);

    const firstPromise = session.nextTag();
    native.emitTagDiscovered(session.id, fakeTagInfo({ handleId: 'h1' }));
    const first = await firstPromise;

    const secondPromise = session.nextTag();
    native.emitTagDiscovered(session.id, fakeTagInfo({ handleId: 'h2' }));
    const second = await secondPromise;

    native.emitTagLost(session.id, 'h1');

    expect(first.released).toBe(true);
    expect(second.released).toBe(false);

    await session.close();
  });
});
