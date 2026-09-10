/**
 * A scriptable stand-in for the native module.
 *
 * The library's own tests inject this rather than relying on `jest-expo`'s mock
 * discovery, which finds a mock by walking the stack and regex-matching source
 * text. That indirection is acceptable for a consumer's test suite but too fragile
 * to build this one on: moving the `requireOptionalNativeModule` call would
 * silently disable every mock and the tests would keep passing against nothing.
 *
 * It records every call, so a test can assert what actually crossed the boundary
 * rather than only what came back.
 */

import type {
  NativeAvailabilityEvent,
  NativeBackgroundTagEvent,
  NativeHceCommandEvent,
  NativeHceDeactivatedEvent,
  NativeHceOptions,
  NativeHceStarted,
  NativePollingFrame,
  NativePollingFramesEvent,
  NativeCapabilities,
  NativeEventMap,
  NativeEventName,
  NativeNdefStatus,
  NativeNfcKitModule,
  NativeSessionInvalidatedEvent,
  NativeSessionOptions,
  NativeSubscription,
  NativeTagDiscoveredEvent,
  NativeTagInfo,
  NativeTagLostEvent,
} from '../contract.js';
import { CONTRACT_VERSION } from '../contract.js';

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeNativeOptions {
  contractVersion?: number;
  capabilities?: Partial<NativeCapabilities>;
}

const DEFAULT_CAPABILITIES: NativeCapabilities = {
  platform: 'android',
  osVersion: '15',
  techs: ['ndef', 'ndefFormatable', 'isoDep', 'nfcA', 'nfcB', 'mifareClassic', 'mifareUltralight'],
  tagLost: 'polled',
  perSessionConfig: false,
  hce: false,
  observeMode: false,
  pollingFrames: false,
  backgroundReading: true,
};

/**
 * Builds a tag info payload.
 *
 * Defaults to an Android NDEF + ISO-DEP tag, because that is the combination most
 * real access-control tags present.
 */
export function fakeTagInfo(overrides: Partial<NativeTagInfo> = {}): NativeTagInfo {
  return {
    handleId: 'handle-1',
    idHex: '04a2b3c4d5e6f0',
    techs: ['ndef', 'isoDep', 'nfcA'],
    android: {
      techList: ['android.nfc.tech.Ndef', 'android.nfc.tech.IsoDep', 'android.nfc.tech.NfcA'],
      maxTransceiveLength: 253,
      hiLayerResponseHex: null,
      historicalBytesHex: '8073c021c057',
    },
    ios: null,
    ...overrides,
  };
}

export class FakeNativeModule implements NativeNfcKitModule {
  readonly contractVersion: number;
  readonly capabilities: NativeCapabilities;

  /** Every call that crossed the boundary, in order. */
  readonly calls: RecordedCall[] = [];

  /** Programmable results, keyed by method name. */
  supported = true;
  enabled = true;
  ndefBytes: Uint8Array = new Uint8Array([0xd0, 0x00, 0x00]);
  ndefStatus: NativeNdefStatus = {
    writable: true,
    capacity: 137,
    canMakeReadOnly: true,
    typeName: 'NFC Forum Type 2',
  };
  transceiveResponse: Uint8Array = new Uint8Array([0x90, 0x00]);
  maxTransceiveLength = 253;
  techTimeout = 300;
  launchTag: NativeTagInfo | null = null;

  /** When set, the named method rejects with this instead of resolving. */
  readonly rejections = new Map<string, unknown>();

  /**
   * Resolvers for calls the test wants to leave pending.
   *
   * Needed to exercise abort and timeout, which are only observable while a call
   * has not settled.
   */
  readonly pending = new Map<string, () => void>();

  private readonly listeners = new Map<NativeEventName, Set<(event: never) => void>>();

  constructor(options: FakeNativeOptions = {}) {
    this.contractVersion = options.contractVersion ?? CONTRACT_VERSION;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }

  /* ---------------------------------------------------------------------- */
  /* Test controls                                                          */
  /* ---------------------------------------------------------------------- */

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  lastCallTo(method: string): RecordedCall | undefined {
    return this.callsTo(method).at(-1);
  }

  /** Makes `method` reject with `error` until cleared. */
  rejectWith(method: string, error: unknown): void {
    this.rejections.set(method, error);
  }

  /** Makes `method` hang until `settlePending` is called, or forever. */
  hangOn(method: string): void {
    this.pending.set(method, () => {});
  }

