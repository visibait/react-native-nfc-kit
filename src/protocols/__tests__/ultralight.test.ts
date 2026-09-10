import { NfcError } from '../../errors.js';
import { toHex } from '../../ndef/bytes.js';
import {
  PACK_SIZE,
  PAGE_SIZE,
  PASSWORD_SIZE,
  READ_SIZE,
  compatibilityWritePage,
  fastRead,
  getVersion,
  passwordAuthenticate,
  read,
  readCounter,
  readPages,
  readSignature,
  storageBytesFor,
  writePage,
  writePages,
  type UltralightTransport,
} from '../ultralight.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/**
 * Asserts a coded failure, whether it is thrown or rejected.
 *
 * Everything in this module is async, so an argument check surfaces as a
 * rejection rather than a throw; a synchronous helper would quietly pass while
 * leaving an unhandled rejection behind.
 */
async function expectNfcError(
  run: () => unknown,
  code: string,
  messagePart?: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(NfcError.is(error, code as never)).toBe(true);
    if (messagePart !== undefined) {
      expect((error as NfcError).message).toContain(messagePart);
    }
    return;
  }
  throw new Error(`Expected an NfcError with code "${code}" but nothing was thrown.`);
}

/** Replays scripted responses and records what was sent. */
function scripted(...responses: Uint8Array[]): UltralightTransport & { sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  let index = 0;

  const transport = (data: Uint8Array): Promise<Uint8Array> => {
    sent.push(data);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(response ?? new Uint8Array(0));
  };

  return Object.assign(transport, { sent });
}

/** A tag whose every page is filled with its own page number. */
function pagedTag(): UltralightTransport & { sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];

  const transport = (data: Uint8Array): Promise<Uint8Array> => {
    sent.push(data);
    const page = data[1] as number;
    const out = new Uint8Array(READ_SIZE);
    for (let i = 0; i < READ_SIZE; i += 1) {
      out[i] = page + Math.floor(i / PAGE_SIZE);
    }
    return Promise.resolve(out);
  };

  return Object.assign(transport, { sent });
}

describe('read', () => {
  it('sends the READ command and returns four pages', async () => {
    const transport = scripted(new Uint8Array(READ_SIZE).fill(0xab));
    const data = await read(transport, 4);

    expect(Array.from(transport.sent[0]!)).toEqual([0x30, 0x04]);
    expect(data).toHaveLength(16);
  });

  it.each([-1, 256, 1.5])('rejects the page %s', async (page) => {
    await expectNfcError(() => read(scripted(), page), 'invalidArgument', 'page must be');
  });

  it('explains a short response rather than returning it', async () => {
    // A truncated answer here almost always means the tag rejected the command,
    // most often because it wants authenticating first.
    const transport = scripted(bytes(0x00));

    await read(transport, 4).catch((error: NfcError) => {
      expect(error.code).toBe('transceiveFailed');
      expect(error.message).toContain('1 byte(s) instead of 16');
      expect(error.message).toContain('authenticating');
    });
  });
});

describe('fastRead', () => {
  it('reads a whole range in one exchange', async () => {
    const transport = scripted(new Uint8Array(5 * PAGE_SIZE).fill(1));
    const data = await fastRead(transport, 4, 8);

    expect(Array.from(transport.sent[0]!)).toEqual([0x3a, 0x04, 0x08]);
    expect(data).toHaveLength(20);
  });

  it('reads a single page range', async () => {
    const transport = scripted(new Uint8Array(PAGE_SIZE));
    await expect(fastRead(transport, 6, 6)).resolves.toHaveLength(4);
  });

  it('rejects a reversed range', async () => {
    await expectNfcError(() => fastRead(scripted(), 8, 4), 'invalidArgument', 'must not be before');
  });

  it.each([
    ['startPage', -1, 4],
    ['endPage', 0, 300],
  ])('rejects an out-of-range %s', async (name, start, end) => {
    await expectNfcError(() => fastRead(scripted(), start, end), 'invalidArgument', name);
  });

  it('reports a response of the wrong size', async () => {
    const transport = scripted(new Uint8Array(4));
    await expect(fastRead(transport, 4, 8)).rejects.toMatchObject({ code: 'transceiveFailed' });
  });
});

