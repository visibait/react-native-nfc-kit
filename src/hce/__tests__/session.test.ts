import { NfcError } from '../../errors.js';
import { createUriRecord, encodeMessage } from '../../ndef/index.js';
import { FakeNativeModule } from '../../native/__tests__/fakeNative.js';
import { decodeResponseApdu, encodeCommandApdu } from '../../protocols/iso7816.js';
import { Instruction, SELECT_BY_NAME, StatusWord, statusResponse } from '../apdu.js';
import {
  emulateNdef,
  isHceSupported,
  isObserveModeSupported,
  resetHceForTests,
  startHce,
  type HceDependencies,
  type PollingFrame,
} from '../session.js';
import { NDEF_APPLICATION_AID } from '../type4.js';

function deps(native: FakeNativeModule): HceDependencies {
  return { native, platform: 'android' };
}

/** Lets the queued handler for a delivered command run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

const SELECT_NDEF_APPLICATION = encodeCommandApdu({
  cla: 0x00,
  ins: Instruction.select,
  p1: SELECT_BY_NAME,
  p2: 0x00,
  data: NDEF_APPLICATION_AID,
});

let native: FakeNativeModule;

beforeEach(() => {
  native = new FakeNativeModule();
});

afterEach(() => {
  resetHceForTests();
});

describe('isHceSupported', () => {
  it('reports what the device says', async () => {
    native.hceSupported = false;

    await expect(isHceSupported(deps(native))).resolves.toBe(false);
  });
});

describe('startHce', () => {
  it('tells native the deadline and the fallback status word', async () => {
    // The deadline lives in native because the thing with a deadline is the radio
    // link, and JavaScript is exactly what might be too busy to notice.
    const session = await startHce(deps(native), { onCommand: () => statusResponse(0x9000) });

    expect(native.hceOptions).toEqual({
      timeoutMs: 1_000,
      timeoutStatus: StatusWord.unknown,
      aids: null,
      preferSelf: true,
      observeMode: false,
      pollingLoopFilters: null,
    });
    await session.stop();
  });

  it('passes runtime AIDs through', async () => {
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      aids: ['F0010203040506'],
    });

    expect(native.hceOptions?.aids).toEqual(['F0010203040506']);
    await session.stop();
  });

  it('answers a command with what the handler returned', async () => {
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(StatusWord.ok),
    });

    const requestId = native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await flush();

    expect(native.hceResponseTo(requestId)).toEqual(new Uint8Array([0x90, 0x00]));
    await session.stop();
  });

  it('hands the handler the bytes the terminal sent', async () => {
    const seen: Uint8Array[] = [];
    const session = await startHce(deps(native), {
      onCommand: (command) => {
        seen.push(command);
        return statusResponse(StatusWord.ok);
      },
    });

    native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await flush();

    expect(seen[0]).toEqual(SELECT_NDEF_APPLICATION);
    await session.stop();
  });

  it('awaits an async handler', async () => {
    const session = await startHce(deps(native), {
      onCommand: async () => {
        await Promise.resolve();
        return statusResponse(StatusWord.fileNotFound);
      },
    });

    const requestId = native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await flush();

    expect(native.hceResponseTo(requestId)).toEqual(new Uint8Array([0x6a, 0x82]));
    await session.stop();
  });

  it('answers commands in the order they arrived', async () => {
    // A terminal sends them one at a time and expects them answered that way.
    // Running two handlers at once lets a card answer a SELECT after the READ
    // that followed it.
    const order: number[] = [];
    let releaseFirst!: () => void;

    const session = await startHce(deps(native), {
      onCommand: async () => {
        order.push(order.length);
        if (order.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return statusResponse(StatusWord.ok);
      },
    });

    native.emitHceCommand(SELECT_NDEF_APPLICATION);
    native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await flush();

    expect(order).toEqual([0]);

    releaseFirst();
    await flush();

    expect(order).toEqual([0, 1]);
    await session.stop();
  });

  it('still answers the terminal when the handler throws', async () => {
    // A card cannot decline to answer. Silence makes the terminal wait for its
    // own timeout and then report a hardware fault.
    const onError = jest.fn();
    const session = await startHce(deps(native), {
      onCommand: () => {
        throw new Error('boom');
      },
      onError,
    });

    const requestId = native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await flush();

    expect(native.hceResponseTo(requestId)).toEqual(new Uint8Array([0x6f, 0x00]));
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(NfcError);
    await session.stop();
  });

  it('logs a handler failure when nothing is listening for errors', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const session = await startHce(deps(native), {
        onCommand: () => {
          throw new Error('boom');
        },
      });

      native.emitHceCommand(SELECT_NDEF_APPLICATION);
      await flush();

      expect(consoleError).toHaveBeenCalled();
      await session.stop();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('reports a response that arrived too late without failing', async () => {
    // The deadline elapsed and native already answered. Nothing the app can do
    // about it, and nothing it needs to handle, so it is not an error.
    const onError = jest.fn();
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(StatusWord.ok),
      onError,
    });

    native.hceExpired.add('hce-1');
    const requestId = native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await flush();

    expect(native.hceResponseTo(requestId)).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    await session.stop();
  });

  it('reports a failure to send the response', async () => {
    const onError = jest.fn();
    native.rejectWith('respondToHce', new Error('binder died'));
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(StatusWord.ok),
      onError,
    });

    native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await flush();

    expect(onError).toHaveBeenCalled();
    await session.stop();
  });

  it('forwards deactivation, distinguishing why', async () => {
    const reasons: string[] = [];
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(StatusWord.ok),
      onDeactivated: (reason) => reasons.push(reason),
    });

    native.emitHceDeactivated('deselected');
    native.emitHceDeactivated('linkLoss');

    // "Someone else's turn" and "the phone was moved away" call for different
    // handling, so they are not collapsed into one signal.
    expect(reasons).toEqual(['deselected', 'linkLoss']);
    await session.stop();
  });

  it('treats an unknown deactivation reason as link loss', async () => {
    const reasons: string[] = [];
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(StatusWord.ok),
      onDeactivated: (reason) => reasons.push(reason),
    });

    native.emit('onHceDeactivated', { reason: 'something-new' });

    // A newer platform reporting a reason this build has never heard of should
    // still end the conversation, not be dropped.
    expect(reasons).toEqual(['linkLoss']);
    await session.stop();
  });

  it('refuses a second session rather than replacing the first', async () => {
    const session = await startHce(deps(native), { onCommand: () => statusResponse(0x9000) });

    await expect(
      startHce(deps(native), { onCommand: () => statusResponse(0x9000) }),
    ).rejects.toMatchObject({ code: 'systemBusy' });

    await session.stop();
  });

  it('allows a new session after the first stops', async () => {
    await (await startHce(deps(native), { onCommand: () => statusResponse(0x9000) })).stop();

    const second = await startHce(deps(native), { onCommand: () => statusResponse(0x9000) });
    expect(second.active).toBe(true);
    await second.stop();
  });

  it('rejects a nonsensical deadline', async () => {
    for (const timeoutMs of [0, -1, 1.5]) {
      await expect(
        startHce(deps(native), { onCommand: () => statusResponse(0x9000), timeoutMs }),
      ).rejects.toMatchObject({ code: 'invalidArgument' });
    }
  });

  it('detaches its listeners when starting fails', async () => {
    // Listeners go on before the start call so a command arriving during it is
    // not missed, which means they have to come off again if it fails.
    native.rejectWith('startHce', new Error('no service'));

    await expect(
      startHce(deps(native), { onCommand: () => statusResponse(0x9000) }),
    ).rejects.toThrow();

    expect(native.listenerCount('onHceCommand')).toBe(0);
    expect(native.listenerCount('onHceDeactivated')).toBe(0);
  });

  it('leaves no session behind when starting fails', async () => {
    native.rejectWith('startHce', new Error('no service'));
    await expect(
      startHce(deps(native), { onCommand: () => statusResponse(0x9000) }),
    ).rejects.toThrow();

    native.rejections.delete('startHce');
    // A refused start must not report `systemBusy` for a session that never began.
    const session = await startHce(deps(native), { onCommand: () => statusResponse(0x9000) });
    await session.stop();
  });
});

describe('preferred service', () => {
  it('asks for it by default, and reports whether it was granted', async () => {
    // Without it the user's default wallet keeps the tap, which is right for a
    // phone in general and wrong for an app the user is looking at.
    const session = await startHce(deps(native), { onCommand: () => statusResponse(0x9000) });

    expect(native.hceOptions?.preferSelf).toBe(true);
    expect(session.preferred).toBe(true);
    await session.stop();
  });

  it('reports honestly when the platform refused', async () => {
    // Typically because there is no foreground activity. Observe mode and polling
    // frames are unavailable in that state, so an app needs to be able to tell.
    native.hcePreferred = false;
    const session = await startHce(deps(native), { onCommand: () => statusResponse(0x9000) });

    expect(session.preferred).toBe(false);
    await session.stop();
  });

  it('can be turned off', async () => {
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      preferSelf: false,
    });

    expect(native.hceOptions?.preferSelf).toBe(false);
    expect(session.preferred).toBe(false);
    await session.stop();
  });
});

describe('observe mode', () => {
  beforeEach(() => {
    native.observeModeSupported = true;
  });

  it('reports what the controller says', async () => {
    native.observeModeSupported = false;

    await expect(isObserveModeSupported(deps(native))).resolves.toBe(false);
  });

  it('starts silent when asked', async () => {
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      observeMode: true,
    });

    expect(session.observeMode).toBe(true);
    await session.stop();
  });

  it('does not claim to be silent on a device that cannot be', async () => {
    // Believing the card is held while it is answering is the worst outcome here:
    // the user is never asked and the transaction happens anyway.
    native.observeModeSupported = false;
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      observeMode: true,
    });

    expect(session.observeMode).toBe(false);
    await session.stop();
  });

  it('lets the card answer once the app allows it', async () => {
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      observeMode: true,
    });

    await expect(session.setObserveMode(false)).resolves.toBe(true);

    expect(session.observeMode).toBe(false);
    expect(native.observeModeEnabled).toBe(false);
    await session.stop();
  });

  it('keeps reporting silent when the platform refuses the change', async () => {
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      observeMode: true,
    });

    // The platform grants this only to the service it prefers. Recording the
    // requested value rather than the accepted one would leave the app thinking
    // its card is answering while it is still silent.
    native.observeModeAllowed = false;
    await expect(session.setObserveMode(false)).resolves.toBe(false);

    expect(session.observeMode).toBe(true);
    await session.stop();
  });

  it('is off again after the session stops', async () => {
    // Left on, it would hold every other card emulation app on the device silent,
    // and nothing else would turn it off.
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      observeMode: true,
    });

    await session.stop();

    expect(native.observeModeEnabled).toBe(false);
  });
});

describe('polling frames', () => {
  it('registers the filters it was given', async () => {
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      pollingLoopFilters: [
        { pattern: '6a' },
        { pattern: '6a.*', isPattern: true, autoTransact: true },
      ],
    });

    expect(native.hceOptions?.pollingLoopFilters).toEqual([
      { pattern: '6a', isPattern: false, autoTransact: false },
      { pattern: '6a.*', isPattern: true, autoTransact: true },
    ]);
    await session.stop();
  });

  it('delivers frames with their bytes decoded', async () => {
    const seen: PollingFrame[][] = [];
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      onPollingFrames: (frames) => seen.push([...frames]),
    });

    native.emitPollingFrames([
      { type: 'a', dataHex: '26', gain: 12, timestamp: 100 },
      { type: 'off', dataHex: '', gain: -1, timestamp: 220 },
    ]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toEqual({
      type: 'a',
      data: new Uint8Array([0x26]),
      gain: 12,
      timestamp: 100,
      triggeredAutoTransact: false,
    });
    expect(seen[0]?.[1]?.type).toBe('off');
    await session.stop();
  });

  it('calls an unrecognised frame type unknown rather than dropping the frame', async () => {
    // A newer platform can report a type this build has never heard of, and the
    // frame still says a reader is there.
    const seen: PollingFrame[] = [];
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      onPollingFrames: (frames) => seen.push(...frames),
    });

    native.emitPollingFrames([{ type: 'v', dataHex: 'ff' }]);

    expect(seen[0]?.type).toBe('unknown');
    expect(seen[0]?.data).toEqual(new Uint8Array([0xff]));
    await session.stop();
  });

  it('reports a frame that made the platform answer on its own', async () => {
    const seen: PollingFrame[] = [];
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      onPollingFrames: (frames) => seen.push(...frames),
    });

    native.emitPollingFrames([{ type: 'a', dataHex: '26', triggeredAutoTransact: true }]);

    expect(seen[0]?.triggeredAutoTransact).toBe(true);
    await session.stop();
  });

  it('stops delivering once the session stops', async () => {
    const onPollingFrames = jest.fn();
    const session = await startHce(deps(native), {
      onCommand: () => statusResponse(0x9000),
      onPollingFrames,
    });

    await session.stop();
    native.emitPollingFrames([{ type: 'a', dataHex: '26' }]);

    expect(onPollingFrames).not.toHaveBeenCalled();
    expect(native.listenerCount('onPollingFrames')).toBe(0);
  });

  it('is harmless with no handler attached', async () => {
    const session = await startHce(deps(native), { onCommand: () => statusResponse(0x9000) });

    expect(() => native.emitPollingFrames([{ type: 'a', dataHex: '26' }])).not.toThrow();
    await session.stop();
  });
});

describe('stopping', () => {
  it('detaches from native and stops answering', async () => {
    const handler = jest.fn(() => statusResponse(StatusWord.ok));
    const session = await startHce(deps(native), { onCommand: handler });

    await session.stop();

    expect(session.active).toBe(false);
    expect(native.listenerCount('onHceCommand')).toBe(0);
    native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await flush();
    expect(handler).not.toHaveBeenCalled();
  });

  it('is idempotent', async () => {
    const session = await startHce(deps(native), { onCommand: () => statusResponse(0x9000) });

    await session.stop();
    await session.stop();

    expect(native.callsTo('stopHce')).toHaveLength(1);
  });
});

describe('stopping mid-command', () => {
  it('drops a command already queued when the session stops', async () => {
    // The event is queued before `stop()` runs, so the check has to be where the
    // handler starts, not only where it is scheduled.
    const handler = jest.fn(() => statusResponse(StatusWord.ok));
    const session = await startHce(deps(native), { onCommand: handler });

    native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await session.stop();
    await flush();

    expect(handler).not.toHaveBeenCalled();
  });

  it('says nothing about a failure that lands after the session stopped', async () => {
    const onError = jest.fn();
    let finishHandler!: () => void;
    native.rejectWith('respondToHce', new Error('binder died'));

    const session = await startHce(deps(native), {
      onCommand: () =>
        new Promise<Uint8Array>((resolve) => {
          finishHandler = () => resolve(statusResponse(StatusWord.ok));
        }),
      onError,
    });

    native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await flush();

    // The handler is still running when the app stops emulating. Reporting to a
    // listener that has already gone is noise arriving after the fact.
    await session.stop();
    finishHandler();
    await flush();

    expect(onError).not.toHaveBeenCalled();
  });
});

describe('emulateNdef', () => {
  const message = encodeMessage([createUriRecord('https://www.ventry.es/entrada')]);

  it('answers the application select a terminal starts with', async () => {
    const session = await emulateNdef(deps(native), message);

    const requestId = native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await flush();

    const response = decodeResponseApdu(native.hceResponseTo(requestId) as Uint8Array);
    expect(response.ok).toBe(true);
    await session.stop();
  });

  it('holds the message it was given', async () => {
    const session = await emulateNdef(deps(native), message);

    expect(session.message).toEqual(message);
    expect(session.active).toBe(true);
    await session.stop();
    expect(session.active).toBe(false);
  });

  it('serves a replaced message to the next terminal', async () => {
    const session = await emulateNdef(deps(native), message, { card: { capacity: 512 } });
    const replacement = encodeMessage([createUriRecord('https://www.ventry.es/otra')]);

    session.setMessage(replacement);

    expect(session.message).toEqual(replacement);
    await session.stop();
  });

  it('makes the card forget its selection when the terminal goes', async () => {
    // A real card loses power. Without this the next terminal inherits a
    // half-finished handshake and reads a file it never selected.
    const session = await emulateNdef(deps(native), message);

    native.emitHceCommand(SELECT_NDEF_APPLICATION);
    await flush();
    native.emitHceDeactivated('linkLoss');

    const readWithoutSelecting = encodeCommandApdu({
      cla: 0x00,
      ins: Instruction.readBinary,
      p1: 0x00,
      p2: 0x00,
      le: 2,
    });
    const requestId = native.emitHceCommand(readWithoutSelecting);
    await flush();

    const response = decodeResponseApdu(native.hceResponseTo(requestId) as Uint8Array);
    expect(response.status).toBe(StatusWord.conditionsNotSatisfied);
    await session.stop();
  });

  it('exposes the same emulation controls as a raw session', async () => {
    // `emulateNdef` is a convenience over `start`, not a narrower thing: an app
    // that wants to hold the card silent should not have to drop down to raw
    // APDUs to do it.
    native.observeModeSupported = true;
    const session = await emulateNdef(deps(native), message, { observeMode: true });

    expect(session.preferred).toBe(true);
    expect(session.observeMode).toBe(true);

    await expect(session.setObserveMode(false)).resolves.toBe(true);
    expect(session.observeMode).toBe(false);

    await session.stop();
  });

  it('refuses a message the card has no room for', async () => {
    const session = await emulateNdef(deps(native), message);

    expect(() => session.setMessage(new Uint8Array(4096))).toThrow(NfcError);
    await session.stop();
  });
});
