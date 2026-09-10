/**
 * ISO 7816-4 APDUs.
 *
 * This is the layer that makes ISO-DEP tags -- DESFire, Java Card applets,
 * anything speaking ISO 14443-4 -- workable rather than merely reachable. It is
 * plain TypeScript over `Uint8Array` on top of a single `transceive` primitive,
 * so all of it is tested without hardware.
 *
 * Three things here are the difference between "sends bytes" and "talks to a
 * card", and all three are routinely left to the caller by NFC libraries:
 *
 * 1. **`61xx` responses.** The card is saying "I have xx more bytes, come and get
 *    them". Without a GET RESPONSE follow-up you get an empty body and a status
 *    word that looks like success.
 * 2. **`6Cxx` responses.** The card is saying "your Le was wrong, use xx". The
 *    exchange has to be repeated with the corrected length.
 * 3. **Command chaining.** A command whose data exceeds the frame is split across
 *    several APDUs with the chaining bit set in CLA.
 *
 * A caller who does not handle the first two sees intermittent failures that
 * depend on the card and the data size, which is a miserable thing to debug.
 */

import { ByteWriter, concatBytes } from '../ndef/bytes.js';
import { invalidArgument, NfcError } from '../errors.js';

/* -------------------------------------------------------------------------- */
/* Command APDUs                                                              */
/* -------------------------------------------------------------------------- */

export interface CommandApdu {
  /** Class byte. Bit 5 (0x10) is the chaining bit and is managed for you. */
  readonly cla: number;
  readonly ins: number;
  readonly p1: number;
  readonly p2: number;
  /** Command data. Omit for a command that sends none. */
  readonly data?: Uint8Array;
  /**
   * Expected response length, in bytes.
   *
   * `256` is the largest a short APDU can request and encodes as the byte `0x00`,
   * which is why this counts bytes rather than mirroring the encoding: `0` would
   * otherwise mean 256, and that has caught out everybody at least once. Omit it
   * for a command that expects no response body.
   */
  readonly le?: number;
}

export interface EncodeApduOptions {
  /**
   * Forces the extended-length form (3-byte Lc and Le).
   *
   * Extended APDUs are chosen automatically when the data or the expected length
   * does not fit the short form. Forcing them is for a card that requires them
   * even for small commands -- and note that not every card supports them, which
   * is what `historicalBytes` is for.
   */
  readonly extended?: boolean;
}

/** Largest response a short APDU can request. */
export const SHORT_MAX_LE = 256;
/** Largest command data a short APDU can carry. */
export const SHORT_MAX_LC = 255;
/** Largest response an extended APDU can request. */
export const EXTENDED_MAX_LE = 65536;
/** Largest command data an extended APDU can carry. */
export const EXTENDED_MAX_LC = 65535;

function assertByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw invalidArgument(`${name} must be an integer in 0..255, received ${value}.`);
  }
}

/**
 * Encodes a command APDU, choosing the short or extended form automatically.
 *
 * The four ISO 7816-4 cases fall out of which of `data` and `le` are present:
 * neither (case 1), `le` only (case 2), `data` only (case 3), both (case 4).
 */
export function encodeCommandApdu(
  command: CommandApdu,
  options: EncodeApduOptions = {},
): Uint8Array {
  assertByte('cla', command.cla);
  assertByte('ins', command.ins);
  assertByte('p1', command.p1);
  assertByte('p2', command.p2);

  const data = command.data ?? new Uint8Array(0);
  const { le } = command;

  if (le !== undefined) {
    if (!Number.isInteger(le) || le < 1 || le > EXTENDED_MAX_LE) {
      throw invalidArgument(
        `le must be an integer in 1..${EXTENDED_MAX_LE} (a byte count), received ${le}.`,
      );
    }
  }
  if (data.length > EXTENDED_MAX_LC) {
    throw invalidArgument(
      `Command data is ${data.length} bytes; an APDU carries at most ${EXTENDED_MAX_LC}. ` +
        'Use sendApduChained to split it across chained commands.',
    );
  }

  const needsExtended =
    options.extended === true ||
    data.length > SHORT_MAX_LC ||
    (le !== undefined && le > SHORT_MAX_LE);

  const writer = new ByteWriter(data.length + 10);
  writer.u8(command.cla).u8(command.ins).u8(command.p1).u8(command.p2);

  if (needsExtended) {
    // The extended form starts with a 0x00 marker, then 2-byte lengths. When
    // there is no data the marker belongs to Le instead, which is why it is only
    // written once.
    if (data.length > 0) {
      writer.u8(0x00).u16be(data.length).bytes(data);
      if (le !== undefined) {
        writer.u16be(le === EXTENDED_MAX_LE ? 0 : le);
      }
    } else if (le !== undefined) {
      writer.u8(0x00).u16be(le === EXTENDED_MAX_LE ? 0 : le);
    }
    return writer.toBytes();
  }

  if (data.length > 0) {
    writer.u8(data.length).bytes(data);
  }
  if (le !== undefined) {
    // 256 is encoded as 0x00; every other value is itself.
    writer.u8(le === SHORT_MAX_LE ? 0 : le);
  }
  return writer.toBytes();
}