describe('readPages', () => {
  it('issues as many READs as needed and trims the surplus', async () => {
    // Each READ returns four pages, so six pages costs two reads and three of
    // the eight returned pages are discarded.
    const transport = pagedTag();
    const data = await readPages(transport, 4, 6);

    expect(data).toHaveLength(24);
    expect(transport.sent.map((c) => c[1])).toEqual([4, 8]);
    expect(data[0]).toBe(4);
    expect(data[20]).toBe(9);
  });

  it('needs only one read for exactly four pages', async () => {
    const transport = pagedTag();
    await readPages(transport, 0, 4);
    expect(transport.sent).toHaveLength(1);
  });

  it('needs only one read for fewer than four pages', async () => {
    const transport = pagedTag();
    const data = await readPages(transport, 4, 1);

    expect(data).toHaveLength(4);
    expect(transport.sent).toHaveLength(1);
  });

  it.each([0, -1, 1.5])('rejects a pageCount of %s', async (pageCount) => {
    await expectNfcError(() => readPages(scripted(), 4, pageCount), 'invalidArgument', 'pageCount');
  });

  it('rejects an out-of-range start page', async () => {
    await expectNfcError(() => readPages(scripted(), 300, 1), 'invalidArgument', 'startPage');
  });
});

describe('writePage', () => {
  it('sends the WRITE command with the page and its four bytes', async () => {
    const transport = scripted(bytes(0x0a));
    await writePage(transport, 5, bytes(1, 2, 3, 4));

    expect(Array.from(transport.sent[0]!)).toEqual([0xa2, 0x05, 1, 2, 3, 4]);
  });

  it('refuses to pad a short write', async () => {
    // Padding someone's data with zeros is not a decision a library should take
    // on their behalf.
    await expectNfcError(
      () => writePage(scripted(), 5, bytes(1, 2)),
      'invalidArgument',
      'exactly 4 bytes',
    );
  });

  it('refuses an oversized write', async () => {
    await expectNfcError(() => writePage(scripted(), 5, bytes(1, 2, 3, 4, 5)), 'invalidArgument');
  });

  it('rejects an out-of-range page', async () => {
    await expectNfcError(() => writePage(scripted(), 300, bytes(1, 2, 3, 4)), 'invalidArgument');
  });
});

describe('compatibilityWritePage', () => {
  it('sends a 16-byte payload with the data in the first four bytes', async () => {
    const transport = scripted(bytes(0x0a));
    await compatibilityWritePage(transport, 4, bytes(0xaa, 0xbb, 0xcc, 0xdd));

    const sent = transport.sent[0]!;
    expect(sent).toHaveLength(18);
    expect(Array.from(sent.subarray(0, 6))).toEqual([0xa0, 0x04, 0xaa, 0xbb, 0xcc, 0xdd]);
    expect(Array.from(sent.subarray(6))).toEqual(new Array(12).fill(0));
  });

  it('rejects a payload that is not one page', async () => {
    await expectNfcError(() => compatibilityWritePage(scripted(), 4, bytes(1)), 'invalidArgument');
  });

  it('rejects an out-of-range page', async () => {
    await expectNfcError(
      () => compatibilityWritePage(scripted(), -1, bytes(1, 2, 3, 4)),
      'invalidArgument',
    );
  });
});

describe('writePages', () => {
  it('writes one page per command, advancing the address', async () => {
    const transport = scripted(bytes(0x0a));
    await writePages(transport, 4, bytes(1, 2, 3, 4, 5, 6, 7, 8));

    expect(transport.sent).toHaveLength(2);
    expect(Array.from(transport.sent[0]!)).toEqual([0xa2, 4, 1, 2, 3, 4]);
    expect(Array.from(transport.sent[1]!)).toEqual([0xa2, 5, 5, 6, 7, 8]);
  });

  it.each([0, 3, 5])('rejects %s bytes, which is not a whole number of pages', async (length) => {
    await expectNfcError(
      () => writePages(scripted(), 4, new Uint8Array(length)),
      'invalidArgument',
      'multiple of 4',
    );
  });
});

describe('getVersion', () => {
  it('decodes a real NTAG213 response', async () => {
    // 00 04 04 02 01 00 0F 03 is what an NTAG213 returns.
    const transport = scripted(bytes(0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x0f, 0x03));
    const version = await getVersion(transport);

    expect(Array.from(transport.sent[0]!)).toEqual([0x60]);
    expect(version.vendorId).toBe(0x04);
    expect(version.product).toBe('NTAG213');
    expect(version.majorVersion).toBe(1);
    expect(version.storageSizeCode).toBe(0x0f);
  });

  it.each([
    [0x0f, 'NTAG213'],
    [0x11, 'NTAG215'],
    [0x13, 'NTAG216'],
    [0x99, 'NTAG'],
  ])('names the product for storage code %s', async (code, expected) => {
    const transport = scripted(bytes(0x00, 0x04, 0x04, 0x02, 0x01, 0x00, code, 0x03));
    expect((await getVersion(transport)).product).toBe(expected);
  });

  it('recognises MIFARE Ultralight', async () => {
    const transport = scripted(bytes(0x00, 0x04, 0x03, 0x01, 0x01, 0x00, 0x0b, 0x03));
    expect((await getVersion(transport)).product).toBe('MIFARE Ultralight');
  });

  it('declines to name an unfamiliar NXP product type', async () => {
    const transport = scripted(bytes(0x00, 0x04, 0x77, 0x02, 0x01, 0x00, 0x0f, 0x03));
    expect((await getVersion(transport)).product).toBeNull();
  });

  it('declines to name another vendor entirely', async () => {
    const transport = scripted(bytes(0x00, 0x99, 0x04, 0x02, 0x01, 0x00, 0x0f, 0x03));
    expect((await getVersion(transport)).product).toBeNull();
  });

  it('reports a wrong-length response, which is how an older tag refuses', async () => {
    const transport = scripted(bytes(0x00));
    await expect(getVersion(transport)).rejects.toMatchObject({ code: 'transceiveFailed' });
  });
});

