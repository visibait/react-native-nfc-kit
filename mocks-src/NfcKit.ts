/**
 * Jest mock for the `NfcKit` native module.
 *
 * `jest-expo` finds this file automatically: it locates the package that called
 * `requireOptionalNativeModule('NfcKit')` and loads `mocks/NfcKit` from its root.
 * So a consumer using the `jest-expo` preset gets a working fake with no setup at
 * all, and `nfc.isSupported()` answers instead of throwing.
 *
 * What it does by default: reports NFC as present and enabled, and returns an empty
 * NDEF message. What it deliberately does not do: pretend a tag was presented.
 * There is no hardware, so no discovery event ever fires, and `nfc.withTag(...)`
 * stays pending until its timeout. Faking a tap would make a test pass while
 * proving nothing about a real card.
 *
 * To drive it, import the control surface and script it:
 *
 * ```ts
 * import { __nfcKitMock } from 'react-native-nfc-kit/mocks/NfcKit';
 *
 * beforeEach(() => __nfcKitMock.reset());
 *
 * it('reads a ticket', async () => {
 *   __nfcKitMock.setNdefMessage(encodeMessage([createTextRecord('ticket-42')]));
 *   const scan = nfc.withTag({ tech: ['ndef'] }, (tag) =>
 *     tag.is('ndef') ? tag.readNdef() : null,
 *   );
 *   __nfcKitMock.presentTag();          // the tap
 *   expect(await scan).toHaveLength(1);
 * });
 * ```
 */

type Listener = (event: never) => void;

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

const DEFAULT_TECHS = ['ndef', 'ndefFormatable', 'isoDep', 'nfcA'];

/** An empty NDEF message: one record with TNF 0x00. */
const EMPTY_NDEF_MESSAGE: Uint8Array = new Uint8Array([0xd0, 0x00, 0x00]);

const listeners = new Map<string, Set<Listener>>();
const calls: RecordedCall[] = [];

interface MockState {
  supported: boolean;
  enabled: boolean;
  ndefMessage: Uint8Array;
  transceiveResponse: Uint8Array;
  sessionId: string | null;
  nextHandle: number;
  antennaInfo: AntennaInfo | null;
  secureNfcEnabled: boolean;
}

interface AntennaInfo {
  deviceWidth: number;
  deviceHeight: number;
  deviceFoldable: boolean;
  antennas: { locationX: number; locationY: number }[];
}

/** A plausible mid-size phone with one antenna in the upper middle of the back. */
const DEFAULT_ANTENNA_INFO: AntennaInfo = {
  deviceWidth: 71,
  deviceHeight: 147,
  deviceFoldable: false,
  antennas: [{ locationX: 35, locationY: 110 }],
};

const state: MockState = {
  supported: true,
  enabled: true,
  ndefMessage: EMPTY_NDEF_MESSAGE,
  transceiveResponse: new Uint8Array([0x90, 0x00]),
  sessionId: null,
  nextHandle: 0,
  antennaInfo: DEFAULT_ANTENNA_INFO,
  secureNfcEnabled: false,
};

function emit(event: string, payload: unknown): void {
  for (const listener of [...(listeners.get(event) ?? [])]) {
    (listener as (value: unknown) => void)(payload);
  }
}

function record<T>(method: string, args: readonly unknown[], result: T): Promise<T> {
  calls.push({ method, args });
  return Promise.resolve(result);
}