/* -------------------------------------------------------------------------- */
/* Response APDUs                                                             */
/* -------------------------------------------------------------------------- */

export interface ResponseApdu {
  /** Response body, with the status word removed. */
  readonly data: Uint8Array;
  readonly sw1: number;
  readonly sw2: number;
  /** `sw1 << 8 | sw2`, e.g. `0x9000`. */
  readonly status: number;
  /** The status word as four lowercase hex digits. */
  readonly statusHex: string;
  /** Whether the status word is exactly `9000`. */
  readonly ok: boolean;
}

/** Status word meaning "success". */
export const SW_SUCCESS = 0x9000;

export function decodeResponseApdu(bytes: Uint8Array): ResponseApdu {
  if (bytes.length < 2) {
    throw new NfcError({
      code: 'transceiveFailed',
      message: `An APDU response is ${bytes.length} byte(s); a status word needs at least 2.`,
    });
  }

  const sw1 = bytes[bytes.length - 2] as number;
  const sw2 = bytes[bytes.length - 1] as number;
  const status = (sw1 << 8) | sw2;

  return {
    data: bytes.subarray(0, bytes.length - 2),
    sw1,
    sw2,
    status,
    statusHex: status.toString(16).padStart(4, '0'),
    ok: status === SW_SUCCESS,
  };
}

/**
 * A human-readable description of a status word.
 *
 * Covers the ISO 7816-4 values a card actually returns. An unrecognised word is
 * described by its class rather than guessed at, because a proprietary word means
 * whatever the applet's documentation says it means.
 */
export function describeStatusWord(status: number): string {
  const known: Record<number, string> = {
    0x9000: 'Success',
    0x6200: 'Warning: no information given, state unchanged',
    0x6281: 'Warning: returned data may be corrupted',
    0x6282: 'Warning: end of file reached before reading Le bytes',
    0x6283: 'Warning: selected file is deactivated',
    0x6284: 'Warning: file control information is not formatted correctly',
    0x6300: 'Warning: no information given, state changed',
    0x6581: 'Memory failure',
    0x6700: 'Wrong length',
    0x6800: 'Functions in CLA not supported',
    0x6881: 'Logical channel not supported',
    0x6882: 'Secure messaging not supported',
    0x6900: 'Command not allowed',
    0x6981: 'Command incompatible with file structure',
    0x6982: 'Security status not satisfied: authenticate first',
    0x6983: 'Authentication method blocked',
    0x6984: 'Referenced data is invalidated',
    0x6985: 'Conditions of use not satisfied',
    0x6986: 'Command not allowed: no current file selected',
    0x6987: 'Expected secure messaging data objects are missing',
    0x6988: 'Secure messaging data objects are incorrect',
    0x6a80: 'Incorrect parameters in the command data',
    0x6a81: 'Function not supported',
    0x6a82: 'File or application not found',
    0x6a83: 'Record not found',
    0x6a84: 'Not enough memory space in the file',
    0x6a85: 'Command length inconsistent with the TLV structure',
    0x6a86: 'Incorrect P1 or P2',
    0x6a87: 'Command length inconsistent with P1 or P2',
    0x6a88: 'Referenced data or reference data not found',
    0x6a89: 'File already exists',
    0x6a8a: 'File name already exists',
    0x6b00: 'Wrong parameters P1 or P2',
    0x6d00: 'Instruction code not supported or invalid',
    0x6e00: 'Class not supported',
    0x6f00: 'No precise diagnosis',
  };

  const description = known[status];
  if (description !== undefined) {
    return description;
  }

  const sw1 = (status >> 8) & 0xff;
  const sw2 = status & 0xff;

  if (sw1 === 0x61) {
    return `${sw2} more byte(s) available; issue GET RESPONSE`;
  }
  if (sw1 === 0x6c) {
    return `Wrong Le; the card expects ${sw2 === 0 ? 256 : sw2}`;
  }
  if (sw1 === 0x63 && (sw2 & 0xf0) === 0xc0) {
    return `Verification failed, ${sw2 & 0x0f} attempt(s) remaining`;
  }
  if (sw1 >= 0x62 && sw1 <= 0x6f) {
    return 'Error, defined by the card';
  }
  return 'Proprietary status word; see the applet documentation';
}

