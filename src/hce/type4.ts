/**
 * An NFC Forum Type 4 tag, emulated.
 *
 * This is the card a terminal sees when an app emulates NDEF: the same command
 * sequence a real DESFire or NTAG 424 answers, so an off-the-shelf reader, another
 * phone, or a door controller expecting a tag will read it without knowing it is
 * talking to software.
 *
 * The sequence a reader performs, and what each step is for:
 *
 * 1. `SELECT` by name with the NDEF application AID `D2760000850101`. "Is there
 *    an NDEF application here?"
 * 2. `SELECT` the CC file, `0xE103`, then `READ BINARY`. "How big can the message
 *    be, where does it live, and may I write it?"
 * 3. `SELECT` the NDEF file the CC named, then `READ BINARY` for two bytes, which
 *    are the message length, then again for the message.
 * 4. Optionally `UPDATE BINARY` to replace it.
 *
 * Readers do step 3 in two reads because the length has to be known before the
 * body can be asked for, and they will do it in several chunks when the message
 * is larger than the `MLe` the CC advertised. Both are handled here.
 *
 * No platform involved: bytes in, bytes out, so it can be driven entirely from
 * tests and is held to full coverage. The same object works unchanged behind
 * Android's HCE service and behind anything else that can carry APDUs.
 */

import { invalidArgument } from '../errors.js';
import { DEFAULT_NDEF_FILE_ID, encodeCapabilityContainer } from '../ndef/ccFile.js';
import {
  decodeCommandApdu,
  encodeResponseApdu,
  Instruction,
  SELECT_BY_FILE_ID,
  SELECT_BY_NAME,
  statusResponse,
  StatusWord,
  type IncomingApdu,
} from './apdu.js';

/** The AID a reader selects to ask for the NDEF application. */
export const NDEF_APPLICATION_AID = new Uint8Array([0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01]);

/** File identifier of the Capability Container, fixed by the specification. */
export const CC_FILE_ID = 0xe103;

/**
 * Default `MLe` and `MLc`, taken from what NXP's own Type 4 products advertise.
 *
 * Numbers a reader has certainly met before, rather than invented ones: 251 data
 * bytes plus a status word fits a single ISO-DEP frame at the frame size readers
 * negotiate, and 255 is the most a short command APDU can carry.
 */
export const DEFAULT_MAX_READ_SIZE = 0x00fb;
export const DEFAULT_MAX_WRITE_SIZE = 0x00ff;

/** Which file the reader has currently selected. */
type Selection = 'none' | 'cc' | 'ndef';

export interface Type4CardOptions {
  /** The encoded NDEF message to serve. Build it with `encodeMessage`. */
  readonly message: Uint8Array;
  /**
   * Whether a reader may replace the message.
   *
   * `false` advertises the file as permanently read-only, so a reader does not
   * offer writing and does not try. Defaults to `false`: a card that silently
   * accepts writes is rarely what an app meant to expose.
   */
  readonly writable?: boolean;
  /**
   * Bytes available for the message, excluding its 2-byte length prefix.
   *
   * Defaults to the message's own length, which is the honest answer for a
   * read-only card. Set it higher to leave room for a reader to write something
   * larger. The capacity advertised is exactly what will be accepted -- a card
   * that claims room it does not have fails the write half-way, and a partly
   * written message is worse than a refused one.
   */
  readonly capacity?: number;
  /** MLe. Lower it only for a reader that cannot cope with the default. */
  readonly maxReadSize?: number;
  /** MLc. */
  readonly maxWriteSize?: number;
  /** NDEF elementary file id. There is no good reason to change this. */
  readonly fileId?: number;
}

