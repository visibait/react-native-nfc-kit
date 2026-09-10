/**
 * ISO 15693 (vicinity) commands: ICODE SLIX, TI Tag-it, and similar.
 *
 * ## A platform asymmetry worth reading before you use this
 *
 * Android's `NfcV.transceive` takes any raw frame, so everything here works.
 * CoreNFC does not have a raw path: it exposes a typed method per standard
 * command and a raw one only for the **custom command range, 0xA0 to 0xDF**. So
 * on iOS, {@link customCommand} works and the standard commands below do not --
 * they reject with `techUnavailable` and a message saying so, rather than failing
 * somewhere inside CoreNFC.
 *
 * This is not a limitation this library invented, and hiding it would only move
 * the surprise to a device. Guard platform-specific work with `tag.android`, and
 * see the capability matrix. Routing the standard commands to CoreNFC's typed
 * methods is a planned addition to the native side.
 *
 * ## Frame layout
 *
 * ```
 * request:   flags | command | [UID] | parameters
 * response:  flags | [error code] | data
 * ```
 *
 * The response's first byte is a flags byte, and its low bit means "what follows
 * is an error code, not data". Treating the whole response as data -- which is
 * easy to do -- turns a clear refusal into plausible-looking rubbish.
 */

import { ByteWriter } from '../ndef/bytes.js';
import { invalidArgument, NfcError } from '../errors.js';

/** Sends a raw ISO 15693 frame and returns the raw response. */
export type Iso15693Transport = (data: Uint8Array) => Promise<Uint8Array>;

/* -------------------------------------------------------------------------- */
/* Flags                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Request flags, as bit values.
 *
 * `highDataRate` is set by essentially every reader and is what most tags expect;
 * omitting it is a common cause of a tag that appears not to answer at all.
 */
export const RequestFlag = {
  /** Two sub-carriers instead of one. */
  dualSubCarrier: 0x01,
  /** High data rate. Set this unless you have a specific reason not to. */
  highDataRate: 0x02,
  /** Inventory mode: the meaning of bits 5 and 6 changes. */
  inventory: 0x04,
  /** A protocol extension follows. */
  protocolExtension: 0x08,
  /** Outside inventory: only the selected tag answers. */
  select: 0x10,
  /** Outside inventory: the request carries a UID. */
  addressed: 0x20,
  /** Command-specific meaning. */
  option: 0x40,
} as const;

export type RequestFlag = (typeof RequestFlag)[keyof typeof RequestFlag];

/** The flags most single-tag operations want: high data rate, nothing else. */
export const DEFAULT_FLAGS = RequestFlag.highDataRate;

/** Response flag meaning the bytes that follow are an error code. */
const RESPONSE_ERROR = 0x01;

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

export const Command = {
  inventory: 0x01,
  stayQuiet: 0x02,
  readSingleBlock: 0x20,
  writeSingleBlock: 0x21,
  lockBlock: 0x22,
  readMultipleBlocks: 0x23,
  writeMultipleBlocks: 0x24,
  select: 0x25,
  resetToReady: 0x26,
  writeAfi: 0x27,
  lockAfi: 0x28,
  writeDsfid: 0x29,
  lockDsfid: 0x2a,
  getSystemInformation: 0x2b,
  getMultipleBlockSecurityStatus: 0x2c,
} as const;

export type Command = (typeof Command)[keyof typeof Command];

/** Lowest custom command code. Below this, iOS cannot send the command at all. */
export const CUSTOM_COMMAND_MIN = 0xa0;
/** Highest custom command code. */
export const CUSTOM_COMMAND_MAX = 0xdf;

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** What an ISO 15693 error code means. */
export function describeErrorCode(code: number): string {
  switch (code) {
    case 0x01:
      return 'The command is not supported by this tag';
    case 0x02:
      return 'The command is not recognised: a format error';
    case 0x03:
      return 'The command option is not supported';
    case 0x0f:
      return 'Unknown error';
    case 0x10:
      return 'The requested block does not exist';
    case 0x11:
      return 'The block is already locked and cannot be locked again';
    case 0x12:
      return 'The block is locked and cannot be changed';
    case 0x13:
      return 'The block was not written successfully';
    case 0x14:
      return 'The block was not locked successfully';
    default:
      return code >= 0xa0 && code <= 0xdf
        ? 'A custom error defined by the tag manufacturer'
        : 'An error code reserved by the specification';
  }
}