/* -------------------------------------------------------------------------- */
/* Exchange                                                                   */
/* -------------------------------------------------------------------------- */

/** Sends bytes to the tag and returns the raw response, status word included. */
export type ApduTransport = (apdu: Uint8Array) => Promise<Uint8Array>;

export interface SendApduOptions extends EncodeApduOptions {
  /**
   * Follows up a `61xx` response with GET RESPONSE, concatenating the parts.
   * Defaults to `true`.
   */
  readonly followGetResponse?: boolean;
  /**
   * Repeats the command with the corrected length after a `6Cxx`. Defaults to
   * `true`.
   */
  readonly retryWrongLength?: boolean;
  /**
   * How many follow-up exchanges to allow before giving up.
   *
   * A card that keeps answering `61xx` forever would otherwise loop until the
   * session times out with nothing to show for it. Defaults to 32, which is far
   * more than any real exchange needs.
   */
  readonly maxFollowUps?: number;
}

const GET_RESPONSE_INS = 0xc0;
const DEFAULT_MAX_FOLLOW_UPS = 32;

/**
 * Sends a command APDU and returns the complete response.
 *
 * Handles `61xx` and `6Cxx` transparently, so the returned status word is the
 * card's actual verdict rather than a protocol detail, and the returned data is
 * everything the card had to say rather than the first frame of it.
 */
export async function sendApdu(
  transport: ApduTransport,
  command: CommandApdu,
  options: SendApduOptions = {},
): Promise<ResponseApdu> {
  const followGetResponse = options.followGetResponse !== false;
  const retryWrongLength = options.retryWrongLength !== false;
  const maxFollowUps = options.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS;

  if (!Number.isInteger(maxFollowUps) || maxFollowUps < 0) {
    throw invalidArgument(`maxFollowUps must be a non-negative integer, received ${maxFollowUps}.`);
  }

  let response = decodeResponseApdu(await transport(encodeCommandApdu(command, options)));
  const collected: Uint8Array[] = [];
  let followUps = 0;

  for (;;) {
    // 6Cxx: the card rejected the expected length and named the right one.
    if (retryWrongLength && response.sw1 === 0x6c) {
      if (followUps >= maxFollowUps) {
        throw tooManyFollowUps(maxFollowUps, response);
      }
      followUps += 1;
      const corrected: CommandApdu = {
        ...command,
        le: response.sw2 === 0 ? SHORT_MAX_LE : response.sw2,
      };
      response = decodeResponseApdu(await transport(encodeCommandApdu(corrected, options)));
      continue;
    }

    // 61xx: more data is waiting behind a GET RESPONSE.
    if (followGetResponse && response.sw1 === 0x61) {
      if (followUps >= maxFollowUps) {
        throw tooManyFollowUps(maxFollowUps, response);
      }
      followUps += 1;
      collected.push(response.data);

      const getResponse: CommandApdu = {
        // The class byte is carried over so a logical channel or secure-messaging
        // bit set on the original command is not silently dropped here.
        cla: command.cla,
        ins: GET_RESPONSE_INS,
        p1: 0x00,
        p2: 0x00,
        le: response.sw2 === 0 ? SHORT_MAX_LE : response.sw2,
      };
      response = decodeResponseApdu(await transport(encodeCommandApdu(getResponse, options)));
      continue;
    }

    break;
  }

  if (collected.length === 0) {
    return response;
  }

  return { ...response, data: concatBytes(...collected, response.data) };
}

/** Chaining bit in the class byte: "more command data follows". */
export const CLA_CHAINING = 0x10;

export interface SendApduChainedOptions extends SendApduOptions {
  /**
   * Largest data chunk per command, in bytes. Defaults to 255, the short-APDU
   * maximum.
   *
   * Worth lowering for a card whose frame size is smaller than that; the tag's
   * `maxTransceiveLength` is the number to look at.
   */
  readonly chunkSize?: number;
}

