import fs from 'node:fs';
import path from 'node:path';

/**
 * Checks that everything the documentation imports actually exists.
 *
 * Prose drifts from code silently, and a wrong import in a setup guide costs a
 * reader more than a wrong sentence: they paste it, it fails, and the failure is
 * about a missing symbol rather than about NFC. Two snippets were already wrong
 * when this was written, both found by hand.
 *
 * The barrels are read as text rather than imported, for a reason worth stating:
 * the main entry point reaches the native boundary, so loading it needs React
 * Native, and a check on documentation should not depend on a platform. Reading the
 * export lists is enough, because TypeScript already fails the build if a barrel
 * names something its source does not export.
 *
 * What this does **not** check is how a symbol is used — an example passing bytes
 * to a function that takes records still passes here. Closing that gap means
 * examples living in real `.ts` files and being injected into the prose, the way the
 * generated blocks under `docs/setup/` already are. This is the cheap half, and it
 * catches the likeliest breakage, which is a rename.
 */

const ROOT = path.join(__dirname, '..', '..');

/** Every module a doc snippet may import from, and the barrel that defines it. */
const SUBPATHS: Record<string, string> = {
  'react-native-nfc-kit': 'src/index.ts',
  'react-native-nfc-kit/ndef': 'src/ndef/index.ts',
  'react-native-nfc-kit/protocols': 'src/protocols/index.ts',
  'react-native-nfc-kit/hce': 'src/hce/index.ts',
  'react-native-nfc-kit/vas': 'src/vas/index.ts',
  'react-native-nfc-kit/react': 'src/react/index.ts',
};

/**
 * Every name a barrel exports.
 *
 * Covers the three forms these barrels use: a re-export list, a namespace
 * re-export, and a direct declaration. Type-only names are collected too, since a
 * snippet may legitimately import a type.
 */
function barrelExports(relativePath: string): Set<string> {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const names = new Set<string>();

  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const entry of (match[1] ?? '').split(',')) {
      const name = entry.trim().replace(/^type\s+/, '');
      if (name.length === 0) {
        continue;
      }
      // `a as b` exports `b`.
      const parts = name.split(/\s+as\s+/);
      names.add((parts[parts.length - 1] as string).trim());
    }
  }

  for (const match of source.matchAll(/export\s+\*\s+as\s+(\w+)\s+from/g)) {
    names.add(match[1] as string);
  }

  for (const match of source.matchAll(
    /export\s+(?:declare\s+)?(?:const|function|class|interface|type|enum)\s+(\w+)/g,
  )) {
    names.add(match[1] as string);
  }

  return names;
}

interface DocImport {
  readonly file: string;
  readonly specifier: string;
  readonly names: readonly string[];
}

function markdownFiles(): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.mdx?$/.test(entry.name)) {
        found.push(full);
      }
    }
  };

  walk(path.join(ROOT, 'docs'));
  found.push(path.join(ROOT, 'README.md'));
  return found;
}

/** Named imports from this library, in every fenced TypeScript block. */
function docImports(): DocImport[] {
  const imports: DocImport[] = [];
  const codeBlock = /```tsx?\n([\s\S]*?)```/g;
  const namedImport = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(react-native-nfc-kit[^']*)'/g;

  for (const file of markdownFiles()) {
    const contents = fs.readFileSync(file, 'utf8');

    for (const block of contents.matchAll(codeBlock)) {
      for (const match of (block[1] ?? '').matchAll(namedImport)) {
        const specifiers = match[1] ?? '';
        // An ellipsis stands for "and the rest"; there is nothing to resolve.
        if (specifiers.includes('...')) {
          continue;
        }

        const names = specifiers
          .split(',')
          .map((name) => name.trim().replace(/^type\s+/, ''))
          .filter((name) => name.length > 0)
          .map((name) => (name.split(/\s+as\s+/)[0] as string).trim());

        if (names.length > 0) {
          imports.push({
            file: path.relative(ROOT, file).replace(/\\/g, '/'),
            specifier: match[2] as string,
            names,
          });
        }
      }
    }
  }

  return imports;
}

const imports = docImports();

describe('what the documentation imports', () => {
  it('is worth checking, meaning some imports were found', () => {
    // Without this the suite passes when the fence or import pattern stops
    // matching, which is how a check quietly starts checking nothing.
    expect(imports.length).toBeGreaterThan(5);
  });

  it('only ever comes from a published subpath', () => {
    for (const entry of imports) {
      expect(Object.keys(SUBPATHS)).toContain(entry.specifier);
    }
  });

  it.each(imports)('$file imports $names from $specifier', ({ specifier, names }) => {
    const barrel = SUBPATHS[specifier];
    if (barrel === undefined) {
      throw new Error(`No barrel mapped for ${specifier}`);
    }
    const exported = barrelExports(barrel);

    for (const name of names) {
      expect([...exported]).toContain(name);
    }
  });
});
