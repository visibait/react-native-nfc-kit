/**
 * The tag type.
 *
 * This is the design decision the rest of the API hangs off. A `Tag` carries no
 * technology-specific methods at all; you narrow it with a guard first:
 *
 * ```ts
 * if (tag.is('isoDep')) {
 *   const response = await tag.transceive(selectAid);  // only exists here
 * }
 * ```
 *
 * Calling `tag.transceive()` without the guard is a compile error, and on iOS
 * `tag.is('mifareClassic')` is simply always false because CoreNFC cannot reach
 * Crypto-1 at all. So the platform asymmetry -- MIFARE Classic missing on iOS, raw
 * NfcA/NfcB transceive missing on iOS, tag removal callbacks Android-only -- is
 * visible in the type system instead of surfacing as an `undefined` method at
 * runtime on one platform only.
 *
 * The alternative, which the library being replaced took, is one flat interface
 * merging both platforms with `/** iOS only *\/` comments, plus silent no-op stubs
 * on the wrong platform. That type-checks everywhere and works nowhere in
 * particular.
 *
 * Anything genuinely platform-specific lives under `tag.android` or `tag.ios`,
 * which are `undefined` on the other platform, so it cannot be reached blindly.
 */

import { NfcError, type NfcPlatform } from '../errors.js';
import { decodeMessage, encodeMessage, type NdefMessage } from '../ndef/index.js';
import { fromHex } from '../ndef/bytes.js';
import type { NativeNfcKitModule, NativeTagInfo, TagTech } from '../native/contract.js';
import { isTagTech } from '../native/contract.js';
import { callNative } from '../native/errors.js';
import { runWithDeadline, type Deadline } from './async.js';
import type { Subscription } from './subscription.js';

/** Per-operation cancellation and timeout. Accepted by every awaitable. */
export type TagOperationOptions = Deadline;

/* -------------------------------------------------------------------------- */
/* Capabilities                                                               */
/* -------------------------------------------------------------------------- */

export interface NdefStatus {
  readonly writable: boolean;
  /** Usable capacity in bytes for the NDEF message. */
  readonly capacity: number;
  readonly canMakeReadOnly: boolean;
  /** NFC Forum type name when the platform reports one. */
  readonly typeName: string | null;
}

export interface NdefCapability {
  /**
   * Reads and decodes the NDEF message.
   *
   * Decoding happens in TypeScript, from the raw bytes, using the same codec on
   * both platforms. That is deliberate: chunk reassembly, UTF-16 text records and
   * malformed-input handling then behave identically everywhere, rather than
   * inheriting whatever each platform's own NDEF parser happens to do.
   */
  readNdef(options?: TagOperationOptions): Promise<NdefMessage>;

  /**
   * The raw message bytes, undecoded.
   *
   * The escape hatch for a tag this library's decoder rejects: you still get the
   * bytes and can decide what to do with them.
   */
  readNdefBytes(options?: TagOperationOptions): Promise<Uint8Array>;

  /**
   * Encodes and writes an NDEF message.
   *
   * A message larger than the tag's capacity rejects with `ndefCapacityExceeded`
   * before anything is written, so a tag is never left half-updated. An empty
   * array writes the canonical empty message, which is how you erase a tag.
   */
  writeNdef(records: NdefMessage, options?: TagOperationOptions): Promise<void>;

  /** Writes bytes you encoded yourself. */
  writeNdefBytes(bytes: Uint8Array, options?: TagOperationOptions): Promise<void>;

  getNdefStatus(options?: TagOperationOptions): Promise<NdefStatus>;

  /**
   * Locks the tag read-only. Irreversible.
   *
   * Rejects `ndefNotSupported` when the tag cannot be locked; check
   * `getNdefStatus().canMakeReadOnly` first if you want to ask rather than try.
   */
  makeReadOnly(options?: TagOperationOptions): Promise<void>;
}

export interface NdefFormatableCapability {
  /** Formats a blank tag for NDEF and writes an initial message. */
  formatNdef(records: NdefMessage, options?: TagOperationOptions): Promise<void>;
}

/** Raw exchange, for technologies without a higher-level protocol layer yet. */
export interface TransceiveCapability {
  transceive(data: Uint8Array, options?: TagOperationOptions): Promise<Uint8Array>;
  /** Largest single exchange this tag accepts, in bytes. */
  maxTransceiveLength(options?: TagOperationOptions): Promise<number>;
}

