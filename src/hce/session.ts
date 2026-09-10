/**
 * Card emulation, from the app's side.
 *
 * The shape to hold in mind: a terminal sends command APDUs and the app answers
 * them, one at a time, for as long as the phone is in the field. Your handler is
 * the card.
 *
 * Two things about this are unlike the reader APIs, and both come from the
 * platform rather than from a choice made here:
 *
 * - **The app has to be running.** Android starts its HCE service when a terminal
 *   taps, with no reference to any Activity and no guarantee a JavaScript runtime
 *   exists. When one does not, the terminal is answered `6F00` by native so it
 *   gets a definite refusal rather than silence.
 * - **There is a deadline per command.** A terminal will not wait indefinitely and
 *   neither will the radio link. Native enforces it, because JavaScript is exactly
 *   what might be too busy to notice, and answers on your behalf when it elapses.
 */

import { NfcError, type NfcPlatform } from '../errors.js';
import { fromHex } from '../ndef/bytes.js';
import {
  HCE_DEACTIVATION_REASONS,
  type HceDeactivationReason,
  type NativeNfcKitModule,
} from '../native/contract.js';
import { callNative } from '../native/errors.js';
import { StatusWord, statusResponse } from './apdu.js';
import { createType4Card, type Type4CardOptions } from './type4.js';

export interface HceDependencies {
  readonly native: NativeNfcKitModule;
  readonly platform: NfcPlatform;
}

/** The default deadline, in milliseconds, for answering one command. */
export const DEFAULT_HCE_TIMEOUT_MS = 1_000;

