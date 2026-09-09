import { NfcError, invalidArgument, ndefMalformed } from '../errors.js';

describe('NfcError', () => {
  it('carries the code, message and platform', () => {
    const error = new NfcError({
      code: 'tagLost',
      message: 'Tag left the field',
      platform: 'android',
    });

    expect(error.code).toBe('tagLost');
    expect(error.message).toBe('Tag left the field');
    expect(error.platform).toBe('android');
    expect(error.name).toBe('NfcError');
  });

  it('defaults platform to js when the error originates in TypeScript', () => {
    expect(new NfcError({ code: 'internalError', message: 'x' }).platform).toBe('js');
  });

  it('is an instance of Error and of NfcError', () => {
    const error = new NfcError({ code: 'ioError', message: 'x' });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(NfcError);
  });

  it('preserves the native identifier rather than discarding it', () => {
    // The single most useful field in a bug report, and the one the previous
    // generation of libraries parsed off a string and then threw away.
    const error = new NfcError({
      code: 'sessionTimeout',
      message: 'Session expired',
      platform: 'ios',
      nativeCode: 'NFCError:201',
    });
    expect(error.nativeCode).toBe('NFCError:201');
  });

  it('leaves nativeCode undefined when there is none', () => {
    expect(new NfcError({ code: 'aborted', message: 'x' }).nativeCode).toBeUndefined();
  });

  it('attaches a cause when one is given', () => {
    const cause = new Error('underlying');
    expect(new NfcError({ code: 'ioError', message: 'x', cause }).cause).toBe(cause);
  });

  it('omits cause entirely when none is given', () => {
    expect(new NfcError({ code: 'ioError', message: 'x' }).cause).toBeUndefined();
  });

  describe('recoverable', () => {
    it.each([
      'sessionTimeout',
      'systemBusy',
      'timeout',
      'tagLost',
      'tagConnectionFailed',
      'ioError',
      'transceiveFailed',
    ] as const)('is true for %s, because presenting the tag again is worth trying', (code) => {
      expect(new NfcError({ code, message: 'x' }).recoverable).toBe(true);
    });

    it.each([
      'userCancelled',
      'nfcUnsupported',
      'entitlementMissing',
      'invalidArgument',
      'ndefReadOnly',
      'unsupportedPlatform',
    ] as const)('is false for %s, because retrying only burns battery', (code) => {
      expect(new NfcError({ code, message: 'x' }).recoverable).toBe(false);
    });

    it('can be overridden explicitly', () => {
      expect(
        new NfcError({ code: 'userCancelled', message: 'x', recoverable: true }).recoverable,
      ).toBe(true);
      expect(new NfcError({ code: 'tagLost', message: 'x', recoverable: false }).recoverable).toBe(
        false,
      );
    });
  });

  describe('is', () => {
    it('recognises an NfcError', () => {
      expect(NfcError.is(new NfcError({ code: 'ioError', message: 'x' }))).toBe(true);
    });

    it('narrows to a specific code', () => {
      const error: unknown = new NfcError({ code: 'tagLost', message: 'x' });
      expect(NfcError.is(error, 'tagLost')).toBe(true);
      expect(NfcError.is(error, 'ioError')).toBe(false);
    });

    it.each([
      ['a plain Error', new Error('nope')],
      ['a string', 'tagLost'],
      ['null', null],
      ['undefined', undefined],
      ['a lookalike object', { name: 'NfcError', code: 'tagLost' }],
    ])('rejects %s', (_label, value) => {
      expect(NfcError.is(value)).toBe(false);
    });

    it('recognises a duplicate copy of the class, which instanceof would not', () => {
      // Two copies of the package in one bundle is a real situation: a nested
      // dependency pins a different version. Branding on `name` survives it.
      class ForeignNfcError extends Error {
        override readonly name = 'NfcError';
        readonly code = 'tagLost';
      }
      const foreign = new ForeignNfcError('from another copy');

      expect(foreign instanceof NfcError).toBe(false);
      expect(NfcError.is(foreign, 'tagLost')).toBe(true);
    });
  });

  it('serialises to a loggable object without the stack', () => {
    const error = new NfcError({
      code: 'ndefReadOnly',
      message: 'Tag is locked',
      platform: 'android',
      nativeCode: 'java.io.IOException',
    });

    expect(error.toJSON()).toEqual({
      name: 'NfcError',
      code: 'ndefReadOnly',
      message: 'Tag is locked',
      platform: 'android',
      nativeCode: 'java.io.IOException',
      recoverable: false,
    });
  });

  it('survives JSON.stringify', () => {
    const json = JSON.parse(JSON.stringify(new NfcError({ code: 'aborted', message: 'stopped' })));
    expect(json).toMatchObject({ name: 'NfcError', code: 'aborted', message: 'stopped' });
  });
});

describe('shorthand constructors', () => {
  it('invalidArgument produces the invalidArgument code', () => {
    const error = invalidArgument('bad length');
    expect(error.code).toBe('invalidArgument');
    expect(error.message).toBe('bad length');
    expect(error.recoverable).toBe(false);
  });

  it('ndefMalformed produces the ndefMalformed code', () => {
    expect(ndefMalformed('truncated').code).toBe('ndefMalformed');
  });

  it('ndefMalformed forwards a cause when given one', () => {
    const cause = new RangeError('offset');
    expect(ndefMalformed('truncated', cause).cause).toBe(cause);
  });

  it('ndefMalformed omits cause when not given one', () => {
    expect(ndefMalformed('truncated').cause).toBeUndefined();
  });
});
