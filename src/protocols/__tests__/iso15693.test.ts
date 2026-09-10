import { NfcError } from '../../errors.js';
import { toHex } from '../../ndef/bytes.js';
import {
  CUSTOM_COMMAND_MAX,
  CUSTOM_COMMAND_MIN,
  Command,
  DEFAULT_FLAGS,
  RequestFlag,
  buildRequest,
  customCommand,
  describeErrorCode,
  getSystemInformation,
  lockBlock,
  parseResponse,
  readMultipleBlocks,
  readSingleBlock,
  sendRequest,
  writeSingleBlock,
  type Iso15693Transport,
} from '../iso15693.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

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

function scripted(...responses: Uint8Array[]): Iso15693Transport & { sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  let index = 0;

  const transport = (data: Uint8Array): Promise<Uint8Array> => {
    sent.push(data);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(response ?? bytes(0x00));
  };

  return Object.assign(transport, { sent });
}

const UID = bytes(0xe0, 0x04, 0x01, 0x50, 0x12, 0x34, 0x56, 0x78);

describe('constants', () => {
  it('matches the specification', () => {
    expect(DEFAULT_FLAGS).toBe(RequestFlag.highDataRate);
    expect(Command.readSingleBlock).toBe(0x20);
    expect(Command.getSystemInformation).toBe(0x2b);
    expect([CUSTOM_COMMAND_MIN, CUSTOM_COMMAND_MAX]).toEqual([0xa0, 0xdf]);
  });
});

describe('buildRequest', () => {
  it('puts the flags first, then the command', () => {
    expect(Array.from(buildRequest(Command.readSingleBlock))).toEqual([0x02, 0x20]);
  });

  it('appends parameters after the command', () => {
    const frame = buildRequest(Command.readSingleBlock, { parameters: bytes(0x04) });
    expect(Array.from(frame)).toEqual([0x02, 0x20, 0x04]);
  });

  it('honours explicit flags', () => {
    const frame = buildRequest(Command.inventory, {
      flags: RequestFlag.highDataRate | RequestFlag.inventory,
    });
    expect(frame[0]).toBe(0x06);
  });

  it('sets the addressed flag and reverses the UID when one is given', () => {
    // The two always go together: setting the flag without the UID, or the UID
    // without the flag, produces a request no tag answers.
    const frame = buildRequest(Command.readSingleBlock, { uid: UID, parameters: bytes(0x00) });

    expect(frame[0]! & RequestFlag.addressed).toBe(RequestFlag.addressed);
    expect(toHex(frame.subarray(2, 10))).toBe('78563412500104e0');
    expect(frame[10]).toBe(0x00);
  });

  it('rejects a UID that is not eight bytes', () => {
    expect(() => buildRequest(Command.select, { uid: bytes(1, 2, 3) })).toThrow();
  });

  it.each([-1, 256, 1.5])('rejects the command code %s', (command) => {
    expect(() => buildRequest(command)).toThrow();
  });
});

describe('parseResponse', () => {
  it('strips the flags byte and returns the body', () => {
    expect(Array.from(parseResponse(bytes(0x00, 0xaa, 0xbb)))).toEqual([0xaa, 0xbb]);
  });

  it('returns an empty body when the tag sent only flags', () => {
    expect(parseResponse(bytes(0x00))).toHaveLength(0);
  });

  it('raises the error the tag reported rather than returning it as data', async () => {
    // The classic ISO 15693 mistake: two bytes that look like data and are
    // actually a refusal.
    await expectNfcError(
      () => parseResponse(bytes(0x01, 0x10)),
      'ioError',
      'requested block does not exist',
    );
  });

  it('keeps the raw error code for a bug report', async () => {
    try {
      parseResponse(bytes(0x01, 0x12));
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as NfcError).nativeCode).toBe('iso15693:12');
    }
  });

  it('rejects an empty response', async () => {
    await expectNfcError(() => parseResponse(new Uint8Array(0)), 'transceiveFailed', 'no response');
  });

  it('rejects an error flag with no code after it', async () => {
    await expectNfcError(() => parseResponse(bytes(0x01)), 'transceiveFailed', 'did not say which');
  });
});

