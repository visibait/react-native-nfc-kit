import { NfcError } from '../../errors.js';
import { toHex } from '../../ndef/bytes.js';
import {
  BLOCK_SIZE,
  FelicaCommand,
  IDM_SIZE,
  MAX_PACKET_SIZE,
  assertStatusOk,
  buildPacket,
  encodeBlockDescriptor,
  parsePacket,
  polling,
  readWithoutEncryption,
  requestSystemCode,
  sendCommand,
  writeWithoutEncryption,
  type FelicaTransport,
} from '../felica.js';

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

function scripted(...responses: Uint8Array[]): FelicaTransport & { sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  let index = 0;

  const transport = (packet: Uint8Array): Promise<Uint8Array> => {
    sent.push(packet);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(response ?? new Uint8Array(0));
  };

  return Object.assign(transport, { sent });
}

const IDM = bytes(0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08);

/** Builds a response packet with a correct leading length byte. */
function response(code: number, ...body: number[]): Uint8Array {
  const length = 2 + IDM_SIZE + body.length;
  return new Uint8Array([length, code, ...IDM, ...body]);
}

describe('buildPacket', () => {
  it('counts the length byte in the length', () => {
    // The detail that silently breaks hand-built packets: eleven bytes start
    // with 0x0B, not 0x0A.
    const packet = buildPacket(FelicaCommand.requestSystemCode, IDM);

    expect(packet[0]).toBe(10);
    expect(packet).toHaveLength(10);
    expect(packet[1]).toBe(0x0c);
    expect(toHex(packet.subarray(2))).toBe('0102030405060708');
  });

  it('appends parameters after the IDm', () => {
    const packet = buildPacket(FelicaCommand.readWithoutEncryption, IDM, bytes(0xaa, 0xbb));

    expect(packet[0]).toBe(12);
    expect(Array.from(packet.subarray(10))).toEqual([0xaa, 0xbb]);
  });

  it('omits the IDm for a broadcast', () => {
    const packet = buildPacket(FelicaCommand.polling, null, bytes(0xff, 0xff, 0x00, 0x00));

    expect(Array.from(packet)).toEqual([0x06, 0x00, 0xff, 0xff, 0x00, 0x00]);
  });

  it('rejects an IDm of the wrong size', async () => {
    await expectNfcError(
      () => buildPacket(FelicaCommand.requestResponse, bytes(1, 2, 3)),
      'invalidArgument',
      '8 bytes',
    );
  });

  it.each([-1, 256, 1.5])('rejects the command code %s', async (command) => {
    await expectNfcError(() => buildPacket(command, IDM), 'invalidArgument', 'single byte');
  });

  it('rejects a packet the length byte cannot describe', async () => {
    await expectNfcError(
      () => buildPacket(FelicaCommand.writeWithoutEncryption, IDM, new Uint8Array(300)),
      'invalidArgument',
      `at most ${MAX_PACKET_SIZE} bytes`,
    );
  });
});

describe('parsePacket', () => {
  it('splits the response code, IDm and body', () => {
    const parsed = parsePacket(response(0x0d, 0x01, 0x00, 0x03));

    expect(parsed.responseCode).toBe(0x0d);
    expect(toHex(parsed.idm)).toBe('0102030405060708');
    expect(Array.from(parsed.data)).toEqual([0x01, 0x00, 0x03]);
  });

  it('accepts the response code that matches the command', () => {
    expect(parsePacket(response(0x07), FelicaCommand.readWithoutEncryption).responseCode).toBe(
      0x07,
    );
  });

  it('rejects a response to a different command', async () => {
    // A mismatch means the tag answered another question; parsing it as the
    // expected reply would produce plausible nonsense.
    await expectNfcError(
      () => parsePacket(response(0x0d), FelicaCommand.readWithoutEncryption),
      'transceiveFailed',
      'is answered by 0x07',
    );
  });

  it('rejects a packet whose length byte disagrees with reality', async () => {
    const packet = response(0x07, 0x00, 0x00);
    packet[0] = 99;

    await expectNfcError(() => parsePacket(packet), 'transceiveFailed', 'counts itself');
  });

  it('rejects a packet too short to hold an IDm', async () => {
    await expectNfcError(
      () => parsePacket(bytes(0x03, 0x07, 0x01)),
      'transceiveFailed',
      'at least',
    );
  });
});

describe('sendCommand', () => {
  it('builds, sends and parses in one step', async () => {
    const transport = scripted(response(0x05));
    const parsed = await sendCommand(transport, FelicaCommand.requestResponse, IDM);

    expect(transport.sent[0]![1]).toBe(0x04);
    expect(parsed.responseCode).toBe(0x05);
  });
});