export interface HceOptions {
  /**
   * Answers one command APDU.
   *
   * Return the full response including its status word -- `encodeResponseApdu`
   * and `statusResponse` build one. Throwing is allowed and answers `6F00`, but
   * returning a status word that says what went wrong is far more use to whoever
   * is holding the terminal.
   */
  readonly onCommand: (command: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  /**
   * Called when the terminal stops talking to the card.
   *
   * `linkLoss` means the phone was moved away; `deselected` means the terminal
   * selected a different application. Either way any card state tied to that
   * conversation should be dropped, or the next terminal inherits it.
   */
  readonly onDeactivated?: (reason: HceDeactivationReason) => void;
  /** Called when a command could not be answered. */
  readonly onError?: (error: NfcError) => void;
  /**
   * How long to answer one command in, in milliseconds. Defaults to 1000.
   *
   * Lower it if your handler is fast and you would rather the terminal get a
   * refusal quickly; raise it only if you know the terminal is patient.
   */
  readonly timeoutMs?: number;
  /**
   * AIDs to register at runtime, replacing the ones in the manifest.
   *
   * Omit to use what the config plugin declared. Setting them here is what makes
   * changing an AID not require a new build.
   */
  readonly aids?: readonly string[];
}

export interface HceSession {
  /** Stops emulating. Idempotent. */
  stop(): Promise<void>;
  readonly active: boolean;
}

/** Whether this device can emulate a card at all. */
export async function isHceSupported(deps: HceDependencies): Promise<boolean> {
  return callNative(deps.platform, 'isHceSupported', () => deps.native.isHceSupported());
}

function toDeactivationReason(value: string): HceDeactivationReason {
  return (HCE_DEACTIVATION_REASONS as readonly string[]).includes(value)
    ? (value as HceDeactivationReason)
    : 'linkLoss';
}

/**
 * Starts emulating a card.
 *
 * ```ts
 * const session = await hce.start({
 *   onCommand: (apdu) => card.handle(apdu),
 *   onDeactivated: () => card.deactivate(),
 * });
 * ```
 *
 * Only one session at a time, because there is only one NFC controller and only
 * one HCE service. Starting a second rejects `systemBusy` rather than quietly
 * replacing the first, which would leave a terminal talking to a handler the app
 * had already forgotten about.
 */
export async function startHce(deps: HceDependencies, options: HceOptions): Promise<HceSession> {
  if (activeSession !== null) {
    throw new NfcError({
      code: 'systemBusy',
      message:
        'Card emulation is already running. Stop the existing session before starting another: ' +
        'the device has one HCE service, so two handlers cannot both be the card.',
      platform: deps.platform,
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_HCE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new NfcError({
      code: 'invalidArgument',
      message: `timeoutMs must be a positive whole number of milliseconds; received ${timeoutMs}.`,
      platform: deps.platform,
    });
  }

  let stopped = false;

  const report = (error: unknown): void => {
    if (stopped) {
      return;
    }
    const nfcError = NfcError.is(error)
      ? error
      : new NfcError({
          code: 'internalError',
          message: 'Answering a card-emulation command failed.',
          platform: deps.platform,
          cause: error,
        });

    if (options.onError !== undefined) {
      options.onError(nfcError);
    } else {
      console.error(
        '[react-native-nfc-kit] A card-emulation handler failed with no onError handler:',
        nfcError,
      );
    }
  };

  // Commands are answered strictly in order. A terminal sends them one at a time
  // and expects them answered that way; running two handlers concurrently would
  // let a card answer a SELECT after the READ that followed it.
  let queue: Promise<void> = Promise.resolve();

  const commands = deps.native.addListener('onHceCommand', (event) => {
    queue = queue.then(async () => {
      if (stopped) {
        return;
      }
      let response: Uint8Array;
      try {
        response = await options.onCommand(fromHex(event.commandHex));
      } catch (error) {
        report(error);
        // A card cannot decline to answer, so a thrown handler still sends
        // something the terminal can act on.
        response = statusResponse(StatusWord.unknown);
      }

      try {
        await callNative(deps.platform, 'respondToHce', () =>
          deps.native.respondToHce(event.requestId, response),
        );
      } catch (error) {
        report(error);
      }
    });
  });

  // No stopped guard: `stop` removes this listener, so it cannot fire afterwards.
  // A command handler does need one, because a command already queued can still
  // be waiting when the session stops.
  const deactivations = deps.native.addListener('onHceDeactivated', (event) => {
    options.onDeactivated?.(toDeactivationReason(event.reason));
  });

  const detach = (): void => {
    commands.remove();
    deactivations.remove();
  };

  try {
    await callNative(deps.platform, 'startHce', () =>
      deps.native.startHce({
        timeoutMs,
        timeoutStatus: StatusWord.unknown,
        aids: options.aids ?? null,
      }),
    );
  } catch (error) {
    // Listeners are attached first so a command arriving during start is not
    // missed, which means they have to come off again if start fails.
    detach();
    throw error;
  }

  const session: HceSession = {
    get active(): boolean {
      return !stopped;
    },
    stop: async (): Promise<void> => {
      if (stopped) {
        return;
      }
      stopped = true;
      activeSession = null;
      detach();
      await callNative(deps.platform, 'stopHce', () => deps.native.stopHce());
    },
  };

  activeSession = session;
  return session;
}

/** The one session, so a second `start` can refuse rather than replace it. */
let activeSession: HceSession | null = null;

/** Drops the module-level session. Tests only. */
export function resetHceForTests(): void {
  activeSession = null;
}

export interface EmulateNdefOptions extends Omit<HceOptions, 'onCommand' | 'onDeactivated'> {
  /** Everything `createType4Card` accepts, apart from the message itself. */
  readonly card?: Omit<Type4CardOptions, 'message'>;
}

export interface NdefEmulationSession extends HceSession {
  /** Replaces the message the next terminal will read. */
  setMessage(message: Uint8Array): void;
  /** The message currently held, including anything a terminal wrote. */
  readonly message: Uint8Array;
}

/**
 * Emulates an NDEF tag, which is what most apps actually want.
 *
 * ```ts
 * const session = await hce.emulateNdef(
 *   encodeMessage([createUriRecord('https://www.ventry.es/entrada')]),
 * );
 * ```
 *
 * A reader, another phone, or a door controller expecting a tag reads it without
 * knowing it is talking to software. The command handling is
 * `createType4Card`, so it can be tested without a device and shares its
 * implementation with nothing platform-specific.
 */
export async function emulateNdef(
  deps: HceDependencies,
  message: Uint8Array,
  options: EmulateNdefOptions = {},
): Promise<NdefEmulationSession> {
  const card = createType4Card({ ...options.card, message });
  const { card: _cardOptions, ...hceOptions } = options;

  const session = await startHce(deps, {
    ...hceOptions,
    onCommand: (command) => card.handle(command),
    // The card forgets its selection when the terminal goes, which is what a real
    // card does by losing power, and what stops the next terminal inheriting a
    // half-finished handshake.
    onDeactivated: () => card.deactivate(),
  });

  return {
    get active(): boolean {
      return session.active;
    },
    get message(): Uint8Array {
      return card.message;
    },
    setMessage: (next: Uint8Array): void => {
      card.setMessage(next);
    },
    stop: () => session.stop(),
  };
}
