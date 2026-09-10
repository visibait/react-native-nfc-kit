import { createTextRecord, createUriRecord, decodeMessage } from '../../ndef/index.js';
import { encodeMessage } from '../../ndef/message.js';
import { NfcError } from '../../errors.js';
import type { NativeNfcKitModule, NativeTagDiscoveredEvent } from '../contract.js';
import {
  getNativeModule,
  isNativePlatform,
  platform,
  resetWebModuleForTests,
  setNativeModuleForTests,
  tryGetNativeModule,
} from '../module.web.js';

/**
 * A stand-in for the browser's `NDEFReader`.
 *
 * Written against what Web NFC actually hands over rather than what would be
 * convenient: records already interpreted, `data` as a `DataView`, and a serial
 * number with colons in it, which is how Chrome reports it.
 */
class FakeReader {
  static instances: FakeReader[] = [];

  onreading: ((event: unknown) => void) | null = null;
  onreadingerror: ((event: Event) => void) | null = null;

  scanCalls = 0;
  written: unknown[] = [];
  lockCalls = 0;
  scanRejection: Error | null = null;
  writeRejection: Error | null = null;
  makeReadOnly?: (() => Promise<void>) | undefined;

  constructor() {
    FakeReader.instances.push(this);
    this.makeReadOnly = async () => {
      this.lockCalls += 1;
    };
  }

  async scan(): Promise<void> {
    this.scanCalls += 1;
    if (this.scanRejection) {
      throw this.scanRejection;
    }
  }

  async write(message: unknown): Promise<void> {
    if (this.writeRejection) {
      throw this.writeRejection;
    }
    this.written.push(message);
  }

  /** Delivers a tag the way the browser does. */
  deliver(records: unknown[], serialNumber = '04:a2:b3:c4'): void {
    this.onreading?.({ serialNumber, message: { records } });
  }
}

function textRecord(value: string): unknown {
  const bytes = new TextEncoder().encode(value);
  return {
    recordType: 'text',
    lang: 'en',
    data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  };
}

/**
 * Installs the fake for the duration of the test.
 *
 * Async on purpose: a synchronous version removes the global the moment the body
 * suspends, so every await inside would run without it. That mistake makes the
 * tests fail in a way that looks like the module is broken.
 */
async function withReader(run: () => Promise<void>): Promise<void> {
  (globalThis as { NDEFReader?: unknown }).NDEFReader = FakeReader;
  try {
    await run();
  } finally {
    delete (globalThis as { NDEFReader?: unknown }).NDEFReader;
  }
}

let module: NativeNfcKitModule;

beforeEach(() => {
  FakeReader.instances = [];
  // A fresh instance per test: one per page is right in production, and that
  // means it would otherwise carry an open scan from the previous test.
  resetWebModuleForTests();
  module = getNativeModule();
});

afterEach(() => {
  delete (globalThis as { NDEFReader?: unknown }).NDEFReader;
});

describe('the web boundary', () => {
  it('reports itself as web, and as not native', () => {
    expect(platform).toBe('web');
    expect(isNativePlatform).toBe(false);
  });

  it('always resolves a module, unlike the native boundary', () => {
    // A browser without Web NFC still gets a module: it answers `isSupported`
    // false, which is what a page needs in order to hide its NFC affordance.
    expect(tryGetNativeModule()).not.toBeNull();
  });

  it('can be replaced for a test', () => {
    const fake = {} as NativeNfcKitModule;
    setNativeModuleForTests(fake);

    expect(tryGetNativeModule()).toBe(fake);
    resetWebModuleForTests();
  });

  it('claims only NDEF, and nothing it cannot do', () => {
    // Every other guard being honestly false is what makes tag.is('isoDep')
    // false rather than a method that exists and then throws.
    expect(module.capabilities.techs).toEqual(['ndef']);
    expect(module.capabilities.hce).toBe(false);
    expect(module.capabilities.tagLost).toBe('none');
    expect(module.capabilities.backgroundReading).toBe(false);
  });
});

describe('availability', () => {
  it('reports unsupported when the browser has no Web NFC', async () => {
    await expect(module.isSupported()).resolves.toBe(false);
    await expect(module.isEnabled()).resolves.toBe(false);
  });

  it('reports supported when it does', async () => {
    await withReader(async () => {
      await expect(module.isSupported()).resolves.toBe(true);
    });
  });

  it('refuses to open settings, which a page cannot do', async () => {
    await expect(module.openSettings()).rejects.toMatchObject({ code: 'unsupportedPlatform' });
  });
});

