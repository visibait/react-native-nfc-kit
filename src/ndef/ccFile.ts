/**
 * Capability Container parsing for NFC Forum Type 4 tags (DESFire, Java Card
 * applets, and anything else that speaks ISO 7816 NDEF).
 *
 * On a Type 4 tag the NDEF message lives in its own elementary file, and the CC
 * file says which file that is, how large it may grow, and whether it is
 * readable and writable. Reading it first is what turns "SELECT some file id and
 * hope" into a defined sequence.
 *
 * ```
 * offset  size  meaning
 * 0       2     CCLEN, total length of the CC file
 * 2       1     mapping version, high nibble major / low nibble minor
 * 3       2     MLe, maximum bytes readable in one ReadBinary response
 * 5       2     MLc, maximum bytes writable in one UpdateBinary command
 * 7       ...   TLV blocks, one of which is the NDEF File Control TLV
 * ```
 *
 * The NDEF File Control TLV (tag 0x04, length 0x06) holds the file id, the
 * maximum NDEF file size, and one access byte each for read and write.
 */

import { ByteReader } from './bytes.js';
import { invalidArgument, ndefMalformed } from '../errors.js';

/** Smallest CC file that can hold the header plus one NDEF File Control TLV. */
export const MIN_CC_LENGTH = 15;

/** TLV tag of the NDEF File Control block inside a CC file. */
export const NDEF_FILE_CONTROL_TAG = 0x04;

/** Value length the NDEF File Control TLV is defined to have. */
const NDEF_FILE_CONTROL_LENGTH = 6;

/** Access byte value meaning "permitted without any security". */
const ACCESS_GRANTED = 0x00;

/** Access byte value meaning "never permitted". */
const ACCESS_DENIED = 0xff;

export interface MappingVersion {
  readonly major: number;
  readonly minor: number;
}

export interface NdefFileControl {
  /** Elementary file identifier to SELECT before reading the message. */
  readonly fileId: number;
  /** Maximum size the NDEF file may reach, including its 2-byte length prefix. */
  readonly maxFileSize: number;
  /** Raw read access condition byte. */
  readonly readAccess: number;
  /** Raw write access condition byte. */
  readonly writeAccess: number;
  /** Whether reading needs no additional security. */
  readonly readable: boolean;
  /**
   * Whether writing needs no additional security.
   *
   * `false` covers both "permanently locked" (0xFF) and "requires proprietary
   * authentication" (0x80..0xFE); {@link NdefFileControl.permanentlyReadOnly}
   * separates them.
   */
  readonly writable: boolean;
  /** Whether the tag has been locked read-only for good. */
  readonly permanentlyReadOnly: boolean;
}

export interface CapabilityContainer {
  /** CCLEN as stored on the tag. */
  readonly length: number;
  readonly mappingVersion: MappingVersion;
  /** Maximum bytes a single read response may return. */
  readonly maxReadSize: number;
  /** Maximum bytes a single write command may carry. */
  readonly maxWriteSize: number;
  /**
   * The NDEF File Control block, when present.
   *
   * A CC file with none is valid but useless for NDEF, so this is optional
   * rather than an error: the caller decides whether that is a failure.
   */
  readonly ndefFile: NdefFileControl | undefined;
  /** Any other TLV blocks, preserved rather than discarded. */
  readonly otherTlvs: readonly { readonly tag: number; readonly value: Uint8Array }[];
}

/**
 * Parses a CC file.
 *
 * `CCLEN` is honoured rather than trusted blindly: some tags return a fixed-size
 * buffer padded with zeros, so parsing continues only to the declared length. A
 * `CCLEN` longer than the data available is an error, because that means the read
 * was short and continuing would parse padding as structure.
 */
export function decodeCapabilityContainer(bytes: Uint8Array): CapabilityContainer {
  if (bytes.length < MIN_CC_LENGTH) {
    throw ndefMalformed(
      `Capability Container is ${bytes.length} bytes; at least ${MIN_CC_LENGTH} are required.`,
    );
  }

  const header = new ByteReader(bytes);
  const length = header.u16be('CCLEN');

  if (length < MIN_CC_LENGTH) {
    throw ndefMalformed(`CCLEN declares ${length} bytes, below the minimum of ${MIN_CC_LENGTH}.`);
  }
  if (length > bytes.length) {
    throw ndefMalformed(
      `CCLEN declares ${length} bytes but only ${bytes.length} were read; the read was short.`,
    );
  }

  const versionByte = header.u8('mapping version');
  const mappingVersion: MappingVersion = {
    major: (versionByte >> 4) & 0x0f,
    minor: versionByte & 0x0f,
  };

  const maxReadSize = header.u16be('MLe');
  const maxWriteSize = header.u16be('MLc');

  // Only the declared length is structure; anything past it is padding.
  const tlvArea = new ByteReader(bytes.subarray(header.position, length));

  let ndefFile: NdefFileControl | undefined;
  const otherTlvs: { tag: number; value: Uint8Array }[] = [];

  while (!tlvArea.exhausted) {
    const tag = tlvArea.u8('CC TLV tag');
    const tlvLength = tlvArea.u8('CC TLV length');
    const value = tlvArea.copy(tlvLength, `CC TLV 0x${tag.toString(16)} value`);

    if (tag === NDEF_FILE_CONTROL_TAG) {
      if (value.length !== NDEF_FILE_CONTROL_LENGTH) {
        throw ndefMalformed(
          `NDEF File Control TLV must hold ${NDEF_FILE_CONTROL_LENGTH} bytes, found ${value.length}.`,
        );
      }

      const control = new ByteReader(value);
      const fileId = control.u16be('NDEF file id');
      const maxFileSize = control.u16be('maximum NDEF file size');
      const readAccess = control.u8('read access');
      const writeAccess = control.u8('write access');

      ndefFile = {
        fileId,
        maxFileSize,
        readAccess,
        writeAccess,
        readable: readAccess === ACCESS_GRANTED,
        writable: writeAccess === ACCESS_GRANTED,
        permanentlyReadOnly: writeAccess === ACCESS_DENIED,
      };
    } else {
      otherTlvs.push({ tag, value });
    }
  }

  return { length, mappingVersion, maxReadSize, maxWriteSize, ndefFile, otherTlvs };
}

