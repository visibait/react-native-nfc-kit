import { NfcError } from '../../errors.js';
import { decodeCapabilityContainer } from '../../ndef/ccFile.js';
import {
  createTextRecord,
  createUriRecord,
  decodeMessage,
  encodeMessage,
} from '../../ndef/index.js';
import { decodeResponseApdu, encodeCommandApdu } from '../../protocols/iso7816.js';
import { Instruction, SELECT_BY_FILE_ID, SELECT_BY_NAME, StatusWord } from '../apdu.js';
import {
  CC_FILE_ID,
  DEFAULT_MAX_READ_SIZE,
  NDEF_APPLICATION_AID,
  createType4Card,
  type Type4Card,
} from '../type4.js';

/**
 * Drives the card the way the reader-side protocol layer does.
 *
 * Commands are built with `encodeCommandApdu` and responses read with
 * `decodeResponseApdu` -- the same functions an app uses to talk to a real card --
 * so these tests exercise the pairing rather than a hand-rolled approximation of
 * one frame shape.
 */
class Terminal {
  constructor(private readonly card: Type4Card) {}

  send(command: Parameters<typeof encodeCommandApdu>[0]): ReturnType<typeof decodeResponseApdu> {
    return decodeResponseApdu(this.card.handle(encodeCommandApdu(command)));
  }

  selectApplication(aid: Uint8Array = NDEF_APPLICATION_AID) {
    return this.send({
      cla: 0x00,
      ins: Instruction.select,
      p1: SELECT_BY_NAME,
      p2: 0x00,
      data: aid,
    });
  }

  selectFile(fileId: number) {
    return this.send({
      cla: 0x00,
      ins: Instruction.select,
      p1: SELECT_BY_FILE_ID,
      p2: 0x0c,
      data: new Uint8Array([(fileId >> 8) & 0xff, fileId & 0xff]),
    });
  }

  read(offset: number, length: number) {
    return this.send({
      cla: 0x00,
      ins: Instruction.readBinary,
      p1: (offset >> 8) & 0xff,
      p2: offset & 0xff,
      le: length,
    });
  }

  write(offset: number, data: Uint8Array) {
    return this.send({
      cla: 0x00,
      ins: Instruction.updateBinary,
      p1: (offset >> 8) & 0xff,
      p2: offset & 0xff,
      data,
    });
  }
}

const MESSAGE = encodeMessage([createUriRecord('https://www.ventry.es/entrada')]);

/**
 * Reads the message the way a reader does: length first, then the body in
 * chunks no larger than the CC advertised.
 */
function readMessage(
  terminal: Terminal,
  fileId: number,
  chunk = DEFAULT_MAX_READ_SIZE,
): Uint8Array {
  expect(terminal.selectApplication().ok).toBe(true);
  expect(terminal.selectFile(fileId).ok).toBe(true);

  const header = terminal.read(0, 2);
  expect(header.ok).toBe(true);
  const length = ((header.data[0] as number) << 8) | (header.data[1] as number);

  const parts: number[] = [];
  let read = 0;
  while (read < length) {
    const size = Math.min(chunk, length - read);
    const response = terminal.read(2 + read, size);
    expect(response.ok).toBe(true);
    parts.push(...response.data);
    read += size;
  }

  return new Uint8Array(parts);
}

describe('a reader performing the standard sequence', () => {
  it('reads back exactly the message the card was given', () => {
    const card = createType4Card({ message: MESSAGE });
    const cc = decodeCapabilityContainer(readCc(card));

    expect(cc.ndefFile).toBeDefined();
    expect(readMessage(new Terminal(card), cc.ndefFile!.fileId)).toEqual(MESSAGE);
  });

  it('survives a message larger than one read', () => {
    // A reader splits the body at the MLe the CC advertised, so a message that
    // needs several reads exercises the offset arithmetic that a short one hides.
    const long = encodeMessage([createTextRecord('x'.repeat(600), { languageCode: 'en' })]);
    const card = createType4Card({ message: long });
    const cc = decodeCapabilityContainer(readCc(card));

    expect(long.length).toBeGreaterThan(DEFAULT_MAX_READ_SIZE);
    expect(readMessage(new Terminal(card), cc.ndefFile!.fileId)).toEqual(long);
  });

  it('serves a message the reader can decode', () => {
    const card = createType4Card({ message: MESSAGE });
    const cc = decodeCapabilityContainer(readCc(card));

    // The whole point: what comes off the emulated card is an NDEF message, not
    // just the right number of bytes.
    expect(decodeMessage(readMessage(new Terminal(card), cc.ndefFile!.fileId))).toHaveLength(1);
  });

  it('serves an empty message as a well-formed empty file', () => {
    const card = createType4Card({ message: new Uint8Array() });
    const terminal = new Terminal(card);

    expect(terminal.selectApplication().ok).toBe(true);
    expect(terminal.selectFile(0xe104).ok).toBe(true);
    expect(terminal.read(0, 2).data).toEqual(new Uint8Array([0x00, 0x00]));
  });
});

