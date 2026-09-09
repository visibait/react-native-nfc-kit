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

import { ByteReader } from './bytes';
import { ndefMalformed } from '../errors';

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
