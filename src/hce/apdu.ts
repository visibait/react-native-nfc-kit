/**
 * The card side of ISO 7816 framing.
 *
 * `src/protocols/iso7816.ts` builds commands and reads responses, which is what a
 * reader does. This does the mirror image: reads a command a terminal sent, and
 * builds the response to send back. The two are tested against each other, so a
 * change to either that breaks the pairing fails immediately rather than on a
 * terminal.
 *
 * Nothing here touches the platform, so it is plain byte handling that can be
 * held to full coverage.
 */

import { invalidArgument } from '../errors.js';

/* -------------------------------------------------------------------------- */
/* Status words                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The status words a card actually needs to send.
 *
 * Named rather than written as literals at the point of use, because `0x6a82`
 * appearing in a response handler tells the next reader nothing, and the wrong
 * status word is a bug a terminal reports as "card not supported".
 */
export const StatusWord = {
  /** Success. */
  ok: 0x9000,
  /** The command is understood but the current state does not allow it. */
  conditionsNotSatisfied: 0x6985,
  /** The command needs authentication that has not happened. */
  securityNotSatisfied: 0x6982,
  /** Lc or Le is not what this command accepts. */
  wrongLength: 0x6700,
  /** The named file or application does not exist here. */
  fileNotFound: 0x6a82,
  /** P1/P2 name something this command does not offer. */
  wrongParameters: 0x6a86,
  /** The data field is malformed for this command. */
  wrongData: 0x6a80,
  /** This instruction byte is not implemented. */
  instructionNotSupported: 0x6d00,
  /** This class byte is not supported. */
  classNotSupported: 0x6e00,
  /** Something went wrong and the card has nothing more specific to say. */
  unknown: 0x6f00,
} as const;

export type StatusWordValue = (typeof StatusWord)[keyof typeof StatusWord];

/* -------------------------------------------------------------------------- */
/* Command APDUs                                                              */
/* -------------------------------------------------------------------------- */

export interface IncomingApdu {
  readonly cla: number;
  readonly ins: number;
  readonly p1: number;
  readonly p2: number;
  /** Command data. Empty when the command carried none. */
  readonly data: Uint8Array;
  /**
   * Expected response length in bytes, or `null` when none was requested.
   *
   * Counts bytes rather than mirroring the encoding: `0x00` on the wire means
   * 256, and a field that reported `0` for it would be wrong in the one case
   * that matters.
   */
  readonly le: number | null;
  /** Whether the command used the 3-byte extended form. */
  readonly extended: boolean;
}

/** `P1` of a SELECT that names an application by its AID. */
export const SELECT_BY_NAME = 0x04;
/** `P1` of a SELECT that names a file by its identifier. */
export const SELECT_BY_FILE_ID = 0x00;

export const Instruction = {
  select: 0xa4,
  readBinary: 0xb0,
  updateBinary: 0xd6,
} as const;

function malformed(reason: string, bytes: Uint8Array): never {
  throw invalidArgument(
    `Malformed command APDU (${bytes.length} bytes): ${reason}. A terminal that sends this is ` +
      'either speaking a protocol this card does not implement, or the link is corrupting frames.',
  );
}

/**
 * Reads a command APDU a terminal sent.
 *
 * All four ISO 7816-4 cases, short and extended:
 *
 * | Case | Shape                     | Meaning                          |
 * | ---- | ------------------------- | -------------------------------- |
 * | 1    | `CLA INS P1 P2`           | no data, no response expected    |
 * | 2    | `... Le`                  | no data, response expected       |
 * | 3    | `... Lc data`             | data, no response expected       |
 * | 4    | `... Lc data Le`          | data and response                |
 *
 * The extended forms replace the single length byte with `00` followed by two
 * bytes, and case 2 extended is `00 Le1 Le2` with no data at all — a shape that
 * is easy to mistake for a truncated case 4 and is why the length arithmetic here
 * is written out rather than inferred.
 */