/** Reads the CC file the way a reader does, and returns its bytes. */
function readCc(card: Type4Card): Uint8Array {
  const terminal = new Terminal(card);
  expect(terminal.selectApplication().ok).toBe(true);
  expect(terminal.selectFile(CC_FILE_ID).ok).toBe(true);

  const header = terminal.read(0, 2);
  const length = ((header.data[0] as number) << 8) | (header.data[1] as number);
  const rest = terminal.read(0, length);
  return rest.data;
}

describe('the Capability Container it advertises', () => {
  it('describes the card the reader is actually talking to', () => {
    const card = createType4Card({ message: MESSAGE, capacity: 512, writable: true });
    const cc = decodeCapabilityContainer(readCc(card));

    expect(cc.mappingVersion).toEqual({ major: 2, minor: 0 });
    // The advertised size includes the 2-byte length prefix, which lives inside
    // the file. Advertising room the card does not have fails a write half-way,
    // and a partly written message is worse than a refused one.
    expect(cc.ndefFile?.maxFileSize).toBe(514);
    expect(cc.ndefFile?.writable).toBe(true);
    expect(cc.ndefFile?.readable).toBe(true);
  });

  it('advertises a read-only card as permanently locked', () => {
    const cc = decodeCapabilityContainer(readCc(createType4Card({ message: MESSAGE })));

    // Not "requires authentication": there is no authentication to satisfy, so
    // a reader offering the user a write it can never perform is misleading.
    expect(cc.ndefFile?.permanentlyReadOnly).toBe(true);
    expect(cc.ndefFile?.writable).toBe(false);
  });

  it('advertises only the room it has, by default', () => {
    const cc = decodeCapabilityContainer(readCc(createType4Card({ message: MESSAGE })));

    expect(cc.ndefFile?.maxFileSize).toBe(MESSAGE.length + 2);
  });

  it('refuses a capacity smaller than the message it already holds', () => {
    expect(() => createType4Card({ message: MESSAGE, capacity: 2 })).toThrow(NfcError);
  });
});

