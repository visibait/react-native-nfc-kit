import {
  mergeStringList,
  NDEF_APPLICATION_AID,
  normalizeHex,
  selectIdentifierWarnings,
} from '../iosPlist';

describe('mergeStringList', () => {
  it('keeps values another plugin already wrote', () => {
    expect(mergeStringList(['NDEF'], ['TAG'])).toEqual(['NDEF', 'TAG']);
  });

  it('removes duplicates', () => {
    expect(mergeStringList(['TAG'], ['TAG'])).toEqual(['TAG']);
  });

  it('sorts, so repeated prebuilds produce an identical file', () => {
    // Otherwise every snapshot comparison in CI turns into a diff about ordering.
    expect(mergeStringList([], ['TAG', 'NDEF'])).toEqual(['NDEF', 'TAG']);
  });

  it('treats a missing or malformed existing value as empty', () => {
    expect(mergeStringList(undefined, ['TAG'])).toEqual(['TAG']);
    expect(mergeStringList('TAG', ['NDEF'])).toEqual(['NDEF']);
  });

  it('drops non-string entries from an existing array', () => {
    expect(mergeStringList(['NDEF', 7, null], ['TAG'])).toEqual(['NDEF', 'TAG']);
  });

  it('returns an empty list when there is nothing to write', () => {
    expect(mergeStringList(undefined, [])).toEqual([]);
  });
});

describe('normalizeHex', () => {
  it('uppercases, so one AID cannot appear twice in different cases', () => {
    expect(normalizeHex('d2760000850101')).toBe('D2760000850101');
    expect(mergeStringList([], ['a0', 'A0'].map(normalizeHex))).toEqual(['A0']);
  });
});

describe('selectIdentifierWarnings', () => {
  it('flags the NDEF application AID, whatever case it was written in', () => {
    // Declaring it makes iOS deliver DESFire cards as ISO 7816 tags rather than
    // MIFARE ones, which is a legitimate choice and a baffling accident.
    expect(selectIdentifierWarnings([NDEF_APPLICATION_AID])).toHaveLength(1);
    expect(selectIdentifierWarnings(['d2760000850101'.toUpperCase()])).toHaveLength(1);
    expect(selectIdentifierWarnings([NDEF_APPLICATION_AID])[0]).toContain('MIFARE');
  });

  it('says nothing about other AIDs', () => {
    expect(selectIdentifierWarnings(['A0000002471001', 'D2760000850100'])).toEqual([]);
    expect(selectIdentifierWarnings([])).toEqual([]);
  });
});