/** Status word pair from an ISO 7816 exchange. */
export interface ApduResponse {
  /** Response body, with the status word removed. */
  readonly data: Uint8Array;
  readonly sw1: number;
  readonly sw2: number;
  /** `sw1 << 8 | sw2`, e.g. `0x9000`. */
  readonly status: number;
  /** The status word as four lowercase hex digits, e.g. `9000`. */
  readonly statusHex: string;
  /** Whether the status word is exactly `9000`. */
  readonly ok: boolean;
}

export interface IsoDepCapability extends TransceiveCapability {
  /**
   * Sends an APDU and splits the status word off the response.
   *
   * The shape is identical on both platforms. In the library being replaced this
   * same call returned `[...bytes, sw1, sw2]` on iOS and the raw bytes on Android,
   * with a `// TODO: make following data the same format as Android` admitting it.
   */
  transceiveApdu(apdu: Uint8Array, options?: TagOperationOptions): Promise<ApduResponse>;
}

/**
 * Which capabilities each technology brings.
 *
 * Higher-level protocol helpers -- typed ISO 15693 commands, MIFARE Classic sector
 * authentication, NTAG password auth -- land in M4 as pure TypeScript on top of
 * `transceive`, so they are testable without hardware.
 */
export interface TagCapabilities {
  ndef: NdefCapability;
  ndefFormatable: NdefFormatableCapability;
  isoDep: IsoDepCapability;
  iso15693: TransceiveCapability;
  felica: TransceiveCapability;
  mifareUltralight: TransceiveCapability;
  mifareClassic: TransceiveCapability;
  nfcA: TransceiveCapability;
  nfcB: TransceiveCapability;
  nfcBarcode: TransceiveCapability;
}

/* -------------------------------------------------------------------------- */
/* Platform facets                                                            */
/* -------------------------------------------------------------------------- */

/** Android-specific metadata and operations. `undefined` on iOS. */
export interface AndroidTagFacet {
  /** Raw `Tag.getTechList()` entries, useful in a bug report. */
  readonly techList: readonly string[];
  readonly maxTransceiveLength: number | null;
  readonly historicalBytes: Uint8Array | null;
  readonly hiLayerResponse: Uint8Array | null;

  /**
   * Sets the per-technology I/O timeout.
   *
   * Worth raising for long crypto sequences: DESFire authentication and
   * GlobalPlatform key derivation both routinely exceed the default.
   */
  setTechTimeout(tech: TagTech, timeoutMs: number, options?: TagOperationOptions): Promise<void>;
  getTechTimeout(tech: TagTech, options?: TagOperationOptions): Promise<number>;
}

/** iOS-specific metadata. `undefined` on Android. */
export interface IosTagFacet {
  /** Which CoreNFC tag case this arrived as, e.g. `iso7816` or `miFare`. */
  readonly coreNfcType: string;
  readonly historicalBytes: Uint8Array | null;
  readonly applicationData: Uint8Array | null;
  /**
   * The AID CoreNFC selected.
   *
   * Note that including `D2760000850101` in the entitlement AID list makes a
   * DESFire tag arrive as ISO 7816 rather than MIFARE; omit it to get the latter.
   */
  readonly initialSelectedAid: string | null;
  /** FeliCa manufacture id. */
  readonly idm: Uint8Array | null;
  /** FeliCa system code. */
  readonly systemCode: Uint8Array | null;
  readonly icManufacturerCode: number | null;
}

/* -------------------------------------------------------------------------- */
/* The tag                                                                    */
/* -------------------------------------------------------------------------- */

export interface TagBase {
  /** UID, or `null` when the platform does not expose one. */
  readonly id: Uint8Array | null;
  /** UID as lowercase hex, or `null`. Convenience for logging and comparison. */
  readonly idHex: string | null;
  /** Technologies this tag actually supports, here, on this platform. */
  readonly techs: readonly TagTech[];
  readonly platform: NfcPlatform;
  readonly android: AndroidTagFacet | undefined;
  readonly ios: IosTagFacet | undefined;
  /** Whether the tag is gone: released, lost, or its session closed. */
  readonly released: boolean;

  /**
   * Narrows the tag to a technology's capabilities.
   *
   * ```ts
   * if (tag.is('ndef')) {
   *   const message = await tag.readNdef();
   * }
   * ```
   */
  is<T extends TagTech>(tech: T): this is this & TagCapabilities[T];