describe('selection state', () => {
  it('refuses an unknown application so the reader can try the next one', () => {
    const card = createType4Card({ message: MESSAGE });
    const response = new Terminal(card).selectApplication(new Uint8Array([0xa0, 0x00, 0x00, 0x03]));

    expect(response.status).toBe(StatusWord.fileNotFound);
    expect(card.selected).toBe(false);
  });

  it('refuses a file select before the application is selected', () => {
    const terminal = new Terminal(createType4Card({ message: MESSAGE }));

    expect(terminal.selectFile(CC_FILE_ID).status).toBe(StatusWord.conditionsNotSatisfied);
  });

  it('refuses a read before a file is selected', () => {
    const terminal = new Terminal(createType4Card({ message: MESSAGE }));
    terminal.selectApplication();

    expect(terminal.read(0, 2).status).toBe(StatusWord.conditionsNotSatisfied);
  });

  it('refuses a file that is neither the CC nor the NDEF file', () => {
    const terminal = new Terminal(createType4Card({ message: MESSAGE }));
    terminal.selectApplication();

    expect(terminal.selectFile(0xe105).status).toBe(StatusWord.fileNotFound);
    // And the previous selection is dropped rather than left in place, so a
    // following read cannot answer from a file the reader did not ask for.
    expect(terminal.read(0, 2).status).toBe(StatusWord.conditionsNotSatisfied);
  });

  it('rejects a file identifier that is not two bytes', () => {
    const card = createType4Card({ message: MESSAGE });
    const terminal = new Terminal(card);
    terminal.selectApplication();

    const response = terminal.send({
      cla: 0x00,
      ins: Instruction.select,
      p1: SELECT_BY_FILE_ID,
      p2: 0x0c,
      data: new Uint8Array([0xe1]),
    });

    expect(response.status).toBe(StatusWord.wrongLength);
  });

  it('drops the selection when the field is lost', () => {
    // A second terminal must not inherit the first one's selection, which is what
    // a real card enforces by losing power.
    const card = createType4Card({ message: MESSAGE });
    const terminal = new Terminal(card);
    terminal.selectApplication();
    terminal.selectFile(CC_FILE_ID);

    card.deactivate();

    expect(card.selected).toBe(false);
    expect(terminal.read(0, 2).status).toBe(StatusWord.conditionsNotSatisfied);
  });

  it('clears the file selection when the application is re-selected', () => {
    const terminal = new Terminal(createType4Card({ message: MESSAGE }));
    terminal.selectApplication();
    terminal.selectFile(CC_FILE_ID);
    terminal.selectApplication();

    expect(terminal.read(0, 2).status).toBe(StatusWord.conditionsNotSatisfied);
  });

  it('answers a SELECT it does not understand with a parameter error', () => {
    const terminal = new Terminal(createType4Card({ message: MESSAGE }));

    const response = terminal.send({
      cla: 0x00,
      ins: Instruction.select,
      p1: 0x02,
      p2: 0x00,
      data: new Uint8Array([0xe1, 0x03]),
    });

    expect(response.status).toBe(StatusWord.wrongParameters);
  });
});

describe('reading', () => {
  function selected(): Terminal {
    const terminal = new Terminal(createType4Card({ message: MESSAGE }));
    terminal.selectApplication();
    terminal.selectFile(0xe104);
    return terminal;
  }

  it('reads from an offset', () => {
    const terminal = selected();

    expect(terminal.read(2, 4).data).toEqual(MESSAGE.subarray(0, 4));
  });

  it('refuses an offset past the end rather than answering nothing', () => {
    // An empty success here makes a reader ask for the same bytes forever.
    expect(selected().read(9999, 1).status).toBe(StatusWord.wrongParameters);
  });

  it('refuses a read that runs off the end', () => {
    expect(selected().read(2, MESSAGE.length + 10).status).toBe(StatusWord.wrongLength);
  });

  it('reads to the end of the file when no length is requested', () => {
    const card = createType4Card({ message: MESSAGE });
    const terminal = new Terminal(card);
    terminal.selectApplication();
    terminal.selectFile(0xe104);

    const response = terminal.send({
      cla: 0x00,
      ins: Instruction.readBinary,
      p1: 0x00,
      p2: 0x00,
    });

    expect(response.data).toHaveLength(MESSAGE.length + 2);
  });

  it('answers an empty success at the exact end of the file', () => {
    // The boundary a reader reaches when it has read everything: the offset is
    // valid, there is nothing left, and it must not be an error. A reader cannot
    // ask for zero bytes explicitly -- Le counts bytes and zero means 256 -- so
    // this is the no-Le form at the end.
    const terminal = selected();

    const response = terminal.send({
      cla: 0x00,
      ins: Instruction.readBinary,
      p1: ((MESSAGE.length + 2) >> 8) & 0xff,
      p2: (MESSAGE.length + 2) & 0xff,
    });

    expect(response.ok).toBe(true);
    expect(response.data).toHaveLength(0);
  });
});

