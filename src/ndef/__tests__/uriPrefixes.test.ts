import {
  MAX_URI_PREFIX_CODE,
  URI_PREFIXES,
  expandUriPrefix,
  findUriPrefix,
} from '../uriPrefixes.js';

describe('URI_PREFIXES', () => {
  it('has the 36 entries the specification defines', () => {
    expect(URI_PREFIXES).toHaveLength(36);
    expect(MAX_URI_PREFIX_CODE).toBe(0x23);
  });

  it('starts with the empty prefix', () => {
    expect(URI_PREFIXES[0x00]).toBe('');
  });

  it.each([
    [0x01, 'http://www.'],
    [0x02, 'https://www.'],
    [0x03, 'http://'],
    [0x04, 'https://'],
    [0x05, 'tel:'],
    [0x06, 'mailto:'],
    [0x0d, 'ftp://'],
    [0x13, 'urn:'],
    [0x1d, 'file://'],
    [0x1e, 'urn:epc:id:'],
    [0x22, 'urn:epc:'],
    [0x23, 'urn:nfc:'],
  ])('maps 0x%s to the specified prefix', (code, expected) => {
    expect(URI_PREFIXES[code as number]).toBe(expected);
  });
});

describe('findUriPrefix', () => {
  it('abbreviates a plain https URI', () => {
    expect(findUriPrefix('https://example.com/a')).toEqual({
      code: 0x04,
      rest: 'example.com/a',
    });
  });

  it('prefers the longest match over the first match', () => {
    // 0x02 is "https://www." and 0x04 is "https://". A first-match scan would
    // pick 0x04 and waste four bytes on a tag that may only have 144.
    expect(findUriPrefix('https://www.example.com')).toEqual({
      code: 0x02,
      rest: 'example.com',
    });
  });

  it('prefers urn:epc:id: over the shorter urn:', () => {
    expect(findUriPrefix('urn:epc:id:sgtin:0614141.112345.400')).toEqual({
      code: 0x1e,
      rest: 'sgtin:0614141.112345.400',
    });
  });

  it('prefers urn:epc: over urn: when no longer epc form matches', () => {
    expect(findUriPrefix('urn:epc:foo')).toEqual({ code: 0x22, rest: 'foo' });
  });

  it('falls back to the empty prefix when nothing matches', () => {
    expect(findUriPrefix('custom-scheme://thing')).toEqual({
      code: 0x00,
      rest: 'custom-scheme://thing',
    });
  });

  it('handles a URI that is exactly a prefix', () => {
    expect(findUriPrefix('tel:')).toEqual({ code: 0x05, rest: '' });
  });

  it('saves bytes for every non-empty prefix in the table', () => {
    URI_PREFIXES.forEach((prefix, code) => {
      if (code === 0) {
        return;
      }
      const uri = `${prefix}rest`;
      const found = findUriPrefix(uri);

      // The chosen prefix must be at least as long as this one; a longer entry
      // in the table is allowed to win (e.g. "urn:" loses to "urn:epc:").
      expect((URI_PREFIXES[found.code] as string).length).toBeGreaterThanOrEqual(prefix.length);
      expect(URI_PREFIXES[found.code] as string).toBe(uri.slice(0, uri.length - found.rest.length));
    });
  });
});

describe('expandUriPrefix', () => {
  it('expands a defined identifier', () => {
    expect(expandUriPrefix(0x04)).toBe('https://');
  });

  it('expands the empty prefix', () => {
    expect(expandUriPrefix(0x00)).toBe('');
  });

  it.each([0x24, 0x7f, 0xff])(
    'expands the reserved identifier 0x%s to nothing rather than throwing',
    (code) => {
      // A tag written against a later revision of the table should still yield a
      // readable URI, just without the abbreviation resolved.
      expect(expandUriPrefix(code)).toBe('');
    },
  );

  it('round-trips with findUriPrefix for every entry', () => {
    URI_PREFIXES.forEach((_prefix, code) => {
      const uri = `${expandUriPrefix(code)}tail`;
      const found = findUriPrefix(uri);
      expect(expandUriPrefix(found.code) + found.rest).toBe(uri);
    });
  });
});
