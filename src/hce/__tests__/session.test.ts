import { NfcError } from '../../errors.js';
import { createUriRecord, encodeMessage } from '../../ndef/index.js';
import { FakeNativeModule } from '../../native/__tests__/fakeNative.js';
import { decodeResponseApdu, encodeCommandApdu } from '../../protocols/iso7816.js';
import { Instruction, SELECT_BY_NAME, StatusWord, statusResponse } from '../apdu.js';
import {
  emulateNdef,
  isHceSupported,
  resetHceForTests,
  startHce,
  type HceDependencies,
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

  it('refuses a message the card has no room for', async () => {
    const session = await emulateNdef(deps(native), message);

    expect(() => session.setMessage(new Uint8Array(4096))).toThrow(NfcError);
    await session.stop();
  });
});