export interface Type4Card {
  /**
   * Answers one command APDU.
   *
   * Never throws: a card cannot throw at a terminal, it can only answer with a
   * status word. A command this card does not implement is answered
   * `instructionNotSupported`, and a malformed frame `wrongLength`, which is what
   * a real card does and what a reader knows how to report.
   */
  handle(command: Uint8Array): Uint8Array;
  /** The message currently held, including anything a reader wrote. */
  readonly message: Uint8Array;
  /** Replaces the message from the app's side. */
  setMessage(message: Uint8Array): void;
  /** Clears the selection state. Call when the field is lost. */
  deactivate(): void;
  /** Whether the reader has selected the NDEF application. */
  readonly selected: boolean;
}

function isSelectByName(apdu: IncomingApdu): boolean {
  return apdu.ins === Instruction.select && apdu.p1 === SELECT_BY_NAME;
}

function isSelectByFileId(apdu: IncomingApdu): boolean {
  return apdu.ins === Instruction.select && apdu.p1 === SELECT_BY_FILE_ID;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Builds the emulated card.
 *
 * ```ts
 * const card = createType4Card({
 *   message: encodeMessage([createUriRecord('https://www.ventry.es/entrada')]),
 * });
 * const session = await hce.start({ onCommand: (apdu) => card.handle(apdu) });
 * ```
 */
export function createType4Card(options: Type4CardOptions): Type4Card {
  const writable = options.writable ?? false;
  const fileId = options.fileId ?? DEFAULT_NDEF_FILE_ID;
  const maxReadSize = options.maxReadSize ?? DEFAULT_MAX_READ_SIZE;
  const maxWriteSize = options.maxWriteSize ?? DEFAULT_MAX_WRITE_SIZE;
  const capacity = options.capacity ?? options.message.length;

  if (capacity < options.message.length) {
    throw invalidArgument(
      `The capacity is ${capacity} bytes but the message is ${options.message.length}. ` +
        'A card cannot advertise less room than it is already holding.',
    );
  }

  // Built once: the CC file is fixed for the life of the card, and rebuilding it
  // per command would let it drift from what was advertised.
  const ccFile = encodeCapabilityContainer({
    fileId,
    // The length prefix lives inside the file, so the advertised size includes it.
    maxFileSize: capacity + 2,
    maxReadSize,
    maxWriteSize,
    writable,
  });

  /**
   * The NDEF file exactly as a reader sees it: a 2-byte length, then the body,
   * padded to the advertised capacity.
   *
   * The file is the state, not the message. That matters because of the sequence
   * a reader uses to write: length zero, then the body, then the real length --
   * so that the message is never readable half-written. Deriving the file from a
   * stored message would discard the body write, since at that moment the
   * declared length is still zero.
   */
  const file = new Uint8Array(capacity + 2);
  let selection: Selection = 'none';
  let applicationSelected = false;

  function writeFile(body: Uint8Array): void {
    file.fill(0);
    file[0] = (body.length >> 8) & 0xff;
    file[1] = body.length & 0xff;
    file.set(body, 2);
  }

  function declaredLength(source: Uint8Array = file): number {
    return ((source[0] as number) << 8) | (source[1] as number);
  }

  function currentMessage(): Uint8Array {
    return file.slice(2, 2 + declaredLength());
  }

  writeFile(options.message);

  function selectedFile(): Uint8Array | null {
    if (selection === 'cc') return ccFile;
    if (selection === 'ndef') return file;
    return null;
  }

  function handleSelect(apdu: IncomingApdu): Uint8Array {
    if (isSelectByName(apdu)) {
      if (!sameBytes(apdu.data, NDEF_APPLICATION_AID)) {
        // Not our application. Answering "file not found" is what lets a reader
        // move on and try the next AID rather than giving up on the card.
        return statusResponse(StatusWord.fileNotFound);
      }
      applicationSelected = true;
      selection = 'none';
      return statusResponse(StatusWord.ok);
    }

    if (isSelectByFileId(apdu)) {
      if (!applicationSelected) {
        return statusResponse(StatusWord.conditionsNotSatisfied);
      }
      if (apdu.data.length !== 2) {
        return statusResponse(StatusWord.wrongLength);
      }

      const requested = ((apdu.data[0] as number) << 8) | (apdu.data[1] as number);
      if (requested === CC_FILE_ID) {
        selection = 'cc';
        return statusResponse(StatusWord.ok);
      }
      if (requested === fileId) {
        selection = 'ndef';
        return statusResponse(StatusWord.ok);
      }

      selection = 'none';
      return statusResponse(StatusWord.fileNotFound);
    }

    return statusResponse(StatusWord.wrongParameters);
  }

  function handleReadBinary(apdu: IncomingApdu): Uint8Array {
    const file = selectedFile();
    if (file === null) {
      return statusResponse(StatusWord.conditionsNotSatisfied);
    }

    const offset = (apdu.p1 << 8) | apdu.p2;
    if (offset > file.length) {
      // Past the end is a parameter error, not an empty read: a reader that gets
      // an empty success here loops forever asking for the same bytes.
      return statusResponse(StatusWord.wrongParameters);
    }

    // Le absent means the reader wants everything from the offset on, which is
    // only sane because both files here are small and bounded.
    const wanted = apdu.le ?? file.length - offset;
    const available = file.length - offset;
    if (wanted > available) {
      return statusResponse(StatusWord.wrongLength);
    }

    return encodeResponseApdu(file.slice(offset, offset + wanted), StatusWord.ok);
  }

  function handleUpdateBinary(apdu: IncomingApdu): Uint8Array {
    if (selection !== 'ndef') {
      return statusResponse(StatusWord.conditionsNotSatisfied);
    }
    if (!writable) {
      return statusResponse(StatusWord.securityNotSatisfied);
    }
    if (apdu.data.length === 0) {
      return statusResponse(StatusWord.wrongLength);
    }
    if (apdu.data.length > maxWriteSize) {
      return statusResponse(StatusWord.wrongLength);
    }

    const offset = (apdu.p1 << 8) | apdu.p2;
    if (offset + apdu.data.length > file.length) {
      return statusResponse(StatusWord.wrongParameters);
    }

    // Validated on a copy and committed only if it holds. A refused write must
    // leave the card exactly as it was: a reader that retries after an error
    // expects to be writing over the old message, not over half of its own.
    const candidate = Uint8Array.from(file);
    candidate.set(apdu.data, offset);

    if (declaredLength(candidate) > capacity) {
      return statusResponse(StatusWord.wrongParameters);
    }

    file.set(candidate);
    return statusResponse(StatusWord.ok);
  }

  return {
    get message(): Uint8Array {
      return currentMessage();
    },

    get selected(): boolean {
      return applicationSelected;
    },

    setMessage(next: Uint8Array): void {
      if (next.length > capacity) {
        throw invalidArgument(
          `The message is ${next.length} bytes but this card's capacity is ${capacity}. ` +
            'Set `capacity` when creating the card to leave room for later messages.',
        );
      }
      writeFile(next);
    },

    deactivate(): void {
      // Both are cleared: a terminal that comes back has to select again, which
      // is what a real card requires and what stops a second reader inheriting
      // the first one's selection.
      applicationSelected = false;
      selection = 'none';
    },

    handle(command: Uint8Array): Uint8Array {
      let apdu: IncomingApdu;
      try {
        apdu = decodeCommandApdu(command);
      } catch {
        // A card answers a bad frame; it cannot raise an exception at a terminal.
        return statusResponse(StatusWord.wrongLength);
      }

      // Only the interindustry class is answered. A proprietary class byte means
      // the reader thinks it is talking to a different card entirely.
      if ((apdu.cla & 0xf0) !== 0x00) {
        return statusResponse(StatusWord.classNotSupported);
      }

      switch (apdu.ins) {
        case Instruction.select:
          return handleSelect(apdu);
        case Instruction.readBinary:
          return handleReadBinary(apdu);
        case Instruction.updateBinary:
          return handleUpdateBinary(apdu);
        default:
          return statusResponse(StatusWord.instructionNotSupported);
      }
    },
  };
}