/* -------------------------------------------------------------------------- */
/* Framing                                                                    */
/* -------------------------------------------------------------------------- */

export interface BuildRequestOptions {
  readonly flags?: number;
  /**
   * The tag's 8-byte UID, for an addressed request.
   *
   * Supplying it sets the addressed flag, since the two always go together and
   * setting one without the other is a request no tag will answer.
   */
  readonly uid?: Uint8Array;
  readonly parameters?: Uint8Array;
}

/** Builds a request frame: flags, command, optional UID, then parameters. */
export function buildRequest(command: number, options: BuildRequestOptions = {}): Uint8Array {
  if (!Number.isInteger(command) || command < 0 || command > 0xff) {
    throw invalidArgument(`A command code is a single byte; received ${command}.`);
  }

  let flags = options.flags ?? DEFAULT_FLAGS;
  const { uid } = options;

  if (uid !== undefined) {
    if (uid.length !== 8) {
      throw invalidArgument(`An ISO 15693 UID is 8 bytes; received ${uid.length}.`);
    }
    flags |= RequestFlag.addressed;
  }

  const parameters = options.parameters ?? new Uint8Array(0);
  const writer = new ByteWriter(2 + (uid?.length ?? 0) + parameters.length);

  writer.u8(flags).u8(command);
  if (uid !== undefined) {
    // The UID travels least-significant byte first.
    writer.bytes(reversed(uid));
  }
  writer.bytes(parameters);

  return writer.toBytes();
}

function reversed(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = input[input.length - 1 - i] as number;
  }
  return out;
}

/**
 * Strips the response flags and raises the tag's error if it reported one.
 *
 * The low bit of the first byte means "an error code follows". Skipping that
 * check is the classic ISO 15693 mistake: the caller gets two bytes that look
 * like data and are actually a refusal.
 */
export function parseResponse(response: Uint8Array): Uint8Array {
  if (response.length === 0) {
    throw new NfcError({
      code: 'transceiveFailed',
      message:
        'The tag returned no response at all; an ISO 15693 response always has a flags byte.',
    });
  }

  const flags = response[0] as number;
  if ((flags & RESPONSE_ERROR) === 0) {
    return response.subarray(1);
  }

  if (response.length < 2) {
    throw new NfcError({
      code: 'transceiveFailed',
      message: 'The tag reported an error but did not say which; the error code byte is missing.',
    });
  }

  const code = response[1] as number;
  throw new NfcError({
    code: 'ioError',
    message: `The tag refused the command: ${describeErrorCode(code)} (0x${code
      .toString(16)
      .padStart(2, '0')}).`,
    nativeCode: `iso15693:${code.toString(16).padStart(2, '0')}`,
  });
}

/** Sends a request and returns the response body, errors already raised. */
export async function sendRequest(
  transport: Iso15693Transport,
  command: number,
  options: BuildRequestOptions = {},
): Promise<Uint8Array> {
  return parseResponse(await transport(buildRequest(command, options)));
}

/* -------------------------------------------------------------------------- */
/* Standard commands                                                          */
/* -------------------------------------------------------------------------- */

function assertBlock(block: number): void {
  if (!Number.isInteger(block) || block < 0 || block > 0xff) {
    throw invalidArgument(`A block number is 0..255; received ${block}.`);
  }
}

/**
 * Reads one block.
 *
 * Android only, like every standard command here -- CoreNFC has no raw path for
 * them. Block size varies by tag; ask {@link getSystemInformation}.
 */
export async function readSingleBlock(
  transport: Iso15693Transport,
  block: number,
  options: BuildRequestOptions = {},
): Promise<Uint8Array> {
  assertBlock(block);
  return sendRequest(transport, Command.readSingleBlock, {
    ...options,
    parameters: new Uint8Array([block]),
  });
}

/** Writes one block. Android only. */
export async function writeSingleBlock(
  transport: Iso15693Transport,
  block: number,
  data: Uint8Array,
  options: BuildRequestOptions = {},
): Promise<void> {
  assertBlock(block);
  if (data.length === 0) {
    throw invalidArgument('A block write needs at least one byte.');
  }

  const parameters = new Uint8Array(1 + data.length);
  parameters[0] = block;
  parameters.set(data, 1);

  await sendRequest(transport, Command.writeSingleBlock, { ...options, parameters });
}

