/**
 * MIFARE Ultralight and NTAG commands.
 *
 * These are the tags most people actually hold: an NTAG213, 215 or 216 sticker,
 * or a MIFARE Ultralight card. Both platforms can reach them -- Android through
 * `MifareUltralight`, iOS through `NFCMiFareTag` -- so everything here works on
 * both, which is not true of much else at this level.
 *
 * Two things worth knowing before using any of it:
 *
 * - **Memory is addressed in 4-byte pages**, and a READ returns four pages at
 *   once. Asking for page 4 gives you pages 4, 5, 6 and 7.
 * - **A read past the end wraps around** rather than failing, on most of these
 *   tags. So reading the last page returns a mix of the end and the beginning,
 *   which looks like corruption if you are not expecting it.
 *
 * The NDEF message on these tags is wrapped in TLV framing, so the usual path is
 * to read the data area and hand it to `findNdefMessageTlv` from the codec rather
 * than parsing pages by hand.
 */

import { invalidArgument, NfcError } from '../errors.js';

/** Sends bytes to the tag and returns the response. */
export type UltralightTransport = (data: Uint8Array) => Promise<Uint8Array>;

/** Bytes in one page. */
export const PAGE_SIZE = 4;
/** Pages returned by a single READ. */
export const PAGES_PER_READ = 4;
/** Bytes returned by a single READ. */
export const READ_SIZE = PAGE_SIZE * PAGES_PER_READ;

const CMD_READ = 0x30;
const CMD_FAST_READ = 0x3a;
const CMD_WRITE = 0xa2;
const CMD_COMPATIBILITY_WRITE = 0xa0;
const CMD_GET_VERSION = 0x60;
const CMD_PWD_AUTH = 0x1b;
const CMD_READ_CNT = 0x39;
const CMD_READ_SIG = 0x3c;

/** Highest page a single-byte address can name. */
const MAX_PAGE = 0xff;

function assertPage(page: number, what = 'page'): void {
  if (!Number.isInteger(page) || page < 0 || page > MAX_PAGE) {
    throw invalidArgument(`${what} must be an integer in 0..${MAX_PAGE}, received ${page}.`);
  }
}