export function decodeCommandApdu(bytes: Uint8Array): IncomingApdu {
  if (bytes.length < 4) {
    malformed('a command APDU is at least a 4-byte header', bytes);
  }

  const header = {
    cla: bytes[0] as number,
    ins: bytes[1] as number,
    p1: bytes[2] as number,
    p2: bytes[3] as number,
  };
  const body = bytes.subarray(4);

  // Case 1: header only.
  if (body.length === 0) {
    return { ...header, data: new Uint8Array(), le: null, extended: false };
  }

  // Case 2 short: a single Le byte.
  if (body.length === 1) {
    return {
      ...header,
      data: new Uint8Array(),
      le: shortLength(body[0] as number),
      extended: false,
    };
  }

  const extended = body[0] === 0x00;
  return extended ? decodeExtendedBody(header, body, bytes) : decodeShortBody(header, body, bytes);
}

/** On the wire `0x00` requests the maximum, which is 256 for a short APDU. */
function shortLength(value: number): number {
  return value === 0 ? 256 : value;
}

function decodeShortBody(
  header: Pick<IncomingApdu, 'cla' | 'ins' | 'p1' | 'p2'>,
  body: Uint8Array,
  bytes: Uint8Array,
): IncomingApdu {
  // `lc` cannot be zero here: a leading zero byte in the body is what marks the
  // extended form, and a one-byte body was already read as case 2 above. So the
  // short form only ever reaches this point with a real length.
  const lc = body[0] as number;
  const dataEnd = 1 + lc;
  if (body.length < dataEnd) {
    malformed(`Lc says ${lc} data bytes but only ${body.length - 1} are present`, bytes);
  }
  if (body.length > dataEnd + 1) {
    malformed(`${body.length - dataEnd - 1} bytes trail the Le field`, bytes);
  }

  const data = body.slice(1, dataEnd);
  const le = body.length === dataEnd + 1 ? shortLength(body[dataEnd] as number) : null;

  return { ...header, data, le, extended: false };
}

function decodeExtendedBody(
  header: Pick<IncomingApdu, 'cla' | 'ins' | 'p1' | 'p2'>,
  body: Uint8Array,
  bytes: Uint8Array,
): IncomingApdu {
  // `00 Le1 Le2`: extended case 2, no data field at all.
  if (body.length === 3) {
    const value = ((body[1] as number) << 8) | (body[2] as number);
    return {
      ...header,
      data: new Uint8Array(),
      le: value === 0 ? 65536 : value,
      extended: true,
    };
  }

  if (body.length < 3) {
    malformed('an extended length field is 3 bytes', bytes);
  }

  const lc = ((body[1] as number) << 8) | (body[2] as number);
  if (lc === 0) {
    malformed('extended Lc is zero, which is not a valid command', bytes);
  }

  const dataEnd = 3 + lc;
  if (body.length < dataEnd) {
    malformed(`extended Lc says ${lc} data bytes but only ${body.length - 3} are present`, bytes);
  }

  const data = body.slice(3, dataEnd);
  const trailing = body.length - dataEnd;

  if (trailing === 0) {
    return { ...header, data, le: null, extended: true };
  }
  if (trailing === 2) {
    const value = ((body[dataEnd] as number) << 8) | (body[dataEnd + 1] as number);
    return { ...header, data, le: value === 0 ? 65536 : value, extended: true };
  }

  malformed(`${trailing} bytes follow the data field, expected 0 or 2`, bytes);
}

/* -------------------------------------------------------------------------- */
/* Response APDUs                                                             */
/* -------------------------------------------------------------------------- */

/** A response carrying data, followed by its status word. */
export function encodeResponseApdu(data: Uint8Array, status: number = StatusWord.ok): Uint8Array {
  if (!Number.isInteger(status) || status < 0 || status > 0xffff) {
    throw invalidArgument(`A status word is two bytes; received ${status}.`);
  }

  const response = new Uint8Array(data.length + 2);
  response.set(data, 0);
  response[data.length] = (status >> 8) & 0xff;
  response[data.length + 1] = status & 0xff;
  return response;
}

/** A response that is nothing but a status word. */
export function statusResponse(status: number): Uint8Array {
  return encodeResponseApdu(new Uint8Array(), status);
}
