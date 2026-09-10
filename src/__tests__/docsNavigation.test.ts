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

interface DocsGroup {
  readonly pages: readonly string[];
}

interface DocsConfig {
  readonly navigation: {
    readonly tabs: readonly { readonly groups: readonly DocsGroup[] }[];
  };
}

const config = JSON.parse(fs.readFileSync(path.join(DOCS, 'docs.json'), 'utf8')) as DocsConfig;

/** Every page in the navigation, as a path relative to `docs/` with no extension. */
const navigated: string[] = config.navigation.tabs.flatMap((tab) =>
  tab.groups.flatMap((group) => [...group.pages]),
);

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

  it('points its logo and favicon at files that exist', () => {
    // A missing asset does not fail the site build. It renders as a broken image
    // in the navbar of every page, which is the first thing anyone sees.
    const raw = JSON.parse(fs.readFileSync(path.join(DOCS, 'docs.json'), 'utf8')) as {
      logo: { light: string; dark: string };
      favicon: string;
    };

    for (const asset of [raw.logo.light, raw.logo.dark, raw.favicon]) {
      expect(fs.existsSync(path.join(DOCS, asset.replace(/^\//, '')))).toBe(true);
    }
  });

  it('gives every page the frontmatter Mintlify renders it from', () => {
    // A page with no `title` falls back to its filename in the sidebar, and one
    // with no `description` has no meta description and no search snippet.
    for (const page of onDisk) {
      const file = [path.join(DOCS, `${page}.mdx`), path.join(DOCS, `${page}.md`)].find((it) =>
        fs.existsSync(it),
      ) as string;
      // Line endings are normalised first: a page written on Windows is still a
      // valid page, and this check is about frontmatter, not about CRLF.
      const contents = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

      expect({ page, opensWithFrontmatter: contents.startsWith('---\n') }).toEqual({
        page,
        opensWithFrontmatter: true,
      });
      const frontmatter = contents.slice(4, contents.indexOf('\n---', 4));
      expect(frontmatter).toMatch(/^title:/m);
      expect(frontmatter).toMatch(/^description:/m);
    }
  });

  it('links only to pages that exist', () => {
    // Mintlify resolves a root-relative link against the docs root, so a link to a
    // page that was renamed or never written is a 404 the site build does not
    // notice. Prose links are the ones readers actually follow.
    const dangling: string[] = [];

    for (const page of onDisk) {
      const file = [path.join(DOCS, `${page}.mdx`), path.join(DOCS, `${page}.md`)].find((it) =>
        fs.existsSync(it),
      ) as string;
      const contents = fs.readFileSync(file, 'utf8');

      // Markdown links and JSX `href=` attributes alike, root-relative only.
      for (const match of contents.matchAll(/(?:\]\(|href=")(\/[^)"#\s]*)(?:#[^)"\s]*)?[)"]/g)) {
        const target = (match[1] as string).replace(/^\//, '').replace(/\/$/, '');
        // The logo and favicon are assets, not pages; they are checked above.
        if (target.startsWith('logo/') || target === 'favicon.svg' || target === '') {
          continue;
        }
        if (!onDisk.includes(target)) {
          dangling.push(`${page} → /${target}`);
        }
      }
    }

    expect(dangling).toEqual([]);
  });

  it('has no HTML comments, which MDX cannot parse', () => {
    // `<!-- -->` is not a comment in MDX, it is a parse error that takes the whole
    // page down. Inside a fenced block it is inert, so only prose is checked.
    for (const page of onDisk) {
      const file = [path.join(DOCS, `${page}.mdx`), path.join(DOCS, `${page}.md`)].find((it) =>
        fs.existsSync(it),
      ) as string;
      const prose = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');

      expect({ page, hasHtmlComment: prose.includes('<!--') }).toEqual({
        page,
        hasHtmlComment: false,
      });
    }
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
