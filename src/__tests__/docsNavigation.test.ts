import fs from 'node:fs';
import path from 'node:path';

/**
 * Checks that the documentation site's navigation and the files agree.
 *
 * Both directions matter, and they fail differently. A navigation entry naming a
 * page that does not exist breaks the site build, which is noticed but late. A page
 * that exists and is in no group is worse: the site builds, the page is live, and
 * nobody can find it — the failure has no symptom.
 */

const ROOT = path.join(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');

interface DocsConfig {
  readonly navigation: { readonly groups: readonly { readonly pages: readonly string[] }[] };
}

const config = JSON.parse(fs.readFileSync(path.join(DOCS, 'docs.json'), 'utf8')) as DocsConfig;

/** Every page in the navigation, as a path relative to `docs/` with no extension. */
const navigated: string[] = config.navigation.groups.flatMap((group) => [...group.pages]);

/** Every page on disk, in the same form. */
function pagesOnDisk(): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
        found.push(
          path
            .relative(DOCS, full)
            .replace(/\\/g, '/')
            .replace(/\.mdx?$/, ''),
        );
      }
    }
  };

  walk(DOCS);
  return found;
}

const onDisk = pagesOnDisk();

describe('the documentation site', () => {
  it('declares what Mintlify requires', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(DOCS, 'docs.json'), 'utf8')) as Record<
      string,
      unknown
    >;

    // name, theme, colors.primary and navigation are the four the schema requires.
    expect(raw.name).toBe('react-native-nfc-kit');
    expect(raw.theme).toBe('mint');
    expect((raw.colors as { primary?: string }).primary).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(navigated.length).toBeGreaterThan(5);
  });

  it.each(navigated)('has a file for the navigated page %s', (page) => {
    expect(onDisk).toContain(page);
  });

  it.each(onDisk)('has %s somewhere in the navigation', (page) => {
    // A page nobody can reach is worse than a broken link: the site builds and the
    // page is live, so the failure has no symptom at all.
    expect(navigated).toContain(page);
  });
});
