import { NfcError } from '../../errors.js';
import { createTextRecord, decodeMessage, encodeMessage, toHex } from '../../ndef/index.js';
import type { NativeTagInfo, TagTech } from '../../native/contract.js';
import { FakeNativeModule, fakeTagInfo } from '../../native/__tests__/fakeNative.js';
import { Listeners, type Subscription } from '../subscription.js';
import { createTag, type Tag, type TagRuntime } from '../tag.js';

interface Harness {
  native: FakeNativeModule;
  tag: Tag;
  lost: Listeners<[]>;
  released: { value: boolean };
}

function harness(
  info: Partial<NativeTagInfo> = {},
  platform: 'ios' | 'android' = 'android',
): Harness {
  const native = new FakeNativeModule();
  const lost = new Listeners<[]>();
  const released = { value: false };

  const runtime: TagRuntime = {
    native,
    platform,
    info: fakeTagInfo(info),
    assertUsable: () => {
      if (released.value) {
        throw new NfcError({ code: 'sessionClosed', message: 'Session is closed.', platform });
      }
    },
    isReleased: () => released.value,
    addLostListener: (listener): Subscription => lost.add(listener),
  };

  return { native, tag: createTag(runtime), lost, released };
}

/**
 * Reaches past the type guard, to assert what a JavaScript caller would see.
 *
 * The type system stops these calls; this checks that the runtime stops them too,
 * with an error that explains itself.
 */
function asUntyped(tag: Tag): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return tag as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

describe('tag identity', () => {
  it('exposes the UID as both bytes and hex', () => {
    const { tag } = harness();

    expect(tag.idHex).toBe('04a2b3c4d5e6f0');
    expect(toHex(tag.id!)).toBe('04a2b3c4d5e6f0');
  });

  it('reports a null UID when the platform does not expose one', () => {
    const { tag } = harness({ idHex: null });

    expect(tag.id).toBeNull();
    expect(tag.idHex).toBeNull();
  });

  it('treats an empty hex UID as absent rather than as a zero-length array', () => {
    const { tag } = harness({ idHex: '' });

    expect(tag.id).toBeNull();
    expect(tag.idHex).toBeNull();
  });

  it('keeps only technology names it recognises', () => {
    // A native binary newer than the JavaScript may report a technology this
    // build has no capability for; dropping it is better than surfacing a name
    // no guard can match.
    const { tag } = harness({ techs: ['ndef', 'somethingNewer', 'isoDep'] });

    expect(tag.techs).toEqual(['ndef', 'isoDep']);
  });

  it('reports the platform it came from', () => {
    expect(harness({}, 'ios').tag.platform).toBe('ios');
  });
});

describe('platform facets', () => {
  it('exposes the Android facet and hides the iOS one on Android', () => {
    const { tag } = harness();

    expect(tag.android).toBeDefined();
    expect(tag.ios).toBeUndefined();
    expect(tag.android?.techList).toContain('android.nfc.tech.IsoDep');
    expect(tag.android?.maxTransceiveLength).toBe(253);
    expect(toHex(tag.android!.historicalBytes!)).toBe('8073c021c057');
    expect(tag.android?.hiLayerResponse).toBeNull();
  });

  it('exposes the iOS facet and hides the Android one on iOS', () => {
    const { tag } = harness(
      {
        android: null,
        ios: {
          coreNfcType: 'iso7816',
          historicalBytesHex: '8073c021c057',
          applicationDataHex: null,
          initialSelectedAid: 'A0000002471001',
          idmHex: null,
          systemCodeHex: null,
          icManufacturerCode: 5,
        },
      },
      'ios',
    );

    expect(tag.android).toBeUndefined();
    expect(tag.ios?.coreNfcType).toBe('iso7816');
    expect(tag.ios?.initialSelectedAid).toBe('A0000002471001');
    expect(tag.ios?.icManufacturerCode).toBe(5);
    expect(tag.ios?.applicationData).toBeNull();
  });

  it('routes an Android-only timeout call through the native module', async () => {
    const { native, tag } = harness();

    await tag.android!.setTechTimeout('isoDep', 800);
    expect(native.lastCallTo('setTechTimeout')?.args).toEqual(['handle-1', 'isoDep', 800]);

    await expect(tag.android!.getTechTimeout('isoDep')).resolves.toBe(300);
  });
});