describe('describeErrorCode', () => {
  it.each([
    [0x01, 'not supported'],
    [0x02, 'format error'],
    [0x03, 'option is not supported'],
    [0x0f, 'Unknown error'],
    [0x10, 'does not exist'],
    [0x11, 'already locked'],
    [0x12, 'locked and cannot be changed'],
    [0x13, 'not written successfully'],
    [0x14, 'not locked successfully'],
  ])('describes 0x%s', (code, expected) => {
    expect(describeErrorCode(code)).toContain(expected);
  });

  it('identifies a manufacturer-defined code', () => {
    expect(describeErrorCode(0xb0)).toContain('custom error');
  });

  it('does not invent a meaning for a reserved code', () => {
    expect(describeErrorCode(0x50)).toContain('reserved');
  });
});

describe('sendRequest', () => {
  it('builds the frame and unwraps the response', async () => {
    const transport = scripted(bytes(0x00, 0x01, 0x02, 0x03, 0x04));
    const body = await sendRequest(transport, Command.readSingleBlock, {
      parameters: bytes(0x00),
    });

    expect(Array.from(transport.sent[0]!)).toEqual([0x02, 0x20, 0x00]);
    expect(Array.from(body)).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it('works with no options at all', async () => {
    const transport = scripted(bytes(0x00, 0x42));
    const body = await sendRequest(transport, Command.getSystemInformation);

    expect(Array.from(transport.sent[0]!)).toEqual([0x02, 0x2b]);
    expect(Array.from(body)).toEqual([0x42]);
  });
});

describe('standard commands', () => {
  it('reads a single block', async () => {
    const transport = scripted(bytes(0x00, 0xde, 0xad, 0xbe, 0xef));
    const block = await readSingleBlock(transport, 4);

    expect(Array.from(transport.sent[0]!)).toEqual([0x02, 0x20, 0x04]);
    expect(toHex(block)).toBe('deadbeef');
  });

  it('writes a single block', async () => {
    const transport = scripted(bytes(0x00));
    await writeSingleBlock(transport, 4, bytes(1, 2, 3, 4));

    expect(Array.from(transport.sent[0]!)).toEqual([0x02, 0x21, 0x04, 1, 2, 3, 4]);
  });

  it('rejects an empty block write', async () => {
    await expectNfcError(
      () => writeSingleBlock(scripted(), 4, new Uint8Array(0)),
      'invalidArgument',
      'at least one byte',
    );
  });

  it('sends the block count one less than asked, as the wire format requires', async () => {
    // A long-standing off-by-one: the wire carries count - 1, so an API that
    // passes the number through gives you one block too many or too few.
    const transport = scripted(bytes(0x00, ...new Array(16).fill(0)));
    await readMultipleBlocks(transport, 2, 4);

    expect(Array.from(transport.sent[0]!)).toEqual([0x02, 0x23, 0x02, 0x03]);
  });

  it.each([0, 257, 1.5])('rejects a block count of %s', async (count) => {
    await expectNfcError(
      () => readMultipleBlocks(scripted(), 0, count),
      'invalidArgument',
      'block count',
    );
  });

  it('locks a block', async () => {
    const transport = scripted(bytes(0x00));
    await lockBlock(transport, 7);

    expect(Array.from(transport.sent[0]!)).toEqual([0x02, 0x22, 0x07]);
  });

  it.each([-1, 256, 1.5])('rejects the block number %s', async (block) => {
    await expectNfcError(
      () => readSingleBlock(scripted(), block),
      'invalidArgument',
      'block number',
    );
  });

  it('propagates a tag error from a block read', async () => {
    await expectNfcError(
      () => readSingleBlock(scripted(bytes(0x01, 0x10)), 200),
      'ioError',
      'does not exist',
    );
  });
});

describe('getSystemInformation', () => {
  it('decodes a full response', async () => {
    // Info flags 0x0F: DSFID, AFI, memory size and IC reference all present.
    const transport = scripted(
      bytes(
        0x00, // response flags
        0x0f, // info flags
        0x78,
        0x56,
        0x34,
        0x12,
        0x50,
        0x01,
        0x04,
        0xe0, // UID, LSB first
        0x00, // DSFID
        0x00, // AFI
        0x1b,
        0x03, // 28 blocks of 4 bytes, both stored one less
        0x01, // IC reference
      ),
    );

    const info = await getSystemInformation(transport);

    expect(toHex(info.uid)).toBe('e0040150123456 78'.replace(/\s/g, ''));
    expect(info.dsfid).toBe(0);
    expect(info.afi).toBe(0);
    expect(info.blockCount).toBe(28);
    expect(info.blockSize).toBe(4);
    expect(info.icReference).toBe(1);
  });

  it('reports absent optional fields as null rather than as a plausible zero', async () => {
    // Info flags 0x00: the tag reported nothing optional at all.
    const transport = scripted(bytes(0x00, 0x00, 0x78, 0x56, 0x34, 0x12, 0x50, 0x01, 0x04, 0xe0));

    const info = await getSystemInformation(transport);

    expect(info.dsfid).toBeNull();
    expect(info.afi).toBeNull();
    expect(info.blockCount).toBeNull();
    expect(info.blockSize).toBeNull();
    expect(info.icReference).toBeNull();
  });

  it('reads only the memory-size field when only that bit is set', async () => {
    const transport = scripted(
      bytes(0x00, 0x04, 0x78, 0x56, 0x34, 0x12, 0x50, 0x01, 0x04, 0xe0, 0x27, 0x03),
    );

    const info = await getSystemInformation(transport);
    expect(info.blockCount).toBe(40);
    expect(info.blockSize).toBe(4);
    expect(info.icReference).toBeNull();
  });

  it('tolerates a truncated optional field rather than reading past the end', async () => {
    // The flags claim a DSFID that is not actually there.
    const transport = scripted(bytes(0x00, 0x01, 0x78, 0x56, 0x34, 0x12, 0x50, 0x01, 0x04, 0xe0));
    expect((await getSystemInformation(transport)).dsfid).toBeNull();
  });

  it('tolerates a truncated memory-size field', async () => {
    const transport = scripted(bytes(0x00, 0x04, 0x78, 0x56, 0x34, 0x12, 0x50, 0x01, 0x04, 0xe0));
    const info = await getSystemInformation(transport);

    expect(info.blockCount).toBeNull();
    expect(info.blockSize).toBeNull();
  });

  it('rejects a response too short to hold a UID', async () => {
    await expectNfcError(
      () => getSystemInformation(scripted(bytes(0x00, 0x0f, 0x01))),
      'transceiveFailed',
      'at least 9 bytes',
    );
  });
});

describe('customCommand', () => {
  it('sends a manufacturer command', async () => {
    const transport = scripted(bytes(0x00, 0xaa));
    const body = await customCommand(transport, 0xa2, { parameters: bytes(0x04, 0x00) });

    expect(Array.from(transport.sent[0]!)).toEqual([0x02, 0xa2, 0x04, 0x00]);
    expect(Array.from(body)).toEqual([0xaa]);
  });

  it.each([0x20, 0x9f, 0xe0, -1, 1.5])(
    'rejects %s, which is not in the custom range',
    async (command) => {
      // Worth rejecting here rather than on the tag: this is the one ISO 15693
      // path CoreNFC supports, so the range matters for portability.
      await expectNfcError(
        () => customCommand(scripted(), command),
        'invalidArgument',
        'custom command code',
      );
    },
  );

  it.each([CUSTOM_COMMAND_MIN, CUSTOM_COMMAND_MAX])('accepts the boundary %s', async (command) => {
    const transport = scripted(bytes(0x00));
    await expect(customCommand(transport, command)).resolves.toHaveLength(0);
  });
});
