/**
 * URI prefix abbreviation table from the NFC Forum URI RTD 1.0.
 *
 * A URI record's payload starts with a single identifier byte selecting one of
 * these prefixes, followed by the rest of the URI. It saves 7-12 bytes, which is
 * a meaningful fraction of a small tag: an NTAG213 has 144 usable bytes.
 *
 * Both directions are implemented. Plenty of libraries decode the table but
 * always write 0x00, which works but wastes capacity on exactly the tags that
 * have least to spare.
 */

/**
 * Index in this array is the prefix identifier byte. Index 0 is the empty
 * prefix, meaning the payload holds the URI verbatim.
 *
 * Order and content are fixed by the specification -- this is not a list to
 * tidy up or extend.
 */
export const URI_PREFIXES: readonly string[] = [
  '', // 0x00
  'http://www.', // 0x01
  'https://www.', // 0x02
  'http://', // 0x03
  'https://', // 0x04
  'tel:', // 0x05
  'mailto:', // 0x06
  'ftp://anonymous:anonymous@', // 0x07
  'ftp://ftp.', // 0x08
  'ftps://', // 0x09
  'sftp://', // 0x0a
  'smb://', // 0x0b
  'nfs://', // 0x0c
  'ftp://', // 0x0d
  'dav://', // 0x0e
  'news:', // 0x0f
  'telnet://', // 0x10
  'imap:', // 0x11
  'rtsp://', // 0x12
  'urn:', // 0x13
  'pop:', // 0x14
  'sip:', // 0x15
  'sips:', // 0x16
  'tftp:', // 0x17
  'btspp://', // 0x18
  'btl2cap://', // 0x19
  'btgoep://', // 0x1a
  'tcpobex://', // 0x1b
  'irdaobex://', // 0x1c
  'file://', // 0x1d
  'urn:epc:id:', // 0x1e
  'urn:epc:tag:', // 0x1f
  'urn:epc:pat:', // 0x20
  'urn:epc:raw:', // 0x21
  'urn:epc:', // 0x22
  'urn:nfc:', // 0x23
];

/** Highest defined prefix identifier. */
export const MAX_URI_PREFIX_CODE = URI_PREFIXES.length - 1;

/**
 * Picks the prefix that saves the most bytes for `uri`.
 *
 * Longest match wins, which is the whole point: `https://www.example.com` must
 * choose 0x02 (`https://www.`) over 0x04 (`https://`), and
 * `urn:epc:id:sgtin:...` must choose 0x1e over the shorter `urn:` at 0x13. A
 * naive first-match scan silently produces the worse encoding.
 */
export function findUriPrefix(uri: string): { code: number; rest: string } {
  let bestCode = 0;
  let bestLength = 0;

  // Skip index 0: the empty prefix is the fallback, never a match to beat.
  for (let code = 1; code < URI_PREFIXES.length; code += 1) {
    const prefix = URI_PREFIXES[code] as string;
    if (prefix.length > bestLength && uri.startsWith(prefix)) {
      bestCode = code;
      bestLength = prefix.length;
    }
  }

  return { code: bestCode, rest: uri.slice(bestLength) };
}

/**
 * Expands a prefix identifier.
 *
 * Unknown identifiers -- values above the defined range, which the
 * specification reserves -- expand to the empty prefix rather than throwing.
 * A tag written against a future revision of the table should still yield a
 * readable URI, just without the abbreviation resolved.
 */
export function expandUriPrefix(code: number): string {
  return URI_PREFIXES[code] ?? '';
}
