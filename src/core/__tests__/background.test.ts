import { NfcError } from '../../errors.js';
import { FakeNativeModule, fakeTagInfo } from '../../native/__tests__/fakeNative.js';
import { onBackgroundTag, withLaunchTag, type BackgroundDependencies } from '../background.js';
import type { Tag } from '../tag.js';

function deps(native: FakeNativeModule): BackgroundDependencies {
  return { native, platform: 'android' };
}

/** Lets the queued handler for a delivered background tag run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

let native: FakeNativeModule;

beforeEach(() => {
  native = new FakeNativeModule();
});

describe('withLaunchTag', () => {
  it('answers null on an ordinary launch', async () => {
    // Which is nearly every launch, so this has to be safe to call
    // unconditionally on startup rather than something to guard.
    await expect(withLaunchTag(deps(native), () => 'ran')).resolves.toBeNull();
  });

  it('runs the work with the tag that launched the app', async () => {
    native.setLaunchTag(fakeTagInfo({ handleId: 'bg-1', idHex: '04a1b2c3' }));

    const id = await withLaunchTag(deps(native), (tag) => tag.id);

    expect(id).not.toBeNull();
    expect(native.callsTo('takeLaunchTag')).toHaveLength(1);
  });

  it('reads the message the system already took from the tag', async () => {
    // The card is normally out of the field before any JavaScript runs, so this
    // is the one operation that still works -- and the usual reason to configure
    // background reading at all.
    native.setLaunchTag(fakeTagInfo({ handleId: 'bg-1' }));
    native.ndefBytes = new Uint8Array([0xd1, 0x01, 0x01, 0x54, 0x02]);

    const message = await withLaunchTag(deps(native), (tag) =>
      tag.is('ndef') ? tag.readNdef() : null,
    );

    expect(message).toEqual([
      {
        tnf: 1,
        type: new Uint8Array([0x54]),
        id: new Uint8Array(),
        payload: new Uint8Array([0x02]),
      },
    ]);
  });

  it('releases the tag when the work returns', async () => {
    native.setLaunchTag(fakeTagInfo({ handleId: 'bg-1' }));

    await withLaunchTag(deps(native), () => 'done');

    expect(native.callsTo('releaseTag')).toHaveLength(1);
    expect(native.lastCallTo('releaseTag')?.args[0]).toBe('bg-1');
  });

  it('releases the tag when the work throws', async () => {
    native.setLaunchTag(fakeTagInfo({ handleId: 'bg-1' }));

    await expect(
      withLaunchTag(deps(native), () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(native.callsTo('releaseTag')).toHaveLength(1);
  });

  it('rejects use of the tag after the work returned', async () => {
    native.setLaunchTag(fakeTagInfo({ handleId: 'bg-1' }));

    let escaped!: Tag;
    await withLaunchTag(deps(native), (tag) => {
      escaped = tag;
    });

    // A native handle that outlives its scope is a leak with a delayed failure;
    // this turns it into an immediate, named one.
    await expect(escaped.is('ndef') ? escaped.readNdef() : Promise.resolve()).rejects.toMatchObject(
      { code: 'sessionClosed' },
    );
  });

  it('reports the tag as released once the work is done', async () => {
    native.setLaunchTag(fakeTagInfo({ handleId: 'bg-1' }));

    let escaped!: Tag;
    await withLaunchTag(deps(native), (tag) => {
      expect(tag.released).toBe(false);
      escaped = tag;
    });

    expect(escaped.released).toBe(true);
  });

  it('consumes the tag, so a second call answers null', async () => {
    // Rotating the screen hands the same launch intent to the recreated
    // activity. Without consumption that replays a tap from minutes ago.
    native.setLaunchTag(fakeTagInfo({ handleId: 'bg-1' }));

    await expect(withLaunchTag(deps(native), () => 'first')).resolves.toBe('first');
    await expect(withLaunchTag(deps(native), () => 'second')).resolves.toBeNull();
  });

  it('reports the work result rather than the release', async () => {
    native.setLaunchTag(fakeTagInfo({ handleId: 'bg-1' }));
    native.rejectWith('releaseTag', new Error('release failed'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // A failure to hand the handle back is worth logging and worth not
      // replacing the answer the caller actually asked for.
      await expect(withLaunchTag(deps(native), () => 'value')).resolves.toBe('value');
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('never fires onLost, since the tag has already gone', async () => {
    native.setLaunchTag(fakeTagInfo({ handleId: 'bg-1' }));
    const lost = jest.fn();

    await withLaunchTag(deps(native), (tag) => {
      tag.onLost(lost);
    });

    expect(lost).not.toHaveBeenCalled();
  });
});

describe('onBackgroundTag', () => {
  it('delivers a tag the system dispatched while the app was running', async () => {
    const seen: string[] = [];
    const subscription = onBackgroundTag(deps(native), (tag) => {
      seen.push(tag.techs.join(','));
    });

    native.emitBackgroundTag();
    await flush();

    expect(seen).toHaveLength(1);
    subscription.remove();
  });

  it('releases each tag once its handler settles', async () => {
    const subscription = onBackgroundTag(deps(native), async () => {
      await Promise.resolve();
    });

    native.emitBackgroundTag(fakeTagInfo({ handleId: 'bg-7' }));
    await flush();

    expect(native.lastCallTo('releaseTag')?.args[0]).toBe('bg-7');
    subscription.remove();
  });

  it('handles tags one at a time', async () => {
    // Two taps in quick succession would otherwise run their handlers against
    // the same radio at once, and on Android the exchanges interleave.
    const order: string[] = [];
    let releaseFirst!: () => void;

    const subscription = onBackgroundTag(deps(native), async (tag) => {
      order.push(`start ${tag.techs.length}`);
      if (order.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      order.push('end');
    });

    native.emitBackgroundTag(fakeTagInfo({ handleId: 'bg-1' }));
    native.emitBackgroundTag(fakeTagInfo({ handleId: 'bg-2' }));
    await flush();

    expect(order).toEqual(['start 3']);

    releaseFirst();
    await flush();

    expect(order).toEqual(['start 3', 'end', 'start 3', 'end']);
    subscription.remove();
  });

  it('sends a handler failure to onError', async () => {
    const onError = jest.fn();
    const subscription = onBackgroundTag(
      deps(native),
      () => {
        throw new NfcError({ code: 'ndefMalformed', message: 'bad', platform: 'android' });
      },
      { onError },
    );

    native.emitBackgroundTag();
    await flush();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ndefMalformed' }));
    subscription.remove();
  });

  it('wraps a non-NfcError throw so onError always receives one', async () => {
    const onError = jest.fn();
    const subscription = onBackgroundTag(
      deps(native),
      () => {
        throw new Error('boom');
      },
      { onError },
    );

    native.emitBackgroundTag();
    await flush();

    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(NfcError);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'internalError' });
    subscription.remove();
  });

  it('logs when a handler fails and nothing is listening for errors', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const subscription = onBackgroundTag(deps(native), () => {
        throw new Error('boom');
      });

      native.emitBackgroundTag();
      await flush();

      // Swallowing it silently is how a tag handler that never worked stays
      // unnoticed until someone complains that "NFC does nothing".
      expect(consoleError).toHaveBeenCalled();
      subscription.remove();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('still releases the tag when the handler throws', async () => {
    const subscription = onBackgroundTag(
      deps(native),
      () => {
        throw new Error('boom');
      },
      { onError: () => {} },
    );

    native.emitBackgroundTag(fakeTagInfo({ handleId: 'bg-9' }));
    await flush();

    expect(native.lastCallTo('releaseTag')?.args[0]).toBe('bg-9');
    subscription.remove();
  });

  it('stops delivering once removed', async () => {
    const listener = jest.fn();
    const subscription = onBackgroundTag(deps(native), listener);

    subscription.remove();
    native.emitBackgroundTag();
    await flush();

    expect(listener).not.toHaveBeenCalled();
    expect(native.listenerCount('onBackgroundTag')).toBe(0);
  });

  it('drops a tag that arrives just before the subscription is removed', async () => {
    // The event is already queued when `remove()` runs, so the check has to be
    // at the point the handler starts, not only at the point it is scheduled.
    const listener = jest.fn();
    const subscription = onBackgroundTag(deps(native), listener);

    native.emitBackgroundTag();
    subscription.remove();
    await flush();

    expect(listener).not.toHaveBeenCalled();
  });

  it('says nothing about a release that fails after the subscription is gone', async () => {
    const onError = jest.fn();
    let finishHandler!: () => void;
    native.rejectWith('releaseTag', new Error('release failed'));

    const subscription = onBackgroundTag(
      deps(native),
      () =>
        new Promise<void>((resolve) => {
          finishHandler = resolve;
        }),
      { onError },
    );

    native.emitBackgroundTag();
    await flush();

    // The handler is still running when the caller unsubscribes -- a screen
    // being navigated away from, typically. Reporting an error to a listener
    // that has already gone is noise arriving after the fact.
    subscription.remove();
    finishHandler();
    await flush();

    expect(onError).not.toHaveBeenCalled();
  });

  it('supports more than one subscriber', async () => {
    const first = jest.fn();
    const second = jest.fn();
    const a = onBackgroundTag(deps(native), first);
    const b = onBackgroundTag(deps(native), second);

    native.emitBackgroundTag();
    await flush();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    a.remove();
    b.remove();
  });
});