describe('scanning', () => {
  it('explains itself when the browser has no Web NFC', async () => {
    await expect(module.startSession('s1', options())).rejects.toMatchObject({
      code: 'nfcUnsupported',
    });
  });

  it('starts a scan and reports a tag', async () => {
    await withReader(async () => {
      const seen: NativeTagDiscoveredEvent[] = [];
      module.addListener('onTagDiscovered', (event) => seen.push(event));

      await module.startSession('s1', options());
      FakeReader.instances[0]?.deliver([textRecord('hola')]);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.tag.techs).toEqual(['ndef']);
      // Chrome reports the serial with colons; the rest of this library speaks
      // plain lowercase hex.
      expect(seen[0]?.tag.idHex).toBe('04a2b3c4');
    });
  });

  it('refuses a technology a browser cannot reach, naming it', async () => {
    await withReader(async () => {
      await expect(module.startSession('s1', options(['isoDep']))).rejects.toMatchObject({
        code: 'unsupportedPlatform',
      });
    });
  });

  it('refuses a second scan rather than replacing the first', async () => {
    await withReader(async () => {
      await module.startSession('s1', options());

      await expect(module.startSession('s2', options())).rejects.toMatchObject({
        code: 'systemBusy',
      });
    });
  });

  it('turns a declined permission into notAuthorized', async () => {
    // Web NFC reports this as a DOMException name and nothing NFC-specific, so
    // this mapping is the only place "the user said no" survives.
    await withReader(async () => {
      (globalThis as { NDEFReader?: unknown }).NDEFReader = class {
        onreading = null;
        onreadingerror = null;
        async scan(): Promise<void> {
          throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        }
        async write(): Promise<void> {}
      };

      await expect(module.startSession('s1', options())).rejects.toMatchObject({
        code: 'notAuthorized',
      });
    });
  });

  it('reports an unreadable tag rather than going quiet', async () => {
    await withReader(async () => {
      const invalidations: unknown[] = [];
      module.addListener('onSessionInvalidated', (event) => invalidations.push(event));

      await module.startSession('s1', options());
      FakeReader.instances[0]?.onreadingerror?.(new Event('readingerror'));

      expect(invalidations).toHaveLength(1);
    });
  });

  it('closes a scan, and does not mind being closed twice', async () => {
    await withReader(async () => {
      await module.startSession('s1', options());

      await module.closeSession('s1');
      await expect(module.closeSession('s1')).resolves.toBeUndefined();
      // A session id that was never open is also not an error: JavaScript closes
      // in a finally block, which can run after the scan already ended.
      await expect(module.closeSession('other')).resolves.toBeUndefined();
    });
  });

  it('has no sheet to update, and does not pretend otherwise', async () => {
    await expect(module.setSessionAlert('s1', 'hi')).resolves.toBeUndefined();
  });
});

describe('reading and writing NDEF', () => {
  async function scanned(): Promise<{ handleId: string; reader: FakeReader }> {
    let handleId = '';
    module.addListener('onTagDiscovered', (event) => {
      handleId = event.tag.handleId;
    });
    await module.startSession('s1', options());
    const reader = FakeReader.instances[0] as FakeReader;
    reader.deliver([textRecord('hola')]);
    return { handleId, reader };
  }

  it('re-encodes what the browser already read', async () => {
    await withReader(async () => {
      const { handleId } = await scanned();

      // The browser hands over interpreted records, so this rebuilds the message
      // rather than going back to the radio, which Web NFC gives no way to do.
      const message = decodeMessage(await module.readNdef(handleId));
      expect(message).toHaveLength(1);
    });
  });

  it('rejects a handle whose scan has ended', async () => {
    await withReader(async () => {
      const { handleId } = await scanned();
      await module.closeSession('s1');

      await expect(module.readNdef(handleId)).rejects.toMatchObject({ code: 'sessionClosed' });
    });
  });

  it('forgets a released tag', async () => {
    await withReader(async () => {
      const { handleId } = await scanned();
      await module.releaseTag(handleId);

      await expect(module.readNdef(handleId)).rejects.toMatchObject({ code: 'sessionClosed' });
    });
  });

  it('writes records the browser understands', async () => {
    await withReader(async () => {
      const { handleId, reader } = await scanned();

      await module.writeNdef(
        handleId,
        encodeMessage([createUriRecord('https://ventry.es'), createTextRecord('hi')]),
      );

      expect(reader.written).toHaveLength(1);
      const written = reader.written[0] as { records: { recordType: string }[] };
      expect(written.records.map((record) => record.recordType)).toEqual(['url', 'text']);
    });
  });

  it('turns a write failure into a coded error', async () => {
    await withReader(async () => {
      const { handleId, reader } = await scanned();
      reader.writeRejection = Object.assign(new Error('gone'), { name: 'NetworkError' });

      await expect(module.writeNdef(handleId, encodeMessage([]))).rejects.toMatchObject({
        code: 'tagLost',
      });
    });
  });

  it('refuses to guess whether a tag is writable, or how large it is', async () => {
    // Inventing those numbers would only move the failure to the write, where it
    // would be reported as something else entirely.
    await expect(module.getNdefStatus('h')).rejects.toMatchObject({
      code: 'unsupportedPlatform',
    });
  });

  it('locks a tag when the browser can', async () => {
    await withReader(async () => {
      const { handleId, reader } = await scanned();

      await module.makeNdefReadOnly(handleId);

      expect(reader.lockCalls).toBe(1);
    });
  });

  it('says so when the browser cannot lock', async () => {
    await withReader(async () => {
      const { handleId, reader } = await scanned();
      reader.makeReadOnly = undefined;

      await expect(module.makeNdefReadOnly(handleId)).rejects.toMatchObject({
        code: 'unsupportedPlatform',
      });
    });
  });

  it('refuses to format, which is below the layer a browser reaches', async () => {
    await expect(module.formatNdef('h', new Uint8Array())).rejects.toMatchObject({
      code: 'unsupportedPlatform',
    });
  });
});