describe('assertStatusOk', () => {
  it('passes on a zero first flag', () => {
    expect(() => assertStatusOk(0x00, 0x00, 'Reading')).not.toThrow();
  });

  it('reports a refusal rather than returning whatever was in the frame', async () => {
    await expectNfcError(() => assertStatusOk(0x01, 0x02, 'Reading'), 'ioError', 'refused');
  });

  it('treats FF as an authentication problem, which is what it usually is', async () => {
    await expectNfcError(
      () => assertStatusOk(0xff, 0xa1, 'Reading'),
      'authenticationFailed',
      'without authentication',
    );
  });

  it('keeps both flags for a bug report', () => {
    try {
      assertStatusOk(0x01, 0x02, 'Reading');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as NfcError).nativeCode).toBe('felica:0102');
    }
  });
});

describe('encodeBlockDescriptor', () => {
  it('uses the two-byte form for a small block number', () => {
    expect(Array.from(encodeBlockDescriptor({ block: 3 }))).toEqual([0x80, 0x03]);
  });

  it('uses the three-byte form, little-endian, for a large one', () => {
    expect(Array.from(encodeBlockDescriptor({ block: 0x0123 }))).toEqual([0x00, 0x23, 0x01]);
  });

  it('packs the access mode and service index into the head byte', () => {
    expect(Array.from(encodeBlockDescriptor({ block: 1, serviceIndex: 2, accessMode: 1 }))).toEqual(
      [0x92, 0x01],
    );
  });

  it.each([-1, 0x10000, 1.5])('rejects the block number %s', async (block) => {
    await expectNfcError(() => encodeBlockDescriptor({ block }), 'invalidArgument', 'block number');
  });

  it.each([-1, 16])('rejects the service index %s', async (serviceIndex) => {
    await expectNfcError(
      () => encodeBlockDescriptor({ block: 0, serviceIndex }),
      'invalidArgument',
      'service index',
    );
  });

  it.each([-1, 8])('rejects the access mode %s', async (accessMode) => {
    await expectNfcError(
      () => encodeBlockDescriptor({ block: 0, accessMode }),
      'invalidArgument',
      'access mode',
    );
  });
});

describe('readWithoutEncryption', () => {
  it('builds the request and returns one block per descriptor', async () => {
    const block0 = new Array(BLOCK_SIZE).fill(0xaa);
    const block1 = new Array(BLOCK_SIZE).fill(0xbb);
    const transport = scripted(response(0x07, 0x00, 0x00, 0x02, ...block0, ...block1));

    const blocks = await readWithoutEncryption(
      transport,
      IDM,
      [0x090f],
      [{ block: 0 }, { block: 1 }],
    );

    // 06 | IDm | serviceCount | service (little-endian) | blockCount | block list
    const sent = transport.sent[0]!;
    expect(sent[1]).toBe(0x06);
    expect(Array.from(sent.subarray(10))).toEqual([0x01, 0x0f, 0x09, 0x02, 0x80, 0x00, 0x80, 0x01]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]![0]).toBe(0xaa);
    expect(blocks[1]![0]).toBe(0xbb);
  });

  it('sends service codes little-endian', async () => {
    // The opposite of almost everything else in NFC, and easy to get backwards.
    const transport = scripted(response(0x07, 0x00, 0x00, 0x00));
    await readWithoutEncryption(transport, IDM, [0x1234], [{ block: 0 }]);

    expect(Array.from(transport.sent[0]!.subarray(11, 13))).toEqual([0x34, 0x12]);
  });

  it('raises the tag status rather than returning the frame', async () => {
    const transport = scripted(response(0x07, 0xff, 0xa1));

    await expectNfcError(
      () => readWithoutEncryption(transport, IDM, [0x090f], [{ block: 0 }]),
      'authenticationFailed',
    );
  });

  it.each([
    ['no status flags', [0x07]],
    ['no block count', [0x07, 0x00, 0x00]],
  ])('rejects a response with %s', async (_label, body) => {
    const transport = scripted(response(body[0]!, ...body.slice(1)));
    await expectNfcError(
      () => readWithoutEncryption(transport, IDM, [0x090f], [{ block: 0 }]),
      'transceiveFailed',
    );
  });

  it('rejects a response claiming more blocks than it carries', async () => {
    const transport = scripted(response(0x07, 0x00, 0x00, 0x04, ...new Array(BLOCK_SIZE).fill(0)));

    await expectNfcError(
      () => readWithoutEncryption(transport, IDM, [0x090f], [{ block: 0 }]),
      'transceiveFailed',
      'claims 4 block(s)',
    );
  });

  it.each([[[]], [new Array(16).fill(0x090f)]])(
    'rejects a service code list of the wrong size',
    async (serviceCodes) => {
      await expectNfcError(
        () => readWithoutEncryption(scripted(), IDM, serviceCodes as number[], [{ block: 0 }]),
        'invalidArgument',
        'service code list',
      );
    },
  );

  it('rejects a service code that is not 16 bits', async () => {
    await expectNfcError(
      () => readWithoutEncryption(scripted(), IDM, [0x1ffff], [{ block: 0 }]),
      'invalidArgument',
      'service code is a 16-bit',
    );
  });

  it('rejects an empty block list', async () => {
    await expectNfcError(
      () => readWithoutEncryption(scripted(), IDM, [0x090f], []),
      'invalidArgument',
      'block list',
    );
  });
});