describe('is()', () => {
  it('is true for a supported technology and false otherwise', () => {
    const { tag } = harness();

    expect(tag.is('ndef')).toBe(true);
    expect(tag.is('isoDep')).toBe(true);
    expect(tag.is('mifareClassic')).toBe(false);
  });

  it('is always false for MIFARE Classic on iOS, because CoreNFC cannot reach it', () => {
    // Crypto-1 is not implemented on iOS at any OS version, so the guard closing
    // that branch off is the honest outcome rather than a runtime surprise.
    const { tag } = harness({ techs: ['ndef', 'mifareUltralight'], android: null }, 'ios');

    expect(tag.is('mifareClassic')).toBe(false);
  });

  it('narrows the type, so capability methods become available', () => {
    const { tag } = harness();

    if (tag.is('ndef')) {
      // Compiles only because of the guard.
      expect(typeof tag.readNdef).toBe('function');
      expect(typeof tag.getNdefStatus).toBe('function');
    } else {
      throw new Error('expected an NDEF tag');
    }

    if (tag.is('isoDep')) {
      expect(typeof tag.transceiveApdu).toBe('function');
    } else {
      throw new Error('expected an ISO-DEP tag');
    }
  });
});

describe('type-level guarantees', () => {
  it('rejects capability calls that are not guarded', () => {
    // These assertions are checked by `tsc` during `npm run typecheck`; the
    // runtime body only exists to keep them inside a test file. A regression that
    // widened `Tag` to include capability methods would make the @ts-expect-error
    // comments themselves the failure, which is the intent.
    const check = (tag: Tag): void => {
      // @ts-expect-error readNdef requires narrowing with tag.is('ndef') first
      void tag.readNdef;
      // @ts-expect-error transceive requires narrowing to a transceivable tech
      void tag.transceive;
      // @ts-expect-error transceiveApdu requires narrowing with tag.is('isoDep')
      void tag.transceiveApdu;
      // @ts-expect-error formatNdef requires narrowing with tag.is('ndefFormatable')
      void tag.formatNdef;

      if (tag.is('ndef')) {
        // Available after narrowing.
        void tag.readNdef;
        // @ts-expect-error narrowing to ndef does not bring ISO-DEP methods along
        void tag.transceiveApdu;
      }

      // @ts-expect-error 'mifareDesfire' is not a technology name
      void tag.is('mifareDesfire');
    };

    expect(typeof check).toBe('function');
  });

  it('keeps the technology list assignable to TagTech', () => {
    const { tag } = harness();
    const techs: readonly TagTech[] = tag.techs;
    expect(techs.length).toBeGreaterThan(0);
  });
});

describe('technology guarding at runtime', () => {
  it('rejects an unsupported technology with a message naming what is available', async () => {
    // TypeScript prevents this, but a JavaScript caller can still get here, and
    // the error should say what to do rather than fail somewhere in native.
    const { tag } = harness({ techs: ['ndef'] });

    await expect(asUntyped(tag).transceiveApdu!(new Uint8Array([0x00]))).rejects.toMatchObject({
      code: 'techUnavailable',
    });

    await asUntyped(tag).transceiveApdu!(new Uint8Array([0x00])).catch((error: NfcError) => {
      expect(error.message).toContain('"isoDep"');
      expect(error.message).toContain('Available: ndef');
      expect(error.message).toContain("tag.is('isoDep')");
    });
  });

  it('says "none" when the tag supports nothing this build knows about', async () => {
    const { tag } = harness({ techs: [] });

    await asUntyped(tag).readNdef!().catch((error: NfcError) => {
      expect(error.code).toBe('techUnavailable');
      expect(error.message).toContain('Available: none');
    });
  });

  it('rejects every operation once the session is closed', async () => {
    const { tag, released } = harness();
    released.value = true;

    expect(tag.released).toBe(true);
    await expect(asUntyped(tag).readNdef!()).rejects.toMatchObject({ code: 'sessionClosed' });
  });
});