/**
 * Sends a command whose data is too large for one APDU, using command chaining.
 *
 * Every chunk but the last is sent with the chaining bit set in the class byte,
 * and the card acknowledges each one. Only the last carries the expected length,
 * because only the last produces a response body.
 *
 * A chunk the card rejects stops the sequence immediately and returns its status
 * word: continuing to push data at a card that has already said no would at best
 * waste time and at worst leave it in a state the next command does not expect.
 */
export async function sendApduChained(
  transport: ApduTransport,
  command: CommandApdu,
  options: SendApduChainedOptions = {},
): Promise<ResponseApdu> {
  const chunkSize = options.chunkSize ?? SHORT_MAX_LC;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > EXTENDED_MAX_LC) {
    throw invalidArgument(
      `chunkSize must be an integer in 1..${EXTENDED_MAX_LC}, received ${chunkSize}.`,
    );
  }

  const data = command.data ?? new Uint8Array(0);
  if (data.length <= chunkSize) {
    return sendApdu(transport, command, options);
  }

  for (let offset = 0; offset + chunkSize < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, offset + chunkSize);
    const response = await sendApdu(
      transport,
      {
        cla: command.cla | CLA_CHAINING,
        ins: command.ins,
        p1: command.p1,
        p2: command.p2,
        data: chunk,
      },
      options,
    );

    if (!response.ok) {
      return response;
    }
  }

  const lastChunkStart = data.length - (data.length % chunkSize || chunkSize);
  return sendApdu(
    transport,
    { ...command, cla: command.cla, data: data.subarray(lastChunkStart) },
    options,
  );
}

function tooManyFollowUps(limit: number, response: ResponseApdu): NfcError {
  return new NfcError({
    code: 'transceiveFailed',
    message:
      `The card is still asking for follow-up exchanges after ${limit} of them ` +
      `(last status ${response.statusHex}: ${describeStatusWord(response.status)}). ` +
      'Raise maxFollowUps if this is expected, but it usually means the card is stuck.',
  });
}

/* -------------------------------------------------------------------------- */
/* Common commands                                                            */
/* -------------------------------------------------------------------------- */

/**
 * SELECT by name, which is how an application is chosen by AID.
 *
 * On iOS the AID must also appear in the app's
 * `com.apple.developer.nfc.readersession.iso7816.select-identifiers` list, or the
 * tag never reaches the app at all.
 */
export function selectByName(aid: Uint8Array, options: { first?: boolean } = {}): CommandApdu {
  if (aid.length === 0 || aid.length > 16) {
    throw invalidArgument(`An AID is 1..16 bytes; received ${aid.length}.`);
  }
  return {
    cla: 0x00,
    ins: 0xa4,
    p1: 0x04,
    // 0x00 selects the first or only occurrence, 0x02 the next one.
    p2: options.first === false ? 0x02 : 0x00,
    data: aid,
    le: SHORT_MAX_LE,
  };
}

/** SELECT by file identifier, used to walk a Type 4 tag's file structure. */
export function selectByFileId(fileId: number): CommandApdu {
  if (!Number.isInteger(fileId) || fileId < 0 || fileId > 0xffff) {
    throw invalidArgument(`A file identifier is a 16-bit value; received ${fileId}.`);
  }
  return {
    cla: 0x00,
    ins: 0xa4,
    p1: 0x00,
    p2: 0x0c,
    data: new Uint8Array([(fileId >> 8) & 0xff, fileId & 0xff]),
  };
}

/** READ BINARY from the currently selected file. */
export function readBinary(offset: number, length: number): CommandApdu {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0x7fff) {
    throw invalidArgument(
      `A READ BINARY offset is 0..32767 when carried in P1-P2; received ${offset}.`,
    );
  }
  if (!Number.isInteger(length) || length < 1 || length > EXTENDED_MAX_LE) {
    throw invalidArgument(`A READ BINARY length is 1..${EXTENDED_MAX_LE}; received ${length}.`);
  }
  return {
    cla: 0x00,
    ins: 0xb0,
    p1: (offset >> 8) & 0x7f,
    p2: offset & 0xff,
    le: length,
  };
}

/** UPDATE BINARY into the currently selected file. */
export function updateBinary(offset: number, data: Uint8Array): CommandApdu {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0x7fff) {
    throw invalidArgument(
      `An UPDATE BINARY offset is 0..32767 when carried in P1-P2; received ${offset}.`,
    );
  }
  if (data.length === 0) {
    throw invalidArgument('UPDATE BINARY needs at least one byte to write.');
  }
  return {
    cla: 0x00,
    ins: 0xd6,
    p1: (offset >> 8) & 0x7f,
    p2: offset & 0xff,
    data,
  };
}