describe('writing', () => {
  const replacement = encodeMessage([createTextRecord('replaced', { languageCode: 'en' })]);

  function writable(): { card: Type4Card; terminal: Terminal } {
    const card = createType4Card({ message: MESSAGE, capacity: 512, writable: true });
    const terminal = new Terminal(card);
    terminal.selectApplication();
    terminal.selectFile(0xe104);
    return { card, terminal };
  }

  it('accepts the length-last sequence a reader uses', () => {
    // A reader writes zero length, then the body, then the real length, so the
    // message is never readable half-written.
    const { card, terminal } = writable();

    expect(terminal.write(0, new Uint8Array([0x00, 0x00])).ok).toBe(true);
    expect(card.message).toHaveLength(0);

    expect(terminal.write(2, replacement).ok).toBe(true);
    expect(
      terminal.write(
        0,
        new Uint8Array([(replacement.length >> 8) & 0xff, replacement.length & 0xff]),
      ).ok,
    ).toBe(true);

    expect(card.message).toEqual(replacement);
  });

  it('refuses a write on a read-only card', () => {
    const card = createType4Card({ message: MESSAGE });
    const terminal = new Terminal(card);
    terminal.selectApplication();
    terminal.selectFile(0xe104);

    expect(terminal.write(0, new Uint8Array([0x00, 0x00])).status).toBe(
      StatusWord.securityNotSatisfied,
    );
    expect(card.message).toEqual(MESSAGE);
  });

  it('refuses a write when the NDEF file is not selected', () => {
    const card = createType4Card({ message: MESSAGE, writable: true });
    const terminal = new Terminal(card);
    terminal.selectApplication();
    terminal.selectFile(CC_FILE_ID);

    expect(terminal.write(0, new Uint8Array([0x00, 0x00])).status).toBe(
      StatusWord.conditionsNotSatisfied,
    );
  });

  it('refuses a write that would run past the capacity', () => {
    const { terminal } = writable();

    expect(terminal.write(510, new Uint8Array(8)).status).toBe(StatusWord.wrongParameters);
  });

  it('refuses a declared length larger than the capacity', () => {
    const { card, terminal } = writable();

    expect(terminal.write(0, new Uint8Array([0xff, 0xff])).status).toBe(StatusWord.wrongParameters);
    expect(card.message).toEqual(MESSAGE);
  });

  it('refuses a write longer than the MLc it advertised', () => {
    const card = createType4Card({
      message: new Uint8Array(),
      capacity: 512,
      writable: true,
      maxWriteSize: 16,
    });
    const terminal = new Terminal(card);
    terminal.selectApplication();
    terminal.selectFile(0xe104);

    expect(terminal.write(2, new Uint8Array(32)).status).toBe(StatusWord.wrongLength);
  });

  it('refuses an empty write', () => {
    const { terminal } = writable();

    expect(
      terminal.send({ cla: 0x00, ins: Instruction.updateBinary, p1: 0x00, p2: 0x00 }).status,
    ).toBe(StatusWord.wrongLength);
  });
});

describe('the app replacing the message', () => {
  it('serves the new message to the next reader', () => {
    const card = createType4Card({ message: MESSAGE, capacity: 512 });
    const replacement = encodeMessage([createTextRecord('second', { languageCode: 'en' })]);

    card.setMessage(replacement);

    expect(readMessage(new Terminal(card), 0xe104)).toEqual(replacement);
  });

  it('refuses a message the card has no room for', () => {
    const card = createType4Card({ message: MESSAGE });

    // Silently truncating would produce a card that reads as valid and says
    // something the app never asked it to say.
    expect(() => card.setMessage(new Uint8Array(4096))).toThrow(NfcError);
  });
});

describe('commands it does not implement', () => {
  it('answers an unknown instruction rather than going quiet', () => {
    const card = createType4Card({ message: MESSAGE });
    const response = decodeResponseApdu(
      card.handle(new Uint8Array([0x00, 0x84, 0x00, 0x00, 0x08])),
    );

    expect(response.status).toBe(StatusWord.instructionNotSupported);
  });

  it('rejects a proprietary class byte', () => {
    // A reader sending one thinks it is talking to a different card entirely.
    const card = createType4Card({ message: MESSAGE });
    const response = decodeResponseApdu(
      card.handle(new Uint8Array([0x90, 0x60, 0x00, 0x00, 0x00])),
    );

    expect(response.status).toBe(StatusWord.classNotSupported);
  });

  it('answers a malformed frame instead of throwing', () => {
    // A card cannot raise an exception at a terminal; it can only answer.
    const card = createType4Card({ message: MESSAGE });

    expect(() => card.handle(new Uint8Array([0x00, 0xa4]))).not.toThrow();
    expect(decodeResponseApdu(card.handle(new Uint8Array([0x00, 0xa4]))).status).toBe(
      StatusWord.wrongLength,
    );
  });
});
