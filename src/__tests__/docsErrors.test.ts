import fs from 'node:fs';
import path from 'node:path';

import { NFC_ERROR_CODES } from '../errors.js';

/**
 * Checks the error reference against the codes that exist.
 *
 * An error reference is the one document a reader arrives at already frustrated, and
 * a code missing from it is the worst possible omission: the reader concludes the
 * error is undocumented and guesses. Adding a code without a row is easy to do, so
 * this makes it impossible to do quietly.
 *
 * The reverse direction matters too. A row for a code that no longer exists sends a
 * reader looking for something they will never see, which is worse than saying
 * nothing.
 */

const REFERENCE = path.join(__dirname, '..', '..', 'docs', 'errors.md');
const contents = fs.readFileSync(REFERENCE, 'utf8');

/**
 * Codes the reference documents.
 *
 * Taken from the first cell of each table row, which is where a code appears in
 * backticks. Prose mentions elsewhere do not count as documenting one.
 */
function documentedCodes(): Set<string> {
  const codes = new Set<string>();

  for (const line of contents.split('\n')) {
    const match = /^\|\s*`(\w+)`\s*\|/.exec(line);
    if (match) {
      codes.add(match[1] as string);
    }
  }

  return codes;
}

const documented = documentedCodes();

describe('the error reference', () => {
  it('has rows to check', () => {
    // Guards against the row pattern silently stopping matching, which would leave
    // this reporting success while checking nothing.
    expect(documented.size).toBeGreaterThan(10);
  });

  it.each([...NFC_ERROR_CODES])('documents %s', (code) => {
    expect([...documented]).toContain(code);
  });

  it('invents no code that does not exist', () => {
    const real = new Set<string>(NFC_ERROR_CODES);
    const invented = [...documented].filter((code) => !real.has(code));

    expect(invented).toEqual([]);
  });

  it('gives every code a cause and a remedy, not just a name', () => {
    // A row with empty cells is a code that has been listed rather than explained.
    for (const line of contents.split('\n')) {
      const match = /^\|\s*`(\w+)`\s*\|([^|]*)\|([^|]*)\|/.exec(line);
      if (match) {
        expect(match[2]?.trim().length).toBeGreaterThan(10);
        expect(match[3]?.trim().length).toBeGreaterThan(10);
      }
    }
  });
});