  /**
   * Called when the tag leaves the field.
   *
   * Android API 37 and later deliver this from the platform; below that it is
   * polled, so the latency differs. `capabilities.nativeTagLost` says which.
   * iOS does not report tag removal at all, so this never fires there.
   */
  onLost(listener: () => void): Subscription;
}

/** A discovered tag before narrowing. Deliberately carries no tech methods. */
export type Tag = TagBase;

/** A tag narrowed to one technology. */
export type TagWith<T extends TagTech> = TagBase & TagCapabilities[T];

/* -------------------------------------------------------------------------- */
/* Construction                                                              */
/* -------------------------------------------------------------------------- */

/** What the session gives a tag so it can do its work. */
export interface TagRuntime {
  readonly native: NativeNfcKitModule;
  readonly platform: NfcPlatform;
  readonly info: NativeTagInfo;
  /** Throws `sessionClosed` when the tag can no longer be used. */
  assertUsable(): void;
  isReleased(): boolean;
  addLostListener(listener: () => void): Subscription;
}

function hexToBytesOrNull(hex: string | null): Uint8Array | null {
  return hex === null || hex.length === 0 ? null : fromHex(hex);
}

const APDU_STATUS_OK = 0x9000;

/**
 * Builds the tag object.
 *
 * Every capability method is present on the object regardless of the tag's
 * technologies, and each one checks membership first. The type guard is what
 * prevents the mistake at compile time; this check is what turns it into a clear
 * `techUnavailable` error rather than a confusing native failure for callers who
 * are not using TypeScript.
 */
