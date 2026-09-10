/**
 * FeliCa (NFC-F) commands: Suica, PASMO, Octopus, FeliCa Lite-S.
 *
 * Unlike ISO 15693, this one is symmetric: Android's `NfcF.transceive` and
 * CoreNFC's `sendFeliCaCommand` both take a complete command packet, so
 * everything here works identically on both platforms.
 *
 * ## Packet layout
 *
 * ```
 * request:   len | command | IDm(8) | parameters
 * response:  len | response code | IDm(8) | data
 * ```
 *
 * Two things catch people out, and both are handled here rather than left to the
 * caller:
 *
 * 1. **The length byte counts itself.** A packet of eleven bytes starts with
 *    `0x0B`, not `0x0A`. Getting it wrong produces a tag that simply does not
 *    answer, with nothing to diagnose.
 * 2. **A response code is the command code plus one.** Read Without Encryption is
 *    `0x06` and its answer is `0x07`, so a mismatch means the tag answered a
 *    different question -- worth noticing rather than parsing regardless.
 *
 * Service codes and block numbers travel **little-endian**, which is the opposite
 * of almost everything else in NFC.
 */

import { ByteWriter } from '../ndef/bytes.js';
import { invalidArgument, NfcError } from '../errors.js';

/** Sends a complete FeliCa packet and returns the response packet. */
export type FelicaTransport = (packet: Uint8Array) => Promise<Uint8Array>;

/** Bytes in a FeliCa manufacture identifier. */
export const IDM_SIZE = 8;
/** Bytes in a FeliCa data block. */
export const BLOCK_SIZE = 16;
/** Largest packet the length byte can describe. */
export const MAX_PACKET_SIZE = 0xff;

export const FelicaCommand = {
  polling: 0x00,
  requestService: 0x02,
  requestResponse: 0x04,
  readWithoutEncryption: 0x06,
  writeWithoutEncryption: 0x08,
  requestSystemCode: 0x0c,
} as const;

export type FelicaCommand = (typeof FelicaCommand)[keyof typeof FelicaCommand];

/* -------------------------------------------------------------------------- */
/* Packets                                                                    */
/* -------------------------------------------------------------------------- */

function assertIdm(idm: Uint8Array): void {
  if (idm.length !== IDM_SIZE) {
    throw invalidArgument(`A FeliCa IDm is ${IDM_SIZE} bytes; received ${idm.length}.`);
  }
}

/**
 * Builds a command packet, computing the leading length byte.
 *
 * `idm` is omitted only for Polling, which is a broadcast and so cannot address
 * a particular tag.
 */
export function buildPacket(
  command: number,
  idm: Uint8Array | null,
  parameters: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (!Number.isInteger(command) || command < 0 || command > 0xff) {
    throw invalidArgument(`A FeliCa command code is a single byte; received ${command}.`);
  }
  if (idm !== null) {
    assertIdm(idm);
  }

  // The length byte counts itself, which is the detail that silently breaks
  // hand-built packets.
  const length = 1 + 1 + (idm?.length ?? 0) + parameters.length;
  if (length > MAX_PACKET_SIZE) {
    throw invalidArgument(
      `A FeliCa packet is at most ${MAX_PACKET_SIZE} bytes including its length byte; this one ` +
        `would be ${length}. Split the request across several commands.`,
    );
  }

  const writer = new ByteWriter(length);
  writer.u8(length).u8(command);
  if (idm !== null) {
    writer.bytes(idm);
  }
  writer.bytes(parameters);

  return writer.toBytes();
}

export interface FelicaResponse {
  readonly responseCode: number;
  readonly idm: Uint8Array;
  /** Everything after the IDm. */
  readonly data: Uint8Array;
}

/**
 * Splits a response packet, checking its length byte and response code.
 *
 * `expectedCommand` is the code that was sent; the answer must be that plus one.
 * A mismatch means the tag answered something else, which is worth reporting
 * rather than parsing as if it were the expected reply.
 */