describe('NDEF operations', () => {
  it("decodes what native returns using this library's own codec", async () => {
    const { native, tag } = harness();
    native.ndefBytes = encodeMessage([createTextRecord('hola', { languageCode: 'es' })]);

    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    const records = await tag.readNdef();
    expect(records).toHaveLength(1);
    expect(native.lastCallTo('readNdef')?.args).toEqual(['handle-1']);
  });

  it('surfaces the raw bytes as an escape hatch', async () => {
    const { native, tag } = harness();
    // A message this library's decoder rejects: no Message End flag.
    native.ndefBytes = new Uint8Array([0x91, 0x01, 0x01, 0x54, 0x41]);

    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    await expect(tag.readNdef()).rejects.toMatchObject({ code: 'ndefMalformed' });
    await expect(tag.readNdefBytes()).resolves.toHaveLength(5);
  });

  it('encodes before writing, and sends bytes native can hand straight to the tag', async () => {
    const { native, tag } = harness();
    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    await tag.writeNdef([createTextRecord('hi')]);

    const sent = native.lastCallTo('writeNdef')?.args[1] as Uint8Array;
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(decodeMessage(sent)).toHaveLength(1);
  });

  it('writes the canonical empty message for an empty array, which is how a tag is erased', async () => {
    const { native, tag } = harness();
    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    await tag.writeNdef([]);
    expect(Array.from(native.lastCallTo('writeNdef')?.args[1] as Uint8Array)).toEqual([
      0xd0, 0x00, 0x00,
    ]);
  });

  it('passes bytes through untouched when the caller encoded them', async () => {
    const { native, tag } = harness();
    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    const bytes = new Uint8Array([1, 2, 3]);
    await tag.writeNdefBytes(bytes);
    expect(native.lastCallTo('writeNdef')?.args[1]).toBe(bytes);
  });

  it('returns the NDEF status verbatim', async () => {
    const { tag } = harness();
    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    await expect(tag.getNdefStatus()).resolves.toEqual({
      writable: true,
      capacity: 137,
      canMakeReadOnly: true,
      typeName: 'NFC Forum Type 2',
    });
  });

  it('locks the tag through the native module', async () => {
    const { native, tag } = harness();
    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    await tag.makeReadOnly();
    expect(native.callsTo('makeNdefReadOnly')).toHaveLength(1);
  });

  it('formats a blank tag with an initial message', async () => {
    const { native, tag } = harness({ techs: ['ndefFormatable'] });
    if (!tag.is('ndefFormatable')) {
      throw new Error('expected a formatable tag');
    }

    await tag.formatNdef([createTextRecord('new')]);
    expect(native.lastCallTo('formatNdef')?.args[1]).toBeInstanceOf(Uint8Array);
  });
});

describe('transceive', () => {
  it('prefers ISO-DEP over raw NFC-A framing when the tag offers both', async () => {
    const { native, tag } = harness({ techs: ['isoDep', 'nfcA'] });
    if (!tag.is('isoDep')) {
      throw new Error('expected an ISO-DEP tag');
    }

    await tag.transceive(new Uint8Array([0x00, 0xa4]));
    expect(native.lastCallTo('transceive')?.args[1]).toBe('isoDep');
  });

  it('falls back to raw NFC-A when that is all the tag offers', async () => {
    const { native, tag } = harness({ techs: ['nfcA'] });
    if (!tag.is('nfcA')) {
      throw new Error('expected an NFC-A tag');
    }

    await tag.transceive(new Uint8Array([0x30, 0x00]));
    expect(native.lastCallTo('transceive')?.args[1]).toBe('nfcA');
  });

  it('reports the maximum exchange length', async () => {
    const { native, tag } = harness();
    if (!tag.is('isoDep')) {
      throw new Error('expected an ISO-DEP tag');
    }

    await expect(tag.maxTransceiveLength()).resolves.toBe(253);
    expect(native.lastCallTo('getMaxTransceiveLength')?.args[1]).toBe('isoDep');
  });
});