/** Test control surface. Not part of the library's runtime API. */
export const __nfcKitMock = {
  /** Every native call the code under test made, in order. */
  get calls(): readonly RecordedCall[] {
    return calls;
  },

  /** Whether a session is currently open, as the code under test believes. */
  get openSessionId(): string | null {
    return state.sessionId;
  },

  reset(): void {
    listeners.clear();
    calls.length = 0;
    state.supported = true;
    state.enabled = true;
    state.ndefMessage = EMPTY_NDEF_MESSAGE;
    state.transceiveResponse = new Uint8Array([0x90, 0x00]);
    state.sessionId = null;
    state.nextHandle = 0;
    state.antennaInfo = DEFAULT_ANTENNA_INFO;
    state.secureNfcEnabled = false;
  },

  setAvailability(supported: boolean, enabled: boolean): void {
    state.supported = supported;
    state.enabled = enabled;
    emit('onAvailabilityChanged', { supported, enabled });
  },

  /** Bytes the next `readNdef` returns. Encode them with the library's codec. */
  setNdefMessage(bytes: Uint8Array): void {
    state.ndefMessage = bytes;
  },

  /**
   * What `getAntennaInfo` reports. `null` stands in for a device that does not
   * say where its antenna is, which is most of them.
   */
  setAntennaInfo(info: AntennaInfo | null): void {
    state.antennaInfo = info;
  },

  /** Whether NFC is restricted to an unlocked screen. */
  setSecureNfcEnabled(enabled: boolean): void {
    state.secureNfcEnabled = enabled;
  },

  /** Bytes the next `transceive` returns. */
  setTransceiveResponse(bytes: Uint8Array): void {
    state.transceiveResponse = bytes;
  },

  /**
   * Simulates a tag being presented to the open session.
   *
   * Throws when no session is open, because that is a bug in the test rather than
   * something to paper over: the code under test never asked to scan.
   */
  presentTag(
    overrides: {
      idHex?: string | null;
      techs?: readonly string[];
    } = {},
  ): string {
    if (state.sessionId === null) {
      throw new Error(
        'No NFC session is open, so no tag can be presented. Start the scan first, then let ' +
          'its promise reach the point of waiting before calling presentTag().',
      );
    }

    state.nextHandle += 1;
    const handleId = `mock-handle-${state.nextHandle}`;

    emit('onTagDiscovered', {
      sessionId: state.sessionId,
      tag: {
        handleId,
        idHex: overrides.idHex === undefined ? '04a2b3c4d5e6f0' : overrides.idHex,
        techs: overrides.techs ?? DEFAULT_TECHS,
        android: {
          techList: ['android.nfc.tech.Ndef', 'android.nfc.tech.IsoDep'],
          maxTransceiveLength: 253,
          hiLayerResponseHex: null,
          historicalBytesHex: null,
        },
        ios: null,
      },
    });

    return handleId;
  },

  /** Simulates the tag leaving the field. */
  removeTag(handleId: string): void {
    if (state.sessionId !== null) {
      emit('onTagLost', { sessionId: state.sessionId, handleId });
    }
  },

  /**
   * Simulates the platform ending the session -- the user dismissing the iOS
   * sheet, or the 60 second limit.
   */
  invalidateSession(code = 'userCancelled', message = 'The scan was cancelled'): void {
    if (state.sessionId === null) {
      return;
    }
    const sessionId = state.sessionId;
    state.sessionId = null;
    emit('onSessionInvalidated', {
      sessionId,
      error: { code, message, nativeCode: null, recoverable: null },
    });
  },
};

/* -------------------------------------------------------------------------- */
/* The mocked native surface                                                  */
/* -------------------------------------------------------------------------- */

export const contractVersion = 6;

export const capabilities = {
  platform: 'android',
  osVersion: 'mock',
  techs: DEFAULT_TECHS,
  tagLost: 'polled',
  perSessionConfig: false,
  hce: true,
  observeMode: true,
  pollingFrames: true,
  vas: false,
  backgroundReading: true,
  antennaInfo: true,
  secureNfc: true,
};

export function addListener(event: string, listener: Listener): { remove(): void } {
  let set = listeners.get(event);
  if (set === undefined) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(listener);

  return {
    remove: () => {
      listeners.get(event)?.delete(listener);
    },
  };
}

export function isSupported(): Promise<boolean> {
  return record('isSupported', [], state.supported);
}

export function isEnabled(): Promise<boolean> {
  return record('isEnabled', [], state.enabled);
}