describe('everything a browser cannot reach', () => {
  it('refuses raw exchanges and the things built on them', async () => {
    const refusals = [
      module.transceive('h', 'isoDep', new Uint8Array()),
      module.getMaxTransceiveLength('h', 'isoDep'),
      module.setTechTimeout('h', 'isoDep', 100),
      module.getTechTimeout('h', 'isoDep'),
      module.startHce({
        timeoutMs: 1,
        timeoutStatus: 0x6f00,
        aids: null,
        preferSelf: false,
        observeMode: false,
        pollingLoopFilters: null,
      }),
      module.readVas({ configurations: [], alertMessage: null }),
    ];

    for (const refusal of refusals) {
      await expect(refusal).rejects.toMatchObject({ code: 'unsupportedPlatform' });
    }
  });

  it('answers the questions that have a truthful negative answer', async () => {
    // Reported rather than thrown: a startup path calls these on every platform,
    // and `false` is the honest answer rather than an error to handle.
    await expect(module.takeLaunchTag()).resolves.toBeNull();
    await expect(module.isHceSupported()).resolves.toBe(false);
    await expect(module.isObserveModeSupported()).resolves.toBe(false);
    await expect(module.isObserveModeEnabled()).resolves.toBe(false);
    await expect(module.setObserveModeEnabled(true)).resolves.toBe(false);
    await expect(module.respondToHce('r', new Uint8Array())).resolves.toBe(false);
    await expect(module.isVasSupported()).resolves.toBe(false);
    await expect(module.getAntennaInfo()).resolves.toBeNull();
    await expect(module.isSecureNfcEnabled()).resolves.toBe(false);
    await expect(module.stopHce()).resolves.toBeUndefined();
  });
});

describe('event subscriptions', () => {
  it('supports several listeners and removes only the one asked for', async () => {
    await withReader(async () => {
      const first: unknown[] = [];
      const second: unknown[] = [];
      const a = module.addListener('onTagDiscovered', (event) => first.push(event));
      module.addListener('onTagDiscovered', (event) => second.push(event));

      await module.startSession('s1', options());
      a.remove();
      FakeReader.instances[0]?.deliver([textRecord('hi')]);

      expect(first).toHaveLength(0);
      expect(second).toHaveLength(1);
    });
  });
});

