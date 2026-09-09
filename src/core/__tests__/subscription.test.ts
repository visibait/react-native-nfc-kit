import { EMPTY_SUBSCRIPTION, Listeners } from '../subscription.js';

describe('EMPTY_SUBSCRIPTION', () => {
  it('can be removed without doing anything', () => {
    expect(() => {
      EMPTY_SUBSCRIPTION.remove();
      EMPTY_SUBSCRIPTION.remove();
    }).not.toThrow();
  });
});

describe('Listeners', () => {
  it('starts empty', () => {
    expect(new Listeners<[]>().size).toBe(0);
  });

  it('invokes every listener with the emitted arguments', () => {
    const listeners = new Listeners<[string, number]>();
    const first = jest.fn();
    const second = jest.fn();

    listeners.add(first);
    listeners.add(second);
    listeners.emit('tag', 7);

    expect(first).toHaveBeenCalledWith('tag', 7);
    expect(second).toHaveBeenCalledWith('tag', 7);
  });

  it('keeps a second listener instead of replacing the first', () => {
    // The library being replaced kept one callback per event name, so registering
    // again silently discarded the previous listener.
    const listeners = new Listeners<[]>();
    listeners.add(jest.fn());
    listeners.add(jest.fn());

    expect(listeners.size).toBe(2);
  });

  it('stops calling a listener once removed', () => {
    const listeners = new Listeners<[]>();
    const listener = jest.fn();

    const subscription = listeners.add(listener);
    listeners.emit();
    subscription.remove();
    listeners.emit();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it('treats removing twice as a no-op', () => {
    // A React effect cleanup can run more than once; it must not need a guard.
    const listeners = new Listeners<[]>();
    const subscription = listeners.add(jest.fn());

    subscription.remove();
    expect(() => subscription.remove()).not.toThrow();
    expect(listeners.size).toBe(0);
  });

  it('does not let a double remove fire the last-listener hook twice', () => {
    const onLastListenerRemoved = jest.fn();
    const listeners = new Listeners<[]>({ onLastListenerRemoved });

    const subscription = listeners.add(jest.fn());
    subscription.remove();
    subscription.remove();

    expect(onLastListenerRemoved).toHaveBeenCalledTimes(1);
  });

  describe('observation hooks', () => {
    it('fires on the first listener and on the last removal only', () => {
      // These are what let native start reader mode only while somebody is
      // listening, and stop it again when nobody is.
      const onFirstListener = jest.fn();
      const onLastListenerRemoved = jest.fn();
      const listeners = new Listeners<[]>({ onFirstListener, onLastListenerRemoved });

      const first = listeners.add(jest.fn());
      expect(onFirstListener).toHaveBeenCalledTimes(1);

      const second = listeners.add(jest.fn());
      expect(onFirstListener).toHaveBeenCalledTimes(1);

      first.remove();
      expect(onLastListenerRemoved).not.toHaveBeenCalled();

      second.remove();
      expect(onLastListenerRemoved).toHaveBeenCalledTimes(1);
    });

    it('fires the first hook again after going empty and refilling', () => {
      const onFirstListener = jest.fn();
      const listeners = new Listeners<[]>({ onFirstListener });

      listeners.add(jest.fn()).remove();
      listeners.add(jest.fn());

      expect(onFirstListener).toHaveBeenCalledTimes(2);
    });

    it('works with no hooks supplied', () => {
      const listeners = new Listeners<[]>();
      expect(() => listeners.add(jest.fn()).remove()).not.toThrow();
    });
  });

  describe('emit safety', () => {
    it('keeps calling the rest when one listener throws, and reports it', () => {
      const failing = jest.fn(() => {
        throw new Error('listener blew up');
      });
      const surviving = jest.fn();
      const listeners = new Listeners<[]>();
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      listeners.add(failing);
      listeners.add(surviving);

      // A listener that throws must not stop the others, and must not propagate
      // into the native event callback that triggered the emit. It is reported
      // rather than swallowed: an unhandled rejection would terminate the
      // process, turning one buggy listener into a crash somewhere unrelated.
      expect(() => listeners.emit()).not.toThrow();
      expect(surviving).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        '[react-native-nfc-kit] A listener threw and was ignored:',
        expect.any(Error),
      );

      consoleError.mockRestore();
    });

    it('tolerates a listener that removes itself mid-emit', () => {
      const listeners = new Listeners<[]>();
      const calls: string[] = [];

      const subscription = listeners.add(() => {
        calls.push('self-removing');
        subscription.remove();
      });
      listeners.add(() => calls.push('other'));

      listeners.emit();
      expect(calls).toEqual(['self-removing', 'other']);

      listeners.emit();
      expect(calls).toEqual(['self-removing', 'other', 'other']);
    });

    it('does not call a listener added during the same emit', () => {
      const listeners = new Listeners<[]>();
      const added = jest.fn();

      listeners.add(() => {
        listeners.add(added);
      });

      listeners.emit();
      expect(added).not.toHaveBeenCalled();

      listeners.emit();
      expect(added).toHaveBeenCalledTimes(1);
    });

    it('emits to nobody without complaint', () => {
      expect(() => new Listeners<[]>().emit()).not.toThrow();
    });
  });

  describe('clear', () => {
    it('removes everything and fires the last-listener hook', () => {
      const onLastListenerRemoved = jest.fn();
      const listeners = new Listeners<[]>({ onLastListenerRemoved });
      const listener = jest.fn();

      listeners.add(listener);
      listeners.clear();
      listeners.emit();

      expect(listeners.size).toBe(0);
      expect(listener).not.toHaveBeenCalled();
      expect(onLastListenerRemoved).toHaveBeenCalledTimes(1);
    });

    it('does not fire the hook when there was nothing to clear', () => {
      const onLastListenerRemoved = jest.fn();
      new Listeners<[]>({ onLastListenerRemoved }).clear();
      expect(onLastListenerRemoved).not.toHaveBeenCalled();
    });
  });
});
