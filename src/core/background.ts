/**
 * Tags that arrive because the user tapped one at the operating system, rather
 * than because the app asked for one.
 *
 * Two different things, and they are kept apart because they fail differently:
 *
 * - **The launch tag.** The app was not running; a tap started it. The tag is
 *   almost always out of the field again by the time any JavaScript runs, so what
 *   survives is the NDEF message the system read before dispatching. Pulled with
 *   `withLaunchTag`, and only once.
 * - **A tag while running.** The app was in the background or on another screen
 *   and the system handed the tag over. Pushed to `onBackgroundTag`.
 *
 * Both are Android-only in practice. iOS reads NDEF tags in the background
 * itself, without involving the app at all: a URI record opens its link, which
 * reaches the app as a universal link if the domain is yours. There is no CoreNFC
 * surface that hands over the tag, so both of these simply never produce one
 * there.
 */

import { NfcError, type NfcPlatform } from '../errors.js';
import type { NativeNfcKitModule, NativeTagInfo } from '../native/contract.js';
import { callNative } from '../native/errors.js';
import { EMPTY_SUBSCRIPTION, type Subscription } from './subscription.js';
import { createTag, type Tag, type TagRuntime } from './tag.js';

export interface BackgroundDependencies {
  readonly native: NativeNfcKitModule;
  readonly platform: NfcPlatform;
}

/** A background tag plus the release its owner has to run. */
interface HeldTag {
  readonly tag: Tag;
  release(): Promise<void>;
}

function hold(deps: BackgroundDependencies, info: NativeTagInfo): HeldTag {
  let released = false;

  const runtime: TagRuntime = {
    native: deps.native,
    platform: deps.platform,
    info,
    assertUsable: () => {
      if (released) {
        throw new NfcError({
          code: 'sessionClosed',
          message:
            'This background tag has been released. A tag handed to withLaunchTag or ' +
            'onBackgroundTag is only usable inside that call.',
          platform: deps.platform,
        });
      }
    },
    isReleased: () => released,
    // A background tag is never watched for removal: it is normally gone before
    // the app is even looking, so a watcher would announce that immediately and
    // say nothing useful. `onLost` therefore never fires for one.
    addLostListener: () => EMPTY_SUBSCRIPTION,
  };

  return {
    tag: createTag(runtime),
    // Called exactly once, from the `finally` of whichever entry point handed
    // the tag out. No re-entry guard, because there is no second caller to
    // guard against and a guard would suggest otherwise.
    release: async () => {
      released = true;
      await callNative(deps.platform, 'releaseTag', () => deps.native.releaseTag(info.handleId));
    },
  };
}

/**
 * Runs `work` with the tag that launched the app, if one did.
 *
 * ```ts
 * const ticket = await nfc.withLaunchTag(async (tag) =>
 *   tag.is('ndef') ? decodeMessage(await tag.readNdef()) : null,
 * );
 * ```
 *
 * Resolves to `null` when the app was not started by a tag, which is almost every
 * launch — so this is safe to call unconditionally on startup.
 *
 * Scoped rather than a plain getter for the same reason `withTag` is: the handle
 * is a real native resource, and an API that hands one out and trusts the caller
 * to give it back is an API that leaks. The tag is released when `work` returns,
 * on every path, and using it afterwards rejects with `sessionClosed`.
 *
 * The tag is consumed: a second call answers `null`. That is deliberate, and it
 * is also what stops a screen rotation — which hands the same launch intent to
 * the recreated activity — from replaying a tap the user made minutes ago.
 *
 * `tag.readNdef()` works even though the card has usually gone, because the
 * system read the message before dispatching and it travelled with the intent.
 * Anything that needs the radio — `transceive`, `writeNdef` — will fail with
 * `tagLost` unless the card is genuinely still there.
 */
export async function withLaunchTag<T>(
  deps: BackgroundDependencies,
  work: (tag: Tag) => Promise<T> | T,
): Promise<T | null> {
  const info = await callNative(deps.platform, 'takeLaunchTag', () => deps.native.takeLaunchTag());
  if (info === null) {
    return null;
  }

  const held = hold(deps, info);
  try {
    return await work(held.tag);
  } finally {
    await held.release().catch((error: unknown) => {
      console.error('[react-native-nfc-kit] Releasing the launch tag failed:', error);
    });
  }
}

export interface BackgroundTagOptions {
  /**
   * Called when handling a background tag throws.
   *
   * Without it a failure would be silent: this returns a subscription rather than
   * a promise, so there is nothing for a rejection to reach.
   */
  readonly onError?: (error: NfcError) => void;
}

/**
 * Delivers tags the system dispatches while the app is running.
 *
 * ```ts
 * const subscription = nfc.onBackgroundTag(async (tag) => {
 *   if (tag.is('ndef')) await handle(await tag.readNdef());
 * });
 * ```
 *
 * This fires only for tags matching the intent filters in the app's manifest —
 * see `docs/setup/background-reading.md`. Reader mode (`withTag`, `openSession`,
 * `onTag`) needs none of that and does not come through here.
 *
 * The tag is released once the listener settles, so awaiting slow work is fine
 * and the tag stays usable for as long as that work runs.
 */
export function onBackgroundTag(
  deps: BackgroundDependencies,
  listener: (tag: Tag) => void | Promise<void>,
  options: BackgroundTagOptions = {},
): Subscription {
  let stopped = false;

  const report = (error: unknown): void => {
    if (stopped) {
      return;
    }
    const nfcError = NfcError.is(error)
      ? error
      : new NfcError({
          code: 'internalError',
          message: 'Handling a background tag failed.',
          platform: deps.platform,
          cause: error,
        });

    if (options.onError !== undefined) {
      options.onError(nfcError);
    } else {
      console.error(
        '[react-native-nfc-kit] A background tag handler failed with no onError handler:',
        nfcError,
      );
    }
  };

  // Tags are handled one at a time. Two taps in quick succession would otherwise
  // run their handlers concurrently against the same radio, and on Android the
  // exchanges would interleave.
  let queue: Promise<void> = Promise.resolve();

  const subscription = deps.native.addListener('onBackgroundTag', (event) => {
    queue = queue.then(async () => {
      if (stopped) {
        return;
      }
      const held = hold(deps, event.tag);
      try {
        await listener(held.tag);
      } catch (error) {
        report(error);
      } finally {
        await held.release().catch(report);
      }
    });
  });

  return {
    remove: () => {
      stopped = true;
      subscription.remove();
    },
  };
}