function expectLength(response: Uint8Array, expected: number, what: string): Uint8Array {
  if (response.length !== expected) {
    throw new NfcError({
      code: 'transceiveFailed',
      message:
        `${what} returned ${response.length} byte(s) instead of ${expected}. ` +
        'A short response here usually means the tag rejected the command, often ' +
        'because it needs authenticating first.',
    });
  }
  return response;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reads four pages, starting at `page`.
 *
 * Always 16 bytes. On most of these tags a read past the last page wraps to the
 * beginning rather than failing, so the result can be a mix of the end and the
 * start of memory -- check the tag's page count before reading near the end.
 */
export async function read(transport: UltralightTransport, page: number): Promise<Uint8Array> {
  assertPage(page);
  const response = await transport(new Uint8Array([CMD_READ, page]));
  return expectLength(response, READ_SIZE, `READ of page ${page}`);
}

/**
 * Reads a range of pages in one exchange. NTAG only.
 *
 * Much faster than repeated READs for anything large, but MIFARE Ultralight does
 * not implement it -- use {@link readPages} if you need to work on both.
 */
export async function fastRead(
  transport: UltralightTransport,
  startPage: number,
  endPage: number,
): Promise<Uint8Array> {
  assertPage(startPage, 'startPage');
  assertPage(endPage, 'endPage');
  if (endPage < startPage) {
    throw invalidArgument(`endPage (${endPage}) must not be before startPage (${startPage}).`);
  }

  const response = await transport(new Uint8Array([CMD_FAST_READ, startPage, endPage]));
  const expected = (endPage - startPage + 1) * PAGE_SIZE;
  return expectLength(response, expected, `FAST_READ of pages ${startPage}..${endPage}`);
}

/**
 * Reads a page range with plain READs, trimming the overlap.
 *
 * Works on every tag in this family, unlike {@link fastRead}. Each READ returns
 * four pages, so reading a range that is not a multiple of four fetches a little
 * more than asked for and discards the surplus.
 */
export async function readPages(
  transport: UltralightTransport,
  startPage: number,
  pageCount: number,
): Promise<Uint8Array> {
  assertPage(startPage, 'startPage');
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw invalidArgument(`pageCount must be a positive integer, received ${pageCount}.`);
  }

  const out = new Uint8Array(pageCount * PAGE_SIZE);
  let written = 0;

  for (let page = startPage; written < out.length; page += PAGES_PER_READ) {
    const chunk = await read(transport, page);
    const take = Math.min(chunk.length, out.length - written);
    out.set(chunk.subarray(0, take), written);
    written += take;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Writes one page.
 *
 * Exactly four bytes, because that is what a page holds; a shorter write is
 * rejected here rather than silently padded, since padding someone's data with
 * zeros is not a decision a library should make on their behalf.
 */
export async function writePage(
  transport: UltralightTransport,
  page: number,
  data: Uint8Array,
): Promise<void> {
  assertPage(page);
  if (data.length !== PAGE_SIZE) {
    throw invalidArgument(
      `A page is exactly ${PAGE_SIZE} bytes; received ${data.length}. Pad or split it yourself, ` +
        "so the padding is your choice rather than this library's.",
    );
  }

  const command = new Uint8Array(2 + PAGE_SIZE);
  command[0] = CMD_WRITE;
  command[1] = page;
  command.set(data, 2);
  await transport(command);
}

/**
 * Writes one page using the 16-byte compatibility command.
 *
 * MIFARE Ultralight's original write takes a full 16 bytes and stores only the
 * first four. Needed by some older readers and tags that reject the 4-byte form.
 */
export async function compatibilityWritePage(
  transport: UltralightTransport,
  page: number,
  data: Uint8Array,
): Promise<void> {
  assertPage(page);
  if (data.length !== PAGE_SIZE) {
    throw invalidArgument(`A page is exactly ${PAGE_SIZE} bytes; received ${data.length}.`);
  }

  const command = new Uint8Array(2 + READ_SIZE);
  command[0] = CMD_COMPATIBILITY_WRITE;
  command[1] = page;
  command.set(data, 2);
  await transport(command);
}

/** Writes a run of pages, one page per command. */
export async function writePages(
  transport: UltralightTransport,
  startPage: number,
  data: Uint8Array,
): Promise<void> {
  if (data.length === 0 || data.length % PAGE_SIZE !== 0) {
    throw invalidArgument(
      `Data must be a non-zero multiple of ${PAGE_SIZE} bytes; received ${data.length}.`,
    );
  }

  for (let offset = 0; offset < data.length; offset += PAGE_SIZE) {
    await writePage(
      transport,
      startPage + offset / PAGE_SIZE,
      data.subarray(offset, offset + PAGE_SIZE),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Identification                                                             */
/* -------------------------------------------------------------------------- */

export interface TagVersion {
  readonly vendorId: number;
  readonly productType: number;
  readonly productSubtype: number;
  readonly majorVersion: number;
  readonly minorVersion: number;
  /** Raw storage-size byte, as returned. */
  readonly storageSizeCode: number;
  /** Usable memory in bytes, derived from the storage-size code. */
  readonly storageBytes: number;
  readonly protocolType: number;
  /** A recognised product name, or `null` when the combination is unfamiliar. */
  readonly product: string | null;
}

/** NXP's registered vendor identifier. */
const VENDOR_NXP = 0x04;

/**
 * Reads GET_VERSION and interprets it.
 *
 * Not every tag in this family implements it -- the original MIFARE Ultralight
 * does not -- and those reject the command, so treat a failure as "this is an
 * older tag" rather than as an error worth surfacing to a user.
 */
export async function getVersion(transport: UltralightTransport): Promise<TagVersion> {
  const response = expectLength(
    await transport(new Uint8Array([CMD_GET_VERSION])),
    8,
    'GET_VERSION',
  );

  const vendorId = response[1] as number;
  const productType = response[2] as number;
  const productSubtype = response[3] as number;
  const majorVersion = response[4] as number;
  const minorVersion = response[5] as number;
  const storageSizeCode = response[6] as number;
  const protocolType = response[7] as number;

  return {
    vendorId,
    productType,
    productSubtype,
    majorVersion,
    minorVersion,
    storageSizeCode,
    storageBytes: storageBytesFor(storageSizeCode),
    protocolType,
    product: productNameFor(vendorId, productType, storageSizeCode),
  };
}

/**
 * Decodes the storage-size byte.
 *
 * The top seven bits are an exponent: the size is `2^n`. The bottom bit says the
 * real size sits between `2^n` and `2^(n+1)`, which it does for NTAG213 and 216,
 * so the exact figure comes from the product table rather than from arithmetic.
 */
export function storageBytesFor(storageSizeCode: number): number {
  return 2 ** (storageSizeCode >> 1);
}

function productNameFor(
  vendorId: number,
  productType: number,
  storageSizeCode: number,
): string | null {
  if (vendorId !== VENDOR_NXP) {
    return null;
  }

  // Product type 0x04 is NTAG, 0x03 is MIFARE Ultralight.
  if (productType === 0x04) {
    switch (storageSizeCode) {
      case 0x0f:
        return 'NTAG213';
      case 0x11:
        return 'NTAG215';
      case 0x13:
        return 'NTAG216';
      default:
        return 'NTAG';
    }
  }
  if (productType === 0x03) {
    return 'MIFARE Ultralight';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Password protection                                                        */
/* -------------------------------------------------------------------------- */

/** Bytes in an NTAG password. */
export const PASSWORD_SIZE = 4;
/** Bytes in the acknowledgement a successful authentication returns. */
export const PACK_SIZE = 2;

/**
 * Authenticates with a 4-byte password, returning the tag's 2-byte
 * acknowledgement.
 *
 * The acknowledgement is the tag proving it knows the password too, so compare it
 * against the PACK you configured -- a tag that accepts any password and returns
 * something arbitrary is a cloned tag.
 *
 * NTAG counts failed attempts and can lock itself permanently once the configured
 * limit is reached. Do not use this in a retry loop.
 */
export async function passwordAuthenticate(
  transport: UltralightTransport,
  password: Uint8Array,
): Promise<Uint8Array> {
  if (password.length !== PASSWORD_SIZE) {
    throw invalidArgument(
      `An NTAG password is exactly ${PASSWORD_SIZE} bytes; received ${password.length}.`,
    );
  }

  const command = new Uint8Array(1 + PASSWORD_SIZE);
  command[0] = CMD_PWD_AUTH;
  command.set(password, 1);

  let response: Uint8Array;
  try {
    response = await transport(command);
  } catch (cause) {
    throw new NfcError({
      code: 'authenticationFailed',
      message:
        'The tag rejected the password. Note that NTAG counts failed attempts and can lock ' +
        'itself permanently, so do not retry blindly.',
      cause,
    });
  }

  return expectLength(response, PACK_SIZE, 'PWD_AUTH');
}

/* -------------------------------------------------------------------------- */
/* Counters and signature                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Reads one of the tag's NFC counters.
 *
 * NTAG21x increments a counter on every read when the feature is enabled, which
 * is how a tag can prove it has been scanned rather than copied. Three bytes,
 * little-endian.
 */
export async function readCounter(transport: UltralightTransport, counter = 0): Promise<number> {
  if (!Number.isInteger(counter) || counter < 0 || counter > 2) {
    throw invalidArgument(`A counter index is 0..2; received ${counter}.`);
  }

  const response = expectLength(
    await transport(new Uint8Array([CMD_READ_CNT, counter])),
    3,
    'READ_CNT',
  );

  return (response[0] as number) | ((response[1] as number) << 8) | ((response[2] as number) << 16);
}

/**
 * Reads the tag's ECC originality signature.
 *
 * 32 bytes, signed by NXP over the UID. Verifying it needs the manufacturer's
 * public key and an ECC implementation, neither of which belongs here -- this
 * returns the bytes so you can verify them wherever you keep that key, which
 * should not be inside the app.
 */
export async function readSignature(transport: UltralightTransport): Promise<Uint8Array> {
  return expectLength(await transport(new Uint8Array([CMD_READ_SIG, 0x00])), 32, 'READ_SIG');
}
