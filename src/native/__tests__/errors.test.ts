import { NFC_ERROR_CODES, NfcError, isNfcErrorCode } from '../../errors.js';
import { callNative, fromNativeErrorPayload, toNfcError } from '../errors.js';

describe('error code validation', () => {
  it('recognises every declared code', () => {
    for (const code of NFC_ERROR_CODES) {
      expect(isNfcErrorCode(code)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isNfcErrorCode('tagLostSomehow')).toBe(false);
    expect(isNfcErrorCode('')).toBe(false);
  });

  it('lists a plausible number of codes, as a guard against an accidental deletion', () => {
    expect(NFC_ERROR_CODES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(NFC_ERROR_CODES).size).toBe(NFC_ERROR_CODES.length);
  });
});

describe('toNfcError', () => {
  it('passes an NfcError through untouched', () => {
    // Wrapping twice must not bury the original code under internalError.
    const original = new NfcError({ code: 'tagLost', message: 'gone', platform: 'android' });
    expect(toNfcError(original, 'ios', 'fallback')).toBe(original);
  });

  it('honours a code native chose', () => {
    const error = toNfcError(
      { code: 'nfcDisabled', message: 'NFC is switched off' },
      'android',
      'fallback',
    );

    expect(error.code).toBe('nfcDisabled');
    expect(error.message).toBe('NFC is switched off');
    expect(error.platform).toBe('android');
  });

  it('keeps the native identifier rather than discarding it', () => {
    const error = toNfcError(
      { code: 'tagLost', message: 'lost', nativeCode: 'android.nfc.TagLostException' },
      'android',
      'fallback',
    );
    expect(error.nativeCode).toBe('android.nfc.TagLostException');
  });

  it('honours an explicit recoverable flag from native', () => {
    const error = toNfcError(
      { code: 'userCancelled', message: 'cancelled', recoverable: true },
      'ios',
      'fallback',
    );
    // userCancelled is not recoverable by default, so this proves native wins.
    expect(error.recoverable).toBe(true);
  });

  it('falls back to the code-derived recoverable flag when native says nothing', () => {
    expect(toNfcError({ code: 'tagLost', message: 'x' }, 'ios', 'f').recoverable).toBe(true);
    expect(toNfcError({ code: 'ndefReadOnly', message: 'x' }, 'ios', 'f').recoverable).toBe(false);
  });

  it('does not guess at a code it does not recognise', () => {
    // A code from the future most likely means the binary is newer than the
    // bundle, and mapping it to something plausible would hide that.
    const error = toNfcError({ code: 'quantumTunnelling', message: 'odd' }, 'android', 'fallback');

    expect(error.code).toBe('internalError');
    expect(error.nativeCode).toBe('quantumTunnelling');
    expect(error.message).toContain('quantumTunnelling');
    expect(error.message).toContain('newer than the JavaScript bundle');
  });

  it.each([
    ['a plain Error', new Error('boom'), 'boom'],
    ['a string', 'just a string', 'fallback message'],
    ['null', null, 'fallback message'],
    ['undefined', undefined, 'fallback message'],
    ['an empty object', {}, 'fallback message'],
    ['an object with an empty message', { message: '' }, 'fallback message'],
  ])('wraps %s', (_label, thrown, expectedMessage) => {
    const error = toNfcError(thrown, 'android', 'fallback message');

    expect(NfcError.is(error)).toBe(true);
    expect(error.code).toBe('internalError');
    expect(error.message).toBe(expectedMessage);
  });

  it('keeps what was thrown as the cause, so nothing is lost', () => {
    const thrown = new Error('underlying');
    expect(toNfcError(thrown, 'ios', 'f').cause).toBe(thrown);
  });

  it('ignores a non-string nativeCode', () => {
    const error = toNfcError({ code: 'ioError', message: 'x', nativeCode: 42 }, 'ios', 'f');
    expect(error.nativeCode).toBeUndefined();
  });

  it('ignores a non-boolean recoverable', () => {
    const error = toNfcError({ code: 'ioError', message: 'x', recoverable: 'yes' }, 'ios', 'f');
    // Falls back to the code's default, which for ioError is true.
    expect(error.recoverable).toBe(true);
  });
});

describe('fromNativeErrorPayload', () => {
  it('converts a well-formed payload', () => {
    const error = fromNativeErrorPayload(
      {
        code: 'sessionTimeout',
        message: 'The session expired',
        nativeCode: 'NFCError:201',
        recoverable: true,
      },
      'ios',
    );

    expect(error.code).toBe('sessionTimeout');
    expect(error.message).toBe('The session expired');
    expect(error.nativeCode).toBe('NFCError:201');
    expect(error.platform).toBe('ios');
    expect(error.recoverable).toBe(true);
  });

  it('treats nulls as absent', () => {
    const error = fromNativeErrorPayload(
      { code: 'userCancelled', message: 'cancelled', nativeCode: null, recoverable: null },
      'ios',
    );

    expect(error.nativeCode).toBeUndefined();
    expect(error.recoverable).toBe(false);
  });

  it('does not trust an unrecognised code, and says so in the message', () => {
    const error = fromNativeErrorPayload(
      { code: 'notARealCode', message: 'something happened', nativeCode: null, recoverable: null },
      'android',
    );

    expect(error.code).toBe('internalError');
    expect(error.message).toContain('something happened');
    expect(error.message).toContain('notARealCode');
  });

  it('leaves the message alone when the code is recognised', () => {
    const error = fromNativeErrorPayload(
      { code: 'tagLost', message: 'Tag left the field', nativeCode: null, recoverable: null },
      'android',
    );
    expect(error.message).toBe('Tag left the field');
  });
});

describe('callNative', () => {
  it('returns the value on success', async () => {
    await expect(callNative('android', 'readNdef', async () => 'value')).resolves.toBe('value');
  });

  it('turns any rejection into an NfcError naming the operation', async () => {
    // This wrapper exists so no call site has to remember to apply it.
    await callNative('android', 'readNdef', () => Promise.reject(new Error(''))).catch(
      (error: NfcError) => {
        expect(NfcError.is(error)).toBe(true);
        expect(error.message).toBe('readNdef failed.');
      },
    );
  });

  it('preserves a coded rejection', async () => {
    await callNative('ios', 'transceive', () =>
      Promise.reject({ code: 'tagLost', message: 'lost mid-exchange' }),
    ).catch((error: NfcError) => {
      expect(error.code).toBe('tagLost');
      expect(error.message).toBe('lost mid-exchange');
      expect(error.platform).toBe('ios');
    });
  });

  it('converts a synchronous throw as well', async () => {
    await callNative('android', 'startSession', () => {
      throw new Error('threw synchronously');
    }).catch((error: NfcError) => {
      expect(NfcError.is(error)).toBe(true);
      expect(error.message).toBe('threw synchronously');
    });
  });
});
