import { NfcError } from '../../errors.js';
import { Deferred, abortedError, runWithDeadline, timeoutError, withDeadline } from '../async.js';

/** A promise that never settles, for observing abort and timeout. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('error constructors', () => {
  it('abortedError names the operation', () => {
    const error = abortedError('readNdef');
    expect(error.code).toBe('aborted');
    expect(error.message).toContain('readNdef');
    expect(error.recoverable).toBe(false);
  });

  it('timeoutError names the operation and the limit', () => {
    const error = timeoutError('transceive', 250);
    expect(error.code).toBe('timeout');
    expect(error.message).toContain('transceive');
    expect(error.message).toContain('250 ms');
    // Worth retrying: the tag may simply have been slow.
    expect(error.recoverable).toBe(true);
  });
});

describe('withDeadline', () => {
  it('passes the promise straight through when there is no deadline', async () => {
    const promise = Promise.resolve('value');
    await expect(withDeadline(promise, {}, 'op')).resolves.toBe('value');
  });

  it('returns the very same promise when there is nothing to race', () => {
    // Avoids wrapping every call in an extra promise for no reason.
    const promise = Promise.resolve(1);
    expect(withDeadline(promise, {}, 'op')).toBe(promise);
  });

  it('resolves normally when the work finishes first', async () => {
    await expect(withDeadline(Promise.resolve(42), { timeoutMs: 1000 }, 'op')).resolves.toBe(42);
  });

  it('rejects with the underlying error when the work fails first', async () => {
    const failure = new NfcError({ code: 'tagLost', message: 'gone' });
    await expect(withDeadline(Promise.reject(failure), { timeoutMs: 1000 }, 'op')).rejects.toBe(
      failure,
    );
  });

  it('rejects with aborted when the signal fires', async () => {
    const controller = new AbortController();
    const pending = withDeadline(never(), { signal: controller.signal }, 'readNdef');

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('rejects immediately when the signal has already fired', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(withDeadline(never(), { signal: controller.signal }, 'op')).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('preserves an NfcError the caller aborted with', async () => {
    // So a caller can abort with their own reason and get it back unchanged.
    const reason = new NfcError({ code: 'sessionClosed', message: 'session went away' });
    const controller = new AbortController();
    controller.abort(reason);

    await expect(withDeadline(never(), { signal: controller.signal }, 'op')).rejects.toBe(reason);
  });

  it('keeps a non-NfcError abort reason as the cause', async () => {
    const reason = new Error('user navigated away');
    const controller = new AbortController();
    controller.abort(reason);

    await withDeadline(never(), { signal: controller.signal }, 'op').catch((error: NfcError) => {
      expect(error.code).toBe('aborted');
      expect(error.cause).toBe(reason);
    });
  });

  it('rejects with timeout once the deadline passes', async () => {
    jest.useFakeTimers();
    try {
      const pending = withDeadline(never(), { timeoutMs: 300 }, 'transceive');
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      jest.advanceTimersByTime(300);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the timer when the work wins, so nothing keeps running', async () => {
    jest.useFakeTimers();
    try {
      const clearSpy = jest.spyOn(global, 'clearTimeout');
      await withDeadline(Promise.resolve('done'), { timeoutMs: 1000 }, 'op');
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes the abort listener when the work wins, so the signal is not retained', async () => {
    const controller = new AbortController();
    const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');

    await withDeadline(Promise.resolve('done'), { signal: controller.signal }, 'op');
    expect(removeSpy).toHaveBeenCalled();
  });

  it('whichever fires first wins the race', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = withDeadline(never(), { signal: controller.signal, timeoutMs: 1000 }, 'op');

      controller.abort();
      const error = await pending.catch((e: NfcError) => e);
      expect(error.code).toBe('aborted');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid timeout of %s as a caller bug',
    async (timeoutMs) => {
      await expect(withDeadline(never(), { timeoutMs }, 'op')).rejects.toMatchObject({
        code: 'invalidArgument',
      });
    },
  );
});

describe('runWithDeadline', () => {
  it('does not start the work when the signal has already fired', async () => {
    // The distinction that matters: an aborted operation must not reach the tag.
    // withDeadline receives a promise, so the call has already been made.
    const start = jest.fn(() => never<void>());
    const controller = new AbortController();
    controller.abort();

    await expect(runWithDeadline(start, { signal: controller.signal }, 'op')).rejects.toMatchObject(
      {
        code: 'aborted',
      },
    );
    expect(start).not.toHaveBeenCalled();
  });

  it('starts the work when the signal has not fired', async () => {
    const start = jest.fn(() => Promise.resolve('ok'));
    const controller = new AbortController();

    await expect(runWithDeadline(start, { signal: controller.signal }, 'op')).resolves.toBe('ok');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts the work when there is no signal at all', async () => {
    const start = jest.fn(() => Promise.resolve(1));
    await expect(runWithDeadline(start, {}, 'op')).resolves.toBe(1);
  });
});

describe('Deferred', () => {
  it('resolves from outside', async () => {
    const deferred = new Deferred<string>();
    expect(deferred.isSettled).toBe(false);

    deferred.resolve('tag');
    await expect(deferred.promise).resolves.toBe('tag');
    expect(deferred.isSettled).toBe(true);
  });

  it('rejects from outside', async () => {
    const deferred = new Deferred<string>();
    const failure = new NfcError({ code: 'systemBusy', message: 'busy' });

    deferred.reject(failure);
    await expect(deferred.promise).rejects.toBe(failure);
  });

  it('ignores a second resolve rather than throwing', async () => {
    // Native delivering the same event twice is a bug, but it must not become a
    // crash in the caller's code. Double-settling a promise is what killed the
    // equivalent path in the library being replaced, fatally under the New
    // Architecture.
    const deferred = new Deferred<string>();

    deferred.resolve('first');
    expect(() => deferred.resolve('second')).not.toThrow();
    await expect(deferred.promise).resolves.toBe('first');
  });

  it('ignores a reject after a resolve', async () => {
    const deferred = new Deferred<string>();

    deferred.resolve('first');
    deferred.reject(new Error('too late'));
    await expect(deferred.promise).resolves.toBe('first');
  });

  it('ignores a resolve after a reject', async () => {
    const deferred = new Deferred<string>();
    const failure = new Error('first');

    deferred.reject(failure);
    deferred.resolve('too late');
    await expect(deferred.promise).rejects.toBe(failure);
  });
});