export function parsePacket(packet: Uint8Array, expectedCommand?: number): FelicaResponse {
  if (packet.length < 2 + IDM_SIZE) {
    throw new NfcError({
      code: 'transceiveFailed',
      message:
        `A FeliCa response is at least ${2 + IDM_SIZE} bytes (length, code and IDm); ` +
        `received ${packet.length}.`,
    });
  }

  const declared = packet[0] as number;
  if (declared !== packet.length) {
    throw new NfcError({
      code: 'transceiveFailed',
      message:
        `The response says it is ${declared} bytes but ${packet.length} arrived. The length byte ` +
        'counts itself, so a mismatch usually means a truncated or padded frame.',
    });
  }

  const responseCode = packet[1] as number;
  if (expectedCommand !== undefined && responseCode !== expectedCommand + 1) {
    throw new NfcError({
      code: 'transceiveFailed',
      message:
        `The tag replied with code 0x${responseCode.toString(16).padStart(2, '0')}, but command ` +
        `0x${expectedCommand.toString(16).padStart(2, '0')} is answered by ` +
        `0x${(expectedCommand + 1).toString(16).padStart(2, '0')}.`,
    });
  }

  return {
    responseCode,
    idm: packet.subarray(2, 2 + IDM_SIZE),
    data: packet.subarray(2 + IDM_SIZE),
  };
}

/** Sends a command and returns the parsed response. */
export async function sendCommand(
  transport: FelicaTransport,
  command: number,
  idm: Uint8Array | null,
  parameters?: Uint8Array,
): Promise<FelicaResponse> {
  const response = await transport(buildPacket(command, idm, parameters));
  return parsePacket(response, command);
}

/* -------------------------------------------------------------------------- */
/* Status flags                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Raises the tag's error when the status flags report one.
 *
 * Status flag 1 is zero on success. Anything else is a refusal, and flag 2 says
 * why -- so returning the block data regardless would hand back whatever happened
 * to be in the frame.
 */