/* -------------------------------------------------------------------------- */
/* Building a CC file                                                         */
/* -------------------------------------------------------------------------- */

/** Default NDEF elementary file identifier, as used by every Type 4 tag. */
export const DEFAULT_NDEF_FILE_ID = 0xe104;

export interface CapabilityContainerInit {
  /** Elementary file identifier the reader should SELECT for the message. */
  readonly fileId: number;
  /** Largest the NDEF file may become, including its 2-byte length prefix. */
  readonly maxFileSize: number;
  /** MLe: most bytes one ReadBinary response may return. */
  readonly maxReadSize: number;
  /** MLc: most bytes one UpdateBinary command may carry. */
  readonly maxWriteSize: number;
  readonly writable: boolean;
  /** Defaults to 2.0, which is what a reader expects unless you know otherwise. */
  readonly mappingVersion?: MappingVersion;
}

function assertU16(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw invalidArgument(`${name} must be a 16-bit value; received ${value}.`);
  }
}

/**
 * Builds a CC file, for emulating a Type 4 tag rather than reading one.
 *
 * The counterpart of {@link decodeCapabilityContainer}, and tested against it:
 * every value written here is read back and compared, because a CC file is the
 * first thing a terminal reads and a wrong byte in it makes the card look absent
 * rather than broken.
 *
 * Only the NDEF File Control TLV is written. A CC file may carry others, but a
 * card emulating NDEF has nothing else to say, and the shortest correct answer is
 * the most interoperable one.
 */
export function encodeCapabilityContainer(init: CapabilityContainerInit): Uint8Array {
  assertU16('The NDEF file id', init.fileId);
  assertU16('The maximum NDEF file size', init.maxFileSize);
  assertU16('MLe', init.maxReadSize);
  assertU16('MLc', init.maxWriteSize);

  // 0x0000 and 0xFFFF are reserved by ISO 7816-4, and 0xE102/0xE103 are the CC
  // file's own identifiers. A reader that is told to select one of those looks
  // for a file that cannot be the message.
  if (init.fileId === 0x0000 || init.fileId === 0xffff || init.fileId === 0xe103) {
    throw invalidArgument(
      `0x${init.fileId.toString(16)} cannot be the NDEF file id: it is reserved. ` +
        `Use 0x${DEFAULT_NDEF_FILE_ID.toString(16)} unless a reader requires otherwise.`,
    );
  }
  // Two bytes hold the length, so a file smaller than that cannot hold an empty
  // message, let alone a message.
  if (init.maxFileSize < 2) {
    throw invalidArgument(
      `The maximum NDEF file size is ${init.maxFileSize}; it must be at least 2, for the length prefix.`,
    );
  }
  if (init.maxReadSize < 1 || init.maxWriteSize < 1) {
    throw invalidArgument('MLe and MLc must both be at least 1.');
  }

  const version = init.mappingVersion ?? { major: 2, minor: 0 };
  if (version.major > 0x0f || version.minor > 0x0f || version.major < 0 || version.minor < 0) {
    throw invalidArgument(
      `The mapping version is ${version.major}.${version.minor}; each half is a single nibble.`,
    );
  }

  const bytes = new Uint8Array(MIN_CC_LENGTH);
  const view = new DataView(bytes.buffer);

  view.setUint16(0, MIN_CC_LENGTH);
  bytes[2] = ((version.major & 0x0f) << 4) | (version.minor & 0x0f);
  view.setUint16(3, init.maxReadSize);
  view.setUint16(5, init.maxWriteSize);

  bytes[7] = NDEF_FILE_CONTROL_TAG;
  bytes[8] = NDEF_FILE_CONTROL_LENGTH;
  view.setUint16(9, init.fileId);
  view.setUint16(11, init.maxFileSize);
  bytes[13] = ACCESS_GRANTED;
  bytes[14] = init.writable ? ACCESS_GRANTED : ACCESS_DENIED;

  return bytes;
}