describe('storageBytesFor', () => {
  it.each([
    [0x0f, 128],
    [0x11, 256],
    [0x13, 512],
  ])('reads the exponent out of code %s', async (code, expected) => {
    expect(storageBytesFor(code)).toBe(expected);
  });
});

describe('passwordAuthenticate', () => {
  it('sends the password and returns the acknowledgement', async () => {
    const transport = scripted(bytes(0x80, 0x80));
    const pack = await passwordAuthenticate(transport, bytes(0xff, 0xff, 0xff, 0xff));

    expect(Array.from(transport.sent[0]!)).toEqual([0x1b, 0xff, 0xff, 0xff, 0xff]);
    expect(toHex(pack)).toBe('8080');
    expect(pack).toHaveLength(PACK_SIZE);
  });

  it.each([0, 3, 5])('rejects a password of %s bytes', async (length) => {
    await expectNfcError(
      () => passwordAuthenticate(scripted(), new Uint8Array(length)),
      'invalidArgument',
      `exactly ${PASSWORD_SIZE} bytes`,
    );
  });

  it('reports a rejection as an authentication failure, and warns about retrying', async () => {
    // NTAG counts failed attempts and can lock itself permanently, so a retry
    // loop here is genuinely destructive.
    const transport: UltralightTransport = () => Promise.reject(new Error('tag said no'));

    await passwordAuthenticate(transport, bytes(1, 2, 3, 4)).catch((error: NfcError) => {
      expect(error.code).toBe('authenticationFailed');
      expect(error.message).toContain('lock');
      expect((error.cause as Error).message).toBe('tag said no');
    });
  });

  it('reports an acknowledgement of the wrong size', async () => {
    const transport = scripted(bytes(0x80));
    await expect(passwordAuthenticate(transport, bytes(1, 2, 3, 4))).rejects.toMatchObject({
      code: 'transceiveFailed',
    });
  });
});

describe('readCounter', () => {
  it('reads the little-endian counter', async () => {
    const transport = scripted(bytes(0x2a, 0x01, 0x00));
    const value = await readCounter(transport);

    expect(Array.from(transport.sent[0]!)).toEqual([0x39, 0x00]);
    expect(value).toBe(0x0000012a);
  });

  it('reads a counter at its maximum', async () => {
    expect(await readCounter(scripted(bytes(0xff, 0xff, 0xff)))).toBe(0xffffff);
  });

  it('addresses another counter', async () => {
    const transport = scripted(bytes(0, 0, 0));
    await readCounter(transport, 2);
    expect(transport.sent[0]![1]).toBe(2);
  });

  it.each([-1, 3, 1.5])('rejects the counter index %s', async (counter) => {
    await expectNfcError(() => readCounter(scripted(), counter), 'invalidArgument', '0..2');
  });

  it('reports a wrong-length response', async () => {
    await expect(readCounter(scripted(bytes(0, 0)))).rejects.toMatchObject({
      code: 'transceiveFailed',
    });
  });
});

describe('readSignature', () => {
  it('returns the 32 signature bytes without interpreting them', async () => {
    // Verifying needs NXP's public key and an ECC implementation, neither of
    // which belongs in an NFC library -- or, ideally, in the app at all.
    const transport = scripted(new Uint8Array(32).fill(0x5a));
    const signature = await readSignature(transport);

    expect(Array.from(transport.sent[0]!)).toEqual([0x3c, 0x00]);
    expect(signature).toHaveLength(32);
  });

  it('reports a wrong-length response', async () => {
    await expect(readSignature(scripted(new Uint8Array(16)))).rejects.toMatchObject({
      code: 'transceiveFailed',
    });
  });
});