  /**
   * Lets a hung call resolve.
   *
   * Needed to test what happens when a native answer arrives *after* the caller
   * has gone -- a screen navigated away from mid-call. That is a real race, and
   * the only way to observe the guard against it is to run it.
   */
  settlePending(method: string): void {
    const settle = this.pending.get(method);
    if (settle === undefined) {
      throw new Error(`No pending call to "${method}"`);
    }
    this.pending.delete(method);
    settle();
  }

  emit<E extends NativeEventName>(event: E, payload: Parameters<NativeEventMap[E]>[0]): void {
    const set = this.listeners.get(event);
    if (set === undefined) {
      return;
    }
    for (const listener of [...set]) {
      (listener as (value: typeof payload) => void)(payload);
    }
  }

  emitTagDiscovered(sessionId: string, tag: NativeTagInfo = fakeTagInfo()): void {
    this.emit('onTagDiscovered', { sessionId, tag } satisfies NativeTagDiscoveredEvent);
  }

  emitTagLost(sessionId: string, handleId = 'handle-1'): void {
    this.emit('onTagLost', { sessionId, handleId } satisfies NativeTagLostEvent);
  }

  emitSessionInvalidated(
    sessionId: string,
    error: NativeSessionInvalidatedEvent['error'] = null,
  ): void {
    this.emit('onSessionInvalidated', { sessionId, error } satisfies NativeSessionInvalidatedEvent);
  }

  emitBackgroundTag(tag: NativeTagInfo = fakeTagInfo({ handleId: 'bg-1' })): void {
    this.emit('onBackgroundTag', { tag } satisfies NativeBackgroundTagEvent);
  }

  /**
   * Makes `takeLaunchTag` answer once, the way the platform does.
   *
   * Consuming it here rather than returning the same tag forever is the point:
   * a launch tag that could be taken twice would let a test pass while the real
   * module replayed a tap after every screen rotation.
   */
  setLaunchTag(tag: NativeTagInfo | null): void {
    this.launchTag = tag;
  }

  /**
   * Delivers a command APDU as the platform would, and records the answer.
   *
   * Returns the request id so a test can assert what went back to the terminal,
   * which is the only thing that actually matters about a card.
   */
  emitHceCommand(command: Uint8Array): string {
    const requestId = `hce-${this.hceCommands.length + 1}`;
    this.hceCommands.push(requestId);
    this.emit('onHceCommand', {
      requestId,
      commandHex: [...command].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    } satisfies NativeHceCommandEvent);
    return requestId;
  }

  emitPollingFrames(frames: readonly Partial<NativePollingFrame>[]): void {
    this.emit('onPollingFrames', {
      frames: frames.map((frame) => ({
        type: 'a',
        dataHex: '',
        gain: -1,
        timestamp: 0,
        triggeredAutoTransact: false,
        ...frame,
      })),
    } satisfies NativePollingFramesEvent);
  }

  emitHceDeactivated(reason: 'linkLoss' | 'deselected' = 'linkLoss'): void {
    this.emit('onHceDeactivated', { reason } satisfies NativeHceDeactivatedEvent);
  }

  /** What was sent back for a command, or undefined if nothing was. */
  hceResponseTo(requestId: string): Uint8Array | undefined {
    return this.hceResponses.get(requestId);
  }

  emitAvailabilityChanged(supported: boolean, enabled: boolean): void {
    this.emit('onAvailabilityChanged', { supported, enabled } satisfies NativeAvailabilityEvent);
  }

  listenerCount(event: NativeEventName): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Native surface                                                         */
  /* ---------------------------------------------------------------------- */

  addListener<E extends NativeEventName>(
    event: E,
    listener: NativeEventMap[E],
  ): NativeSubscription {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (event: never) => void);