export function openSettings(): Promise<void> {
  return record('openSettings', [], undefined);
}

export function getAntennaInfo(): Promise<AntennaInfo | null> {
  return record('getAntennaInfo', [], state.antennaInfo);
}

export function isSecureNfcEnabled(): Promise<boolean> {
  return record('isSecureNfcEnabled', [], state.secureNfcEnabled);
}

export function startSession(sessionId: string, options: unknown): Promise<void> {
  state.sessionId = sessionId;
  return record('startSession', [sessionId, options], undefined);
}

export function closeSession(sessionId: string): Promise<void> {
  if (state.sessionId === sessionId) {
    state.sessionId = null;
  }
  return record('closeSession', [sessionId], undefined);
}

export function setSessionAlert(sessionId: string, message: string): Promise<void> {
  return record('setSessionAlert', [sessionId, message], undefined);
}

export function releaseTag(handleId: string): Promise<void> {
  return record('releaseTag', [handleId], undefined);
}

export function readNdef(handleId: string): Promise<Uint8Array> {
  return record('readNdef', [handleId], state.ndefMessage);
}

export function writeNdef(handleId: string, message: Uint8Array): Promise<void> {
  return record('writeNdef', [handleId, message], undefined);
}

export function getNdefStatus(handleId: string): Promise<{
  writable: boolean;
  capacity: number;
  canMakeReadOnly: boolean;
  typeName: string | null;
}> {
  return record('getNdefStatus', [handleId], {
    writable: true,
    capacity: 137,
    canMakeReadOnly: true,
    typeName: 'NFC Forum Type 2',
  });
}

export function makeNdefReadOnly(handleId: string): Promise<void> {
  return record('makeNdefReadOnly', [handleId], undefined);
}

export function formatNdef(handleId: string, message: Uint8Array): Promise<void> {
  return record('formatNdef', [handleId, message], undefined);
}

export function transceive(handleId: string, tech: string, data: Uint8Array): Promise<Uint8Array> {
  return record('transceive', [handleId, tech, data], state.transceiveResponse);
}

export function getMaxTransceiveLength(handleId: string, tech: string): Promise<number> {
  return record('getMaxTransceiveLength', [handleId, tech], 253);
}

export function setTechTimeout(handleId: string, tech: string, timeoutMs: number): Promise<void> {
  return record('setTechTimeout', [handleId, tech, timeoutMs], undefined);
}

export function getTechTimeout(handleId: string, tech: string): Promise<number> {
  return record('getTechTimeout', [handleId, tech], 300);
}

export function takeLaunchTag(): Promise<null> {
  return record('takeLaunchTag', [], null);
}

/* -------------------------------------------------------------------------- */
/* Card emulation                                                             */
/* -------------------------------------------------------------------------- */

export function isHceSupported(): Promise<boolean> {
  return record('isHceSupported', [], true);
}

export function startHce(options: unknown): Promise<{ preferred: boolean; observeMode: boolean }> {
  return record('startHce', [options], { preferred: true, observeMode: false });
}

export function isObserveModeSupported(): Promise<boolean> {
  return record('isObserveModeSupported', [], true);
}

export function isObserveModeEnabled(): Promise<boolean> {
  return record('isObserveModeEnabled', [], false);
}

export function setObserveModeEnabled(enabled: boolean): Promise<boolean> {
  return record('setObserveModeEnabled', [enabled], true);
}

export function stopHce(): Promise<void> {
  return record('stopHce', [], undefined);
}

export function respondToHce(requestId: string, response: Uint8Array): Promise<boolean> {
  return record('respondToHce', [requestId, response], true);
}

/* -------------------------------------------------------------------------- */
/* Wallet passes                                                              */
/* -------------------------------------------------------------------------- */

export function isVasSupported(): Promise<boolean> {
  return record('isVasSupported', [], false);
}

export function readVas(options: unknown): Promise<unknown[]> {
  return record('readVas', [options], []);
}