export function createTag(runtime: TagRuntime): Tag {
  const { native, platform, info } = runtime;
  const techs: readonly TagTech[] = info.techs.filter(isTagTech);
  const techSet = new Set<string>(techs);

  function assertTech(tech: TagTech, operation: string): void {
    runtime.assertUsable();
    if (!techSet.has(tech)) {
      throw new NfcError({
        code: 'techUnavailable',
        message:
          `${operation} requires the "${tech}" technology, which this tag does not support ` +
          `on ${platform}. Available: ${techs.length === 0 ? 'none' : techs.join(', ')}. ` +
          `Guard with tag.is('${tech}') before calling it.`,
        platform,
      });
    }
  }

  /** Runs a native call with the tech check, deadline and error mapping applied. */
  function op<T>(
    tech: TagTech,
    operation: string,
    options: TagOperationOptions | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      assertTech(tech, operation);
    } catch (error) {
      return Promise.reject(error);
    }
    // runWithDeadline, not withDeadline: an operation whose signal already fired
    // must not reach the tag at all.
    return runWithDeadline(() => callNative(platform, operation, run), options ?? {}, operation);
  }

  const android: AndroidTagFacet | undefined =
    info.android === null
      ? undefined
      : {
          techList: info.android.techList,
          maxTransceiveLength: info.android.maxTransceiveLength,
          historicalBytes: hexToBytesOrNull(info.android.historicalBytesHex),
          hiLayerResponse: hexToBytesOrNull(info.android.hiLayerResponseHex),
          setTechTimeout: (tech, timeoutMs, options) =>
            op(tech, 'setTechTimeout', options, () =>
              native.setTechTimeout(info.handleId, tech, timeoutMs),
            ),
          getTechTimeout: (tech, options) =>
            op(tech, 'getTechTimeout', options, () => native.getTechTimeout(info.handleId, tech)),
        };

  const ios: IosTagFacet | undefined =
    info.ios === null
      ? undefined
      : {
          coreNfcType: info.ios.coreNfcType,
          historicalBytes: hexToBytesOrNull(info.ios.historicalBytesHex),
          applicationData: hexToBytesOrNull(info.ios.applicationDataHex),
          initialSelectedAid: info.ios.initialSelectedAid,
          idm: hexToBytesOrNull(info.ios.idmHex),
          systemCode: hexToBytesOrNull(info.ios.systemCodeHex),
          icManufacturerCode: info.ios.icManufacturerCode,
        };

  const impl = {
    id: hexToBytesOrNull(info.idHex),
    idHex: info.idHex === null || info.idHex.length === 0 ? null : info.idHex,
    techs,
    platform,
    android,
    ios,

    get released(): boolean {
      return runtime.isReleased();
    },

    is<T extends TagTech>(tech: T): boolean {
      return techSet.has(tech);
    },

    onLost(listener: () => void): Subscription {
      return runtime.addLostListener(listener);
    },

    // ── NDEF ────────────────────────────────────────────────────────────────
    readNdefBytes(options?: TagOperationOptions): Promise<Uint8Array> {
      return op('ndef', 'readNdef', options, () => native.readNdef(info.handleId));
    },

    async readNdef(options?: TagOperationOptions): Promise<NdefMessage> {
      return decodeMessage(await this.readNdefBytes(options));
    },

    writeNdefBytes(bytes: Uint8Array, options?: TagOperationOptions): Promise<void> {
      return op('ndef', 'writeNdef', options, () => native.writeNdef(info.handleId, bytes));
    },

    writeNdef(records: NdefMessage, options?: TagOperationOptions): Promise<void> {
      return this.writeNdefBytes(encodeMessage(records), options);
    },

    getNdefStatus(options?: TagOperationOptions): Promise<NdefStatus> {
      return op('ndef', 'getNdefStatus', options, () => native.getNdefStatus(info.handleId));
    },

    makeReadOnly(options?: TagOperationOptions): Promise<void> {
      return op('ndef', 'makeReadOnly', options, () => native.makeNdefReadOnly(info.handleId));
    },

    formatNdef(records: NdefMessage, options?: TagOperationOptions): Promise<void> {
      return op('ndefFormatable', 'formatNdef', options, () =>
        native.formatNdef(info.handleId, encodeMessage(records)),
      );
    },

    // ── Raw exchange ────────────────────────────────────────────────────────
    transceive(data: Uint8Array, options?: TagOperationOptions): Promise<Uint8Array> {
      const tech = pickTransceiveTech(techs);
      return op(tech, 'transceive', options, () => native.transceive(info.handleId, tech, data));
    },

    maxTransceiveLength(options?: TagOperationOptions): Promise<number> {
      const tech = pickTransceiveTech(techs);
      return op(tech, 'maxTransceiveLength', options, () =>
        native.getMaxTransceiveLength(info.handleId, tech),
      );
    },

    async transceiveApdu(apdu: Uint8Array, options?: TagOperationOptions): Promise<ApduResponse> {
      const raw = await op('isoDep', 'transceiveApdu', options, () =>
        native.transceive(info.handleId, 'isoDep', apdu),
      );

      if (raw.length < 2) {
        throw new NfcError({
          code: 'transceiveFailed',
          message: `APDU response is ${raw.length} byte(s); a status word needs at least 2.`,
          platform,
        });
      }

      const sw1 = raw[raw.length - 2] as number;
      const sw2 = raw[raw.length - 1] as number;
      const status = (sw1 << 8) | sw2;

      return {
        data: raw.subarray(0, raw.length - 2),
        sw1,
        sw2,
        status,
        statusHex: status.toString(16).padStart(4, '0'),
        ok: status === APDU_STATUS_OK,
      };
    },
  };

  // The returned object carries every capability method, while `Tag` declares
  // none of them -- that gap is the entire point of the design. Bridging it needs
  // one assertion, because a method returning `boolean` cannot be assigned to one
  // declared as a type predicate.
  //
  // The two checks below are what keep that assertion honest. They are erased at
  // build time and cost nothing at runtime, but they fail compilation if a
  // capability method is missing, misnamed or has the wrong signature -- which is
  // exactly what the assertion would otherwise hide.
  const _implementsEveryCapability: NdefCapability & NdefFormatableCapability & IsoDepCapability =
    impl;
  const _implementsTagBase: Omit<TagBase, 'is'> = impl;
  void _implementsEveryCapability;
  void _implementsTagBase;

  return impl as unknown as Tag;
}

/**
 * Chooses which technology a bare `transceive` should go through.
 *
 * A tag typically exposes several, and the ordering here is from most specific to
 * least: a tag that speaks ISO-DEP should use it rather than dropping to raw
 * NFC-A framing. Callers who need a specific one narrow first and use that
 * technology's own methods.
 */
const TRANSCEIVE_PREFERENCE: readonly TagTech[] = [
  'isoDep',
  'iso15693',
  'felica',
  'mifareClassic',
  'mifareUltralight',
  'nfcA',
  'nfcB',
  'nfcBarcode',
];

function pickTransceiveTech(techs: readonly TagTech[]): TagTech {
  for (const candidate of TRANSCEIVE_PREFERENCE) {
    if (techs.includes(candidate)) {
      return candidate;
    }
  }
  // Nothing transceivable: return the first preference so the tech check in `op`
  // produces the error naming what is missing, rather than throwing from here
  // with less context.
  return 'isoDep';
}
