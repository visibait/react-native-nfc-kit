import { useEffect, useRef, useState } from 'react';

import { nfc, type TagStreamOptions } from '../core/nfc.js';
import type { Tag } from '../core/tag.js';
import type { NfcError } from '../errors.js';

export interface UseNfcTagStreamOptions extends Omit<TagStreamOptions, 'onError' | 'signal'> {
  /**
   * Whether the stream should be running. Defaults to `true`.
   *
   * Set it from screen focus. A reader-mode stream left running on a screen
   * nobody is looking at keeps Android's NFC controller held, so the next screen
   * that wants a tag cannot have one — and nothing on that screen explains why.
   */
  readonly enabled?: boolean;
}

export interface UseNfcTagStreamResult {
  /** Whether the stream is currently running. */
  readonly active: boolean;
  /** The failure that ended the stream, or `null`. Cleared when it restarts. */
  readonly error: NfcError | null;
}

/**
 * A key that changes only when the options meaningfully change.
 *
 * Depending on the options object itself would restart the stream on every
 * render, because an inline literal is a new object each time — and restarting
 * reader mode every render reads as "NFC randomly stops working" long before it
 * reads as a dependency-array bug.
 */
function streamKey(options: UseNfcTagStreamOptions, enabled: boolean): string {
  return JSON.stringify({
    enabled,
    tech: options.tech,
    timeoutMs: options.timeoutMs,
    config: options.config,
    ios: options.ios,
    android: options.android,
  });
}

/**
 * Reads tags continuously while the component is mounted.
 *
 * ```tsx
 * const { active, error } = useNfcTagStream(
 *   { tech: ['isoDep'], android: { presenceCheckDelayMs: 500 }, enabled: isFocused },
 *   async (tag) => { if (tag.is('isoDep')) await validateTicket(tag); },
 * );
 * ```
 *
 * This is the kiosk shape: a door reader, a top-up terminal, a check-in desk.
 * It is really an Android feature — reader mode stays up indefinitely — whereas
 * iOS caps a session at 60 seconds with a system sheet on screen throughout, so
 * there the stream ends with `sessionTimeout` and `error` is set. Restarting is
 * left to you, because on iOS restarting means putting the sheet back up, which
 * is a product decision rather than a technical one.
 *
 * The listener is read at call time, so it never needs memoising; the options are
 * compared by value, so an inline object literal does not restart the stream.
 */
export function useNfcTagStream(
  options: UseNfcTagStreamOptions,
  listener: (tag: Tag) => void | Promise<void>,
): UseNfcTagStreamResult {
  const enabled = options.enabled ?? true;
  const key = streamKey(options, enabled);

  // The failure is stored against the run that produced it, so a restart clears
  // it by arithmetic rather than by a state update inside the effect.
  const [failure, setFailure] = useState<{ key: string; error: NfcError } | null>(null);
  const error = failure !== null && failure.key === key ? failure.error : null;

  // Updated after commit rather than during render: a render React discards
  // must not leave a mutation behind. Declared before the subscribing effect so
  // that on a restart the fresh values are in place before it reads them.
  const latest = useRef({ options, listener });
  useEffect(() => {
    latest.current = { options, listener };
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const { enabled: _ignored, ...streamOptions } = latest.current.options;
    // No mounted guard on `onError`: removing the subscription stops the stream
    // reporting, so this cannot arrive after the cleanup below has run.
    const subscription = nfc.onTag(
      {
        ...streamOptions,
        onError: (streamError) => {
          setFailure({ key, error: streamError });
        },
      },
      (tag) => latest.current.listener(tag),
    );

    return () => {
      subscription.remove();
    };
  }, [enabled, key]);

  return { active: enabled && error === null, error };
}