describe('transceiveApdu', () => {
  it('splits the status word off the response', async () => {
    const { native, tag } = harness();
    native.transceiveResponse = new Uint8Array([0x6f, 0x0a, 0x84, 0x90, 0x00]);

    if (!tag.is('isoDep')) {
      throw new Error('expected an ISO-DEP tag');
    }

    const response = await tag.transceiveApdu(new Uint8Array([0x00, 0xa4, 0x04, 0x00]));

    expect(Array.from(response.data)).toEqual([0x6f, 0x0a, 0x84]);
    expect(response.sw1).toBe(0x90);
    expect(response.sw2).toBe(0x00);
    expect(response.status).toBe(0x9000);
    expect(response.statusHex).toBe('9000');
    expect(response.ok).toBe(true);
  });

  it('reports a non-9000 status without treating it as a transport failure', async () => {
    // 6A82 "file not found" is a perfectly successful exchange that says no.
    const { native, tag } = harness();
    native.transceiveResponse = new Uint8Array([0x6a, 0x82]);

    if (!tag.is('isoDep')) {
      throw new Error('expected an ISO-DEP tag');
    }

    const response = await tag.transceiveApdu(new Uint8Array([0x00, 0xa4]));

    expect(response.data).toHaveLength(0);
    expect(response.statusHex).toBe('6a82');
    expect(response.ok).toBe(false);
  });

  it('pads a short status word to four hex digits', async () => {
    const { native, tag } = harness();
    native.transceiveResponse = new Uint8Array([0x00, 0x00]);

    if (!tag.is('isoDep')) {
      throw new Error('expected an ISO-DEP tag');
    }

    expect((await tag.transceiveApdu(new Uint8Array([0x00]))).statusHex).toBe('0000');
  });

  it('rejects a response too short to contain a status word', async () => {
    const { native, tag } = harness();
    native.transceiveResponse = new Uint8Array([0x90]);

    if (!tag.is('isoDep')) {
      throw new Error('expected an ISO-DEP tag');
    }

    await expect(tag.transceiveApdu(new Uint8Array([0x00]))).rejects.toMatchObject({
      code: 'transceiveFailed',
    });
  });

  it('has the same response shape on both platforms', async () => {
    // The library being replaced returned [...bytes, sw1, sw2] on iOS and raw
    // bytes on Android for this same call, with a TODO admitting it.
    const response = new Uint8Array([0xaa, 0x90, 0x00]);

    for (const platform of ['ios', 'android'] as const) {
      const { native, tag } = harness({ android: null }, platform);
      native.transceiveResponse = response;

      if (!tag.is('isoDep')) {
        throw new Error('expected an ISO-DEP tag');
      }

      const parsed = await tag.transceiveApdu(new Uint8Array([0x00]));
      expect(Array.from(parsed.data)).toEqual([0xaa]);
      expect(parsed.statusHex).toBe('9000');
    }
  });
});

describe('error mapping', () => {
  it('turns a coded native rejection into an NfcError with that code', async () => {
    const { native, tag } = harness();
    native.rejectWith('readNdef', {
      code: 'tagLost',
      message: 'Tag was lost',
      nativeCode: 'android.nfc.TagLostException',
    });

    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    await tag.readNdef().catch((error: NfcError) => {
      expect(NfcError.is(error, 'tagLost')).toBe(true);
      expect(error.nativeCode).toBe('android.nfc.TagLostException');
      expect(error.platform).toBe('android');
      expect(error.recoverable).toBe(true);
    });
  });

  it('does not guess when native reports a code it does not know', async () => {
    const { native, tag } = harness();
    native.rejectWith('readNdef', { code: 'somethingFromTheFuture', message: 'boom' });

    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    await tag.readNdef().catch((error: NfcError) => {
      expect(error.code).toBe('internalError');
      expect(error.nativeCode).toBe('somethingFromTheFuture');
      expect(error.message).toContain('newer than the JavaScript bundle');
    });
  });

  it('wraps a bare rejection that carries no code at all', async () => {
    const { native, tag } = harness();
    native.rejectWith('getNdefStatus', new Error('kaboom'));

    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    await tag.getNdefStatus().catch((error: NfcError) => {
      expect(NfcError.is(error)).toBe(true);
      expect(error.code).toBe('internalError');
      expect(error.message).toBe('kaboom');
    });
  });
});

describe('cancellation', () => {
  it('rejects with aborted when the signal fires mid-operation', async () => {
    const { native, tag } = harness();
    native.hangOn('readNdef');

    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    const controller = new AbortController();
    const pending = tag.readNdef({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { native, tag } = harness();
    if (!tag.is('ndef')) {
      throw new Error('expected an NDEF tag');
    }

    const controller = new AbortController();
    controller.abort();

    await expect(tag.readNdef({ signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    // The native call is never made at all.
    expect(native.callsTo('readNdef')).toHaveLength(0);
  });

  it('rejects with timeout when the deadline passes', async () => {
    jest.useFakeTimers();
    try {
      const { native, tag } = harness();
      native.hangOn('readNdef');

      if (!tag.is('ndef')) {
        throw new Error('expected an NDEF tag');
      }

      const pending = tag.readNdef({ timeoutMs: 500 });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      jest.advanceTimersByTime(500);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('onLost', () => {
  it("forwards the session's tag-lost notification", () => {
    const { tag, lost } = harness();
    const listener = jest.fn();

    const subscription = tag.onLost(listener);
    lost.emit();
    expect(listener).toHaveBeenCalledTimes(1);

    subscription.remove();
    lost.emit();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('supports several listeners, unlike a single-slot callback', () => {
    const { tag, lost } = harness();
    const first = jest.fn();
    const second = jest.fn();

    tag.onLost(first);
    tag.onLost(second);
    lost.emit();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