describe('writeWithoutEncryption', () => {
  it('appends the block data after the block list', async () => {
    const transport = scripted(response(0x09, 0x00, 0x00));
    const data = new Uint8Array(BLOCK_SIZE).fill(0x5a);

    await writeWithoutEncryption(transport, IDM, [0x0909], [{ block: 0 }], [data]);

    const sent = transport.sent[0]!;
    expect(sent[1]).toBe(0x08);
    expect(Array.from(sent.subarray(10, 16))).toEqual([0x01, 0x09, 0x09, 0x01, 0x80, 0x00]);
    expect(Array.from(sent.subarray(16))).toEqual(new Array(BLOCK_SIZE).fill(0x5a));
  });

  it('raises the tag status', async () => {
    const transport = scripted(response(0x09, 0x01, 0x02));
    await expectNfcError(
      () =>
        writeWithoutEncryption(
          transport,
          IDM,
          [0x0909],
          [{ block: 0 }],
          [new Uint8Array(BLOCK_SIZE)],
        ),
      'ioError',
    );
  });

  it('rejects a mismatch between descriptors and data', async () => {
    await expectNfcError(
      () =>
        writeWithoutEncryption(
          scripted(),
          IDM,
          [0x0909],
          [{ block: 0 }, { block: 1 }],
          [new Uint8Array(BLOCK_SIZE)],
        ),
      'invalidArgument',
      'they must match',
    );
  });

  it('rejects a block that is not 16 bytes', async () => {
    await expectNfcError(
      () => writeWithoutEncryption(scripted(), IDM, [0x0909], [{ block: 0 }], [bytes(1, 2)]),
      'invalidArgument',
      'block 0 is 2',
    );
  });

  it('rejects a response with no status flags', async () => {
    const transport = scripted(response(0x09));
    await expectNfcError(
      () =>
        writeWithoutEncryption(
          transport,
          IDM,
          [0x0909],
          [{ block: 0 }],
          [new Uint8Array(BLOCK_SIZE)],
        ),
      'transceiveFailed',
      'no status flags',
    );
  });
});

describe('polling', () => {
  it('broadcasts without an IDm and returns the tag identity', async () => {
    const pmm = new Array(8).fill(0x11);
    const transport = scripted(response(0x01, ...pmm));

    const result = await polling(transport, 0x0003);

    expect(Array.from(transport.sent[0]!)).toEqual([0x06, 0x00, 0x00, 0x03, 0x00, 0x00]);
    expect(toHex(result.idm)).toBe('0102030405060708');
    expect(result.pmm).toHaveLength(8);
    expect(result.requestData).toBeNull();
  });

  it('defaults to the wildcard system code', async () => {
    const transport = scripted(response(0x01, ...new Array(8).fill(0)));
    await polling(transport);

    expect(Array.from(transport.sent[0]!.subarray(2, 4))).toEqual([0xff, 0xff]);
  });

  it('returns the request data when the tag sent some', async () => {
    const transport = scripted(response(0x01, ...new Array(8).fill(0), 0x00, 0x83));
    const result = await polling(transport, 0x0003, { requestCode: 0x01 });

    expect(transport.sent[0]![4]).toBe(0x01);
    expect(Array.from(result.requestData!)).toEqual([0x00, 0x83]);
  });

  it('rejects a response with no PMm', async () => {
    await expectNfcError(
      () => polling(scripted(response(0x01, 0x01, 0x02))),
      'transceiveFailed',
      '8-byte PMm',
    );
  });

  it.each([-1, 0x10000, 1.5])('rejects the system code %s', async (systemCode) => {
    await expectNfcError(() => polling(scripted(), systemCode), 'invalidArgument', 'system code');
  });
});

describe('requestSystemCode', () => {
  it('decodes the list, most-significant byte first', async () => {
    const transport = scripted(response(0x0d, 0x02, 0x00, 0x03, 0xfe, 0x00));
    const codes = await requestSystemCode(transport, IDM);

    expect(codes).toEqual([0x0003, 0xfe00]);
  });

  it('handles a tag reporting none', async () => {
    expect(await requestSystemCode(scripted(response(0x0d, 0x00)), IDM)).toEqual([]);
  });

  it('rejects a response with no count', async () => {
    await expectNfcError(
      () => requestSystemCode(scripted(response(0x0d)), IDM),
      'transceiveFailed',
      'how many',
    );
  });

  it('rejects a count the response cannot back up', async () => {
    await expectNfcError(
      () => requestSystemCode(scripted(response(0x0d, 0x03, 0x00, 0x03)), IDM),
      'transceiveFailed',
      'too short',
    );
  });
});