/**
 * Reads several consecutive blocks.
 *
 * The count on the wire is one less than the number of blocks, which is a
 * long-standing source of off-by-one bugs; this takes the count you mean.
 * Android only.
 */
export async function readMultipleBlocks(
  transport: Iso15693Transport,
  firstBlock: number,
  count: number,
  options: BuildRequestOptions = {},
): Promise<Uint8Array> {
  assertBlock(firstBlock);
  if (!Number.isInteger(count) || count < 1 || count > 256) {
    throw invalidArgument(`A block count is 1..256; received ${count}.`);
  }

  return sendRequest(transport, Command.readMultipleBlocks, {
    ...options,
    parameters: new Uint8Array([firstBlock, count - 1]),
  });
}

/** Locks one block permanently. Android only, and irreversible. */
export async function lockBlock(
  transport: Iso15693Transport,
  block: number,
  options: BuildRequestOptions = {},
): Promise<void> {
  assertBlock(block);
  await sendRequest(transport, Command.lockBlock, {
    ...options,
    parameters: new Uint8Array([block]),
  });
}

export interface SystemInformation {
  /** Which of the optional fields the tag actually reported. */
  readonly infoFlags: number;
  /** UID, most-significant byte first. */
  readonly uid: Uint8Array;
  readonly dsfid: number | null;
  readonly afi: number | null;
  /** Number of blocks, when reported. */
  readonly blockCount: number | null;
  /** Bytes per block, when reported. */
  readonly blockSize: number | null;
  readonly icReference: number | null;
}

/**
 * Reads the tag's system information: UID, block layout, identifiers.
 *
 * The optional fields are each present only when their bit is set in the info
 * flags, so they are reported as `null` rather than as a plausible zero. Android
 * only.
 */
export async function getSystemInformation(
  transport: Iso15693Transport,
  options: BuildRequestOptions = {},
): Promise<SystemInformation> {
  const body = await sendRequest(transport, Command.getSystemInformation, options);

  if (body.length < 9) {
    throw new NfcError({
      code: 'transceiveFailed',
      message: `System information is at least 9 bytes; the tag returned ${body.length}.`,
    });
  }

  const infoFlags = body[0] as number;
  // The UID arrives least-significant byte first.
  const uid = reversed(body.subarray(1, 9));

  let offset = 9;
  const take = (present: boolean): number | null => {
    if (!present) {
      return null;
    }
    const value = body[offset] as number | undefined;
    offset += 1;
    return value ?? null;
  };

  const dsfid = take((infoFlags & 0x01) !== 0);
  const afi = take((infoFlags & 0x02) !== 0);

  let blockCount: number | null = null;
  let blockSize: number | null = null;
  if ((infoFlags & 0x04) !== 0) {
    const rawCount = body[offset] as number | undefined;
    const rawSize = body[offset + 1] as number | undefined;
    offset += 2;
    // Both fields are stored one less than the real value.
    blockCount = rawCount === undefined ? null : rawCount + 1;
    blockSize = rawSize === undefined ? null : (rawSize & 0x1f) + 1;
  }

  const icReference = take((infoFlags & 0x08) !== 0);

  return { infoFlags, uid, dsfid, afi, blockCount, blockSize, icReference };
}

/**
 * Sends a custom, manufacturer-defined command.
 *
 * The only path that works on both platforms: CoreNFC's raw ISO 15693 method
 * accepts custom codes and nothing else.
 */
export async function customCommand(
  transport: Iso15693Transport,
  command: number,
  options: BuildRequestOptions = {},
): Promise<Uint8Array> {
  if (!Number.isInteger(command) || command < CUSTOM_COMMAND_MIN || command > CUSTOM_COMMAND_MAX) {
    throw invalidArgument(
      `A custom command code is 0x${CUSTOM_COMMAND_MIN.toString(16)}..0x${CUSTOM_COMMAND_MAX.toString(
        16,
      )}; received ${command}. Standard commands go through their own functions.`,
    );
  }
  return sendRequest(transport, command, options);
}
