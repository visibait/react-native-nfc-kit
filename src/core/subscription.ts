/**
 * Subscriptions.
 *
 * A real emitter, not a single-slot callback map. The library being replaced kept
 * one callback per event name, so registering a second listener silently replaced
 * the first, and there was no way to unsubscribe at all -- the documented removal
 * mechanism was passing `null`.
 *
 * Registering is cheap and removing is idempotent, so a React effect can attach in
 * the body and detach in the cleanup without guarding against double calls.
 */

/** Handle returned by anything that registers a listener. */
export interface Subscription {
  /** Detaches the listener. Safe to call more than once. */
  remove(): void;
}

/** A subscription that is already detached. */
export const EMPTY_SUBSCRIPTION: Subscription = { remove: () => {} };

/**
 * A minimal multi-listener emitter for one event.
 *
 * `onFirstListener` and `onLastListenerRemoved` exist so the native side can be
 * asked to start and stop work only while somebody is actually listening, which
 * is what `OnStartObserving`/`OnStopObserving` are for on the native side.
 */
export class Listeners<Args extends readonly unknown[]> {
  private readonly listeners = new Set<(...args: Args) => void>();

  constructor(
    private readonly hooks: {
      onFirstListener?: () => void;
      onLastListenerRemoved?: () => void;
    } = {},
  ) {}

  get size(): number {
    return this.listeners.size;
  }

  add(listener: (...args: Args) => void): Subscription {
    const wasEmpty = this.listeners.size === 0;
    this.listeners.add(listener);

    if (wasEmpty) {
      this.hooks.onFirstListener?.();
    }

    let removed = false;
    return {
      remove: () => {
        if (removed) {
          return;
        }
        removed = true;

        this.listeners.delete(listener);
        if (this.listeners.size === 0) {
          this.hooks.onLastListenerRemoved?.();
        }
      },
    };
  }

  /**
   * Invokes every listener.
   *
   * Iterates a copy, so a listener that removes itself -- or adds another -- does
   * not disturb the set mid-iteration. A listener added during an emit is not
   * called by that same emit.
   *
   * A throwing listener must not stop the others, and must not propagate into the
   * native event callback that triggered the emit, so the throw is reported and
   * iteration continues. It is reported through `console.error` rather than as an
   * unhandled rejection: an unhandled rejection terminates a Node process and
   * fails a test run outright, which turns one app's buggy listener into a
   * crash somewhere entirely unrelated.
   */
  emit(...args: Args): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(...args);
      } catch (error) {
        console.error('[react-native-nfc-kit] A listener threw and was ignored:', error);
      }
    }
  }

  clear(): void {
    const had = this.listeners.size > 0;
    this.listeners.clear();
    if (had) {
      this.hooks.onLastListenerRemoved?.();
    }
  }
}