    return {
      remove: () => {
        this.listeners.get(event)?.delete(listener as (event: never) => void);
      },
    };
  }

  private record<T>(method: string, args: readonly unknown[], result: T): Promise<T> {
    this.calls.push({ method, args });

    const rejection = this.rejections.get(method);
    if (rejection !== undefined) {
      return Promise.reject(rejection);
    }
    if (this.pending.has(method)) {
      return new Promise<T>((resolve) => {
        // Settles only when the test says so, so abort, timeout and
        // answer-after-unmount can all be observed.
        this.pending.set(method, () => {
          resolve(result);
        });
      });
    }
    return Promise.resolve(result);
  }

  isSupported(): Promise<boolean> {
    return this.record('isSupported', [], this.supported);
  }

  isEnabled(): Promise<boolean> {
    return this.record('isEnabled', [], this.enabled);
  }

  openSettings(): Promise<void> {
    return this.record('openSettings', [], undefined);
  }

  startSession(sessionId: string, options: NativeSessionOptions): Promise<void> {
    return this.record('startSession', [sessionId, options], undefined);
  }

  closeSession(sessionId: string): Promise<void> {
    return this.record('closeSession', [sessionId], undefined);
  }

  setSessionAlert(sessionId: string, message: string): Promise<void> {
    return this.record('setSessionAlert', [sessionId, message], undefined);
  }

  releaseTag(handleId: string): Promise<void> {
    return this.record('releaseTag', [handleId], undefined);
  }

  readNdef(handleId: string): Promise<Uint8Array> {
    return this.record('readNdef', [handleId], this.ndefBytes);
  }

  writeNdef(handleId: string, message: Uint8Array): Promise<void> {
    return this.record('writeNdef', [handleId, message], undefined);
  }

  getNdefStatus(handleId: string): Promise<NativeNdefStatus> {
    return this.record('getNdefStatus', [handleId], this.ndefStatus);
  }

  makeNdefReadOnly(handleId: string): Promise<void> {
    return this.record('makeNdefReadOnly', [handleId], undefined);
  }

  formatNdef(handleId: string, message: Uint8Array): Promise<void> {
    return this.record('formatNdef', [handleId, message], undefined);
  }

  transceive(handleId: string, tech: string, data: Uint8Array): Promise<Uint8Array> {
    return this.record('transceive', [handleId, tech, data], this.transceiveResponse);
  }

  getMaxTransceiveLength(handleId: string, tech: string): Promise<number> {
    return this.record('getMaxTransceiveLength', [handleId, tech], this.maxTransceiveLength);
  }

  setTechTimeout(handleId: string, tech: string, timeoutMs: number): Promise<void> {
    return this.record('setTechTimeout', [handleId, tech, timeoutMs], undefined);
  }

  getTechTimeout(handleId: string, tech: string): Promise<number> {
    return this.record('getTechTimeout', [handleId, tech], this.techTimeout);
  }

  /* -- Card emulation ---------------------------------------------------- */

  hceSupported = true;
  hceStarted = false;
  observeModeSupported = false;
  observeModeEnabled = false;
  /** Whether the platform will let the caller change observe mode. */
  observeModeAllowed = true;
  hcePreferred = true;
  hceOptions: NativeHceOptions | null = null;
  readonly hceCommands: string[] = [];
  readonly hceResponses = new Map<string, Uint8Array>();
  /** Request ids the fake refuses to answer, standing in for a lost link. */
  readonly hceExpired = new Set<string>();

  isHceSupported(): Promise<boolean> {
    return this.record('isHceSupported', [], this.hceSupported);
  }

  startHce(options: NativeHceOptions): Promise<NativeHceStarted> {
    this.hceStarted = true;
    this.hceOptions = options;
    const preferred = options.preferSelf && this.hcePreferred;
    if (options.observeMode && this.observeModeSupported) {
      this.observeModeEnabled = true;
    }
    return this.record('startHce', [options], {
      preferred,
      observeMode: this.observeModeEnabled,
    } satisfies NativeHceStarted);
  }

  isObserveModeSupported(): Promise<boolean> {
    return this.record('isObserveModeSupported', [], this.observeModeSupported);
  }

  isObserveModeEnabled(): Promise<boolean> {
    return this.record('isObserveModeEnabled', [], this.observeModeEnabled);
  }

  setObserveModeEnabled(enabled: boolean): Promise<boolean> {
    // The platform grants this only to the service it prefers, so refusing is a
    // real outcome and not an error.
    if (this.observeModeAllowed) {
      this.observeModeEnabled = enabled;
    }
    return this.record('setObserveModeEnabled', [enabled], this.observeModeAllowed);
  }

  stopHce(): Promise<void> {
    this.hceStarted = false;
    this.observeModeEnabled = false;
    return this.record('stopHce', [], undefined);
  }

  respondToHce(requestId: string, response: Uint8Array): Promise<boolean> {
    const accepted = !this.hceExpired.has(requestId);
    if (accepted) {
      this.hceResponses.set(requestId, response);
    }
    return this.record('respondToHce', [requestId, response], accepted);
  }

  takeLaunchTag(): Promise<NativeTagInfo | null> {
    const tag = this.launchTag;
    this.launchTag = null;
    return this.record('takeLaunchTag', [], tag);
  }
}