describe('turning DOM exceptions into coded errors', () => {
  /**
   * Web NFC reports every failure as a `DOMException` name and nothing
   * NFC-specific, so this table is the entire difference between "the user said
   * no", "the tag went away" and "something broke". Getting one wrong means an app
   * shows the wrong message for the rest of its life.
   */
  const mappings = [
    { name: 'NotAllowedError', code: 'notAuthorized' },
    { name: 'NotSupportedError', code: 'nfcUnsupported' },
    { name: 'AbortError', code: 'aborted' },
    { name: 'NotReadableError', code: 'nfcDisabled' },
    { name: 'NetworkError', code: 'tagLost' },
    { name: 'InvalidStateError', code: 'systemBusy' },
    { name: 'SomethingNew', code: 'internalError' },
  ];

  it.each(mappings)('$name becomes $code', async ({ name, code }) => {
    (globalThis as { NDEFReader?: unknown }).NDEFReader = class {
      onreading = null;
      onreadingerror = null;
      async scan(): Promise<void> {
        throw Object.assign(new Error('failed'), { name });
      }
      async write(): Promise<void> {}
    };

    try {
      await expect(module.startSession('s1', options())).rejects.toMatchObject({ code });
    } finally {
      delete (globalThis as { NDEFReader?: unknown }).NDEFReader;
    }
  });

  it('passes an error that is already coded straight through', async () => {
    const original = new NfcError({
      code: 'ndefMalformed',
      message: 'already coded',
      platform: 'web',
    });
    (globalThis as { NDEFReader?: unknown }).NDEFReader = class {
      onreading = null;
      onreadingerror = null;
      async scan(): Promise<void> {
        throw original;
      }
      async write(): Promise<void> {}
    };

    try {
      // Re-wrapping would bury a message that was already specific.
      await expect(module.startSession('s1', options())).rejects.toBe(original);
    } finally {
      delete (globalThis as { NDEFReader?: unknown }).NDEFReader;
    }
  });

  it('maps a failure to lock the tag as well', async () => {
    await withReader(async () => {
      let handleId = '';
      module.addListener('onTagDiscovered', (event) => {
        handleId = event.tag.handleId;
      });
      await module.startSession('s1', options());
      const reader = FakeReader.instances[0] as FakeReader;
      reader.deliver([textRecord('hi')]);
      reader.makeReadOnly = async () => {
        throw Object.assign(new Error('gone'), { name: 'NetworkError' });
      };

      await expect(module.makeNdefReadOnly(handleId)).rejects.toMatchObject({ code: 'tagLost' });
    });
  });
});

describe('a module that is deliberately absent', () => {
  it('throws when asked for one that a test replaced with null', () => {
    // `null` is the shape "there is no module here", which the native boundary
    // uses for a bundle running against a client built without the library.
    setNativeModuleForTests(null);

    expect(() => getNativeModule()).toThrow(NfcError);
    resetWebModuleForTests();
  });
});

describe('writing after the scan has ended', () => {
  it('refuses rather than writing to whatever is in the field', async () => {
    // Web NFC aims a write at whichever tag is next in the field, so writing
    // without a scan would write to something the caller never saw.
    await withReader(async () => {
      let handleId = '';
      module.addListener('onTagDiscovered', (event) => {
        handleId = event.tag.handleId;
      });
      await module.startSession('s1', options());
      FakeReader.instances[0]?.deliver([textRecord('hi')]);

      await module.closeSession('s1');
      await expect(module.writeNdef(handleId, encodeMessage([]))).rejects.toMatchObject({
        code: 'sessionClosed',
      });
    });
  });
});

describe('what a browser leaves out', () => {
  it('reports no tag id when the browser gives no serial number', async () => {
    // Chrome does report one, but the spec does not require it, and a tag with no
    // id is `null` rather than an empty string that reads as a real value.
    await withReader(async () => {
      const seen: NativeTagDiscoveredEvent[] = [];
      module.addListener('onTagDiscovered', (event) => seen.push(event));

      await module.startSession('s1', options());
      FakeReader.instances[0]?.onreading?.({ message: { records: [textRecord('hi')] } });

      expect(seen[0]?.tag.idHex).toBeNull();
    });
  });

  it('survives a thrown value that is not an error at all', async () => {
    // `throw 'nope'` from a polyfill or an extension should still produce a coded
    // error rather than an exception about reading a property of a string.
    (globalThis as { NDEFReader?: unknown }).NDEFReader = class {
      onreading = null;
      onreadingerror = null;
      async scan(): Promise<void> {
        throw 'nope';
      }
      async write(): Promise<void> {}
    };

    try {
      await expect(module.startSession('s1', options())).rejects.toMatchObject({
        code: 'internalError',
      });
    } finally {
      delete (globalThis as { NDEFReader?: unknown }).NDEFReader;
    }
  });

  it('is not fooled by an NDEFReader that is not a constructor', async () => {
    // Some polyfills and feature-detection shims assign a truthy placeholder.
    (globalThis as { NDEFReader?: unknown }).NDEFReader = {};

    try {
      await expect(module.isSupported()).resolves.toBe(false);
    } finally {
      delete (globalThis as { NDEFReader?: unknown }).NDEFReader;
    }
  });

  it('delivers an event nobody is listening for without complaint', async () => {
    await withReader(async () => {
      await module.startSession('s1', options());

      expect(() => FakeReader.instances[0]?.deliver([textRecord('hi')])).not.toThrow();
    });
  });
});

function options(techs: string[] = ['ndef']) {
  return {
    techs,
    iosPollingOptions: null,
    iosAlertMessage: null,
    iosInvalidateAfterFirstRead: false,
    iosSelectIdentifiers: null,
    iosFelicaSystemCodes: null,
    androidSkipNdefCheck: false,
    androidNoPlatformSounds: false,
    androidPresenceCheckDelayMs: null,
  };
}