export function assertStatusOk(flag1: number, flag2: number, what: string): void {
  if (flag1 === 0x00) {
    return;
  }

  throw new NfcError({
    code: flag1 === 0xff ? 'authenticationFailed' : 'ioError',
    message:
      `${what} was refused by the tag (status ${flag1.toString(16).padStart(2, '0')}` +
      `${flag2.toString(16).padStart(2, '0')}). ` +
      (flag1 === 0xff
        ? 'A status flag of FF usually means the service or block is not accessible without authentication.'
        : 'The second flag identifies which block or service the tag objected to.'),
    nativeCode: `felica:${flag1.toString(16).padStart(2, '0')}${flag2.toString(16).padStart(2, '0')}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Block descriptors                                                          */
/* -------------------------------------------------------------------------- */

export interface BlockDescriptor {
  /** Block number within the service. */
  readonly block: number;
  /** Which entry of the service code list this block belongs to. Defaults to 0. */
  readonly serviceIndex?: number;
  /** Access mode. `0` is normal; purse services use other values. */
  readonly accessMode?: number;
}

/**
 * Encodes a block list element.
 *
 * Two bytes when the block number fits in one, three otherwise -- the top bit of
 * the first byte says which, and the longer form carries the number
 * little-endian.
 */
export function encodeBlockDescriptor(descriptor: BlockDescriptor): Uint8Array {
  const { block } = descriptor;
  const serviceIndex = descriptor.serviceIndex ?? 0;
  const accessMode = descriptor.accessMode ?? 0;

  if (!Number.isInteger(block) || block < 0 || block > 0xffff) {
    throw invalidArgument(`A block number is 0..65535; received ${block}.`);
  }
  if (!Number.isInteger(serviceIndex) || serviceIndex < 0 || serviceIndex > 0x0f) {
    throw invalidArgument(`A service index is 0..15; received ${serviceIndex}.`);
  }
  if (!Number.isInteger(accessMode) || accessMode < 0 || accessMode > 0x07) {
    throw invalidArgument(`An access mode is 0..7; received ${accessMode}.`);
  }

  const head = (accessMode << 4) | serviceIndex;

  if (block <= 0xff) {
    // The top bit set means the short, two-byte form.
    return new Uint8Array([0x80 | head, block]);
  }
  return new Uint8Array([head, block & 0xff, (block >> 8) & 0xff]);
}

function encodeServiceCodes(serviceCodes: readonly number[]): Uint8Array {
  if (serviceCodes.length === 0 || serviceCodes.length > 0x0f) {
    throw invalidArgument(
      `A service code list holds 1..15 entries; received ${serviceCodes.length}.`,
    );
  }

  const out = new Uint8Array(serviceCodes.length * 2);
  serviceCodes.forEach((code, index) => {
    if (!Number.isInteger(code) || code < 0 || code > 0xffff) {
      throw invalidArgument(`A service code is a 16-bit value; received ${code}.`);
    }
    // Little-endian, unlike almost everything else in NFC.
    out[index * 2] = code & 0xff;
    out[index * 2 + 1] = (code >> 8) & 0xff;
  });
  return out;
}

function concatDescriptors(blocks: readonly BlockDescriptor[]): Uint8Array {
  if (blocks.length === 0 || blocks.length > 0xff) {
    throw invalidArgument(`A block list holds 1..255 entries; received ${blocks.length}.`);
  }

  const encoded = blocks.map(encodeBlockDescriptor);
  const total = encoded.reduce((sum, element) => sum + element.length, 0);
  const out = new Uint8Array(total);

  let offset = 0;
  for (const element of encoded) {
    out.set(element, offset);
    offset += element.length;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads blocks without encryption.
 *
 * Returns one 16-byte block per descriptor, in the order asked for.
 */
export async function readWithoutEncryption(
  transport: FelicaTransport,
  idm: Uint8Array,
  serviceCodes: readonly number[],
  blocks: readonly BlockDescriptor[],
): Promise<Uint8Array[]> {
  const services = encodeServiceCodes(serviceCodes);
  const blockList = concatDescriptors(blocks);

  const parameters = new Uint8Array(1 + services.length + 1 + blockList.length);
  parameters[0] = serviceCodes.length;
  parameters.set(services, 1);
  parameters[1 + services.length] = blocks.length;
  parameters.set(blockList, 2 + services.length);

  const { data } = await sendCommand(
    transport,
    FelicaCommand.readWithoutEncryption,
    idm,
    parameters,
  );

  if (data.length < 2) {
    throw new NfcError({
      code: 'transceiveFailed',
      message: 'The read response carries no status flags.',
    });
  }

  assertStatusOk(data[0] as number, data[1] as number, 'Reading blocks');

  if (data.length < 3) {
    throw new NfcError({
      code: 'transceiveFailed',
      message: 'The read succeeded but the response does not say how many blocks it contains.',
    });
  }

  const blockCount = data[2] as number;
  const expected = 3 + blockCount * BLOCK_SIZE;
  if (data.length < expected) {
    throw new NfcError({
      code: 'transceiveFailed',
      message:
        `The response claims ${blockCount} block(s), which needs ${expected} bytes, but only ` +
        `${data.length} arrived.`,
    });
  }

  const out: Uint8Array[] = [];
  for (let i = 0; i < blockCount; i += 1) {
    const start = 3 + i * BLOCK_SIZE;
    out.push(data.subarray(start, start + BLOCK_SIZE));
  }
  return out;
}

/**
 * Writes blocks without encryption.
 *
 * One 16-byte block of data per descriptor; a mismatch is rejected here rather
 * than producing a packet the tag silently ignores.
 */
export async function writeWithoutEncryption(
  transport: FelicaTransport,
  idm: Uint8Array,
  serviceCodes: readonly number[],
  blocks: readonly BlockDescriptor[],
  blockData: readonly Uint8Array[],
): Promise<void> {
  if (blockData.length !== blocks.length) {
    throw invalidArgument(
      `Got ${blocks.length} block descriptor(s) but ${blockData.length} block(s) of data; they must match.`,
    );
  }
  for (const [index, block] of blockData.entries()) {
    if (block.length !== BLOCK_SIZE) {
      throw invalidArgument(
        `A FeliCa block is exactly ${BLOCK_SIZE} bytes; block ${index} is ${block.length}.`,
      );
    }
  }

  const services = encodeServiceCodes(serviceCodes);
  const blockList = concatDescriptors(blocks);

  const parameters = new Uint8Array(
    1 + services.length + 1 + blockList.length + blockData.length * BLOCK_SIZE,
  );
  parameters[0] = serviceCodes.length;
  parameters.set(services, 1);
  parameters[1 + services.length] = blocks.length;
  parameters.set(blockList, 2 + services.length);

  let offset = 2 + services.length + blockList.length;
  for (const block of blockData) {
    parameters.set(block, offset);
    offset += BLOCK_SIZE;
  }

  const { data } = await sendCommand(
    transport,
    FelicaCommand.writeWithoutEncryption,
    idm,
    parameters,
  );

  if (data.length < 2) {
    throw new NfcError({
      code: 'transceiveFailed',
      message: 'The write response carries no status flags.',
    });
  }
  assertStatusOk(data[0] as number, data[1] as number, 'Writing blocks');
}

export interface PollingResult {
  readonly idm: Uint8Array;
  /** Manufacture parameter: timing and capability information. */
  readonly pmm: Uint8Array;
  /** The request data the tag returned, when one was asked for. */
  readonly requestData: Uint8Array | null;
}

/**
 * Polls for a tag of a given system code.
 *
 * A broadcast, so it carries no IDm -- it is how you learn one. `0xFFFF` matches
 * any system. On iOS the system code must also be declared in Info.plist under
 * `com.apple.developer.nfc.readersession.felica.systemcodes`, or the tag never
 * reaches the app.
 */
export async function polling(
  transport: FelicaTransport,
  systemCode = 0xffff,
  options: { requestCode?: number; timeSlot?: number } = {},
): Promise<PollingResult> {
  if (!Number.isInteger(systemCode) || systemCode < 0 || systemCode > 0xffff) {
    throw invalidArgument(`A system code is a 16-bit value; received ${systemCode}.`);
  }

  const requestCode = options.requestCode ?? 0x00;
  const timeSlot = options.timeSlot ?? 0x00;

  // The system code travels most-significant byte first here, unlike service
  // codes and block numbers elsewhere in the protocol.
  const parameters = new Uint8Array([
    (systemCode >> 8) & 0xff,
    systemCode & 0xff,
    requestCode,
    timeSlot,
  ]);

  const { idm, data } = await sendCommand(transport, FelicaCommand.polling, null, parameters);

  if (data.length < 8) {
    throw new NfcError({
      code: 'transceiveFailed',
      message: `A polling response carries an 8-byte PMm; only ${data.length} byte(s) followed the IDm.`,
    });
  }

  return {
    idm,
    pmm: data.subarray(0, 8),
    requestData: data.length > 8 ? data.subarray(8) : null,
  };
}

/** Asks the tag which system codes it supports. */
export async function requestSystemCode(
  transport: FelicaTransport,
  idm: Uint8Array,
): Promise<number[]> {
  const { data } = await sendCommand(transport, FelicaCommand.requestSystemCode, idm);

  if (data.length < 1) {
    throw new NfcError({
      code: 'transceiveFailed',
      message: 'The response does not say how many system codes follow.',
    });
  }

  const count = data[0] as number;
  if (data.length < 1 + count * 2) {
    throw new NfcError({
      code: 'transceiveFailed',
      message: `The response claims ${count} system code(s) but is too short to hold them.`,
    });
  }

  const codes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    // System codes come back most-significant byte first.
    codes.push(((data[1 + i * 2] as number) << 8) | (data[2 + i * 2] as number));
  }
  return codes;
}
