import fs from 'node:fs';
import path from 'node:path';

import { renderSetupAsync, type RenderedSetup } from './renderSetup';
import { resolveProps, type NfcKitPluginProps } from '../types';

/**
 * Keeps the setup documentation equal to what the config plugin produces.
 *
 * A setup guide is the one kind of documentation that goes silently wrong the
 * moment the tool changes, because nobody re-reads it until something has
 * already failed on a device — and by then the guide is the reason it failed.
 * So every generated block in `docs/setup/` is rendered here from the plugin
 * itself and compared. Run with `UPDATE_SETUP_DOCS=1` to rewrite them.
 */

const DOCS_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'setup');
const UPDATE = process.env.UPDATE_SETUP_DOCS === '1';

/** The plugin options each documented use case corresponds to. */
const RECIPES: Record<string, NfcKitPluginProps | undefined> = {
  default: undefined,
  iso7816: { ios: { selectIdentifiers: ['A0000002471001'] } },
  felica: { ios: { felicaSystemCodes: ['12FC'] } },
  'background-reading': {
    android: {
      backgroundReading: {
        ndef: [{ mimeType: 'application/vnd.ventry.ticket' }],
        techLists: [['isoDep'], ['mifareUltralight', 'ndef']],
      },
      dispatchNfcMessagePermission: true,
    },
  },
};

type Slot = keyof RenderedSetup;

const SLOTS: readonly Slot[] = ['entitlements', 'infoPlist', 'manifest', 'techFilter'];

/** One `<!-- generated: recipe.slot -->` block found in a documentation file. */
interface Block {
  readonly recipe: string;
  readonly slot: Slot;
  readonly body: string;
  readonly start: number;
  readonly end: number;
}

// Blank lines around the fence are tolerated, because Prettier puts them there.
const BLOCK =
  /<!-- generated: ([a-z0-9-]+)\.([a-zA-Z]+) -->\s*\n```xml\n([\s\S]*?)```\s*\n<!-- \/generated -->/g;

function findBlocks(contents: string): Block[] {
  const blocks: Block[] = [];

  for (const match of contents.matchAll(BLOCK)) {
    const [, recipe, slot, body] = match;
    if (recipe === undefined || slot === undefined || body === undefined) {
      throw new Error('Malformed generated block');
    }
    if (!(recipe in RECIPES)) {
      throw new Error(`Unknown recipe "${recipe}". Add it to RECIPES in setupDocs.test.ts.`);
    }
    if (!SLOTS.includes(slot as Slot)) {
      throw new Error(`Unknown slot "${slot}". Valid slots: ${SLOTS.join(', ')}.`);
    }
    blocks.push({
      recipe,
      slot: slot as Slot,
      body,
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return blocks;
}

function replaceBlock(contents: string, block: Block, body: string): string {
  const replacement =
    `<!-- generated: ${block.recipe}.${block.slot} -->\n\n` +
    '```xml\n' +
    `${body}\n` +
    '```\n\n' +
    '<!-- /generated -->';
  return contents.slice(0, block.start) + replacement + contents.slice(block.end);
}

const rendered = new Map<string, RenderedSetup>();

async function renderRecipe(recipe: string): Promise<RenderedSetup> {
  const existing = rendered.get(recipe);
  if (existing !== undefined) {
    return existing;
  }
  const props = RECIPES[recipe];
  const result = await renderSetupAsync(props, resolveProps(props));
  rendered.set(recipe, result);
  return result;
}

const files = fs.existsSync(DOCS_DIR)
  ? fs.readdirSync(DOCS_DIR).filter((name) => name.endsWith('.md'))
  : [];

const allBlocks = files.flatMap((file) =>
  findBlocks(fs.readFileSync(path.join(DOCS_DIR, file), 'utf8')),
);

describe('the setup documentation', () => {
  it('has blocks to check', () => {
    // Without this the suite passes when the marker syntax stops matching, which
    // is exactly how generated documentation drifts: the check keeps reporting
    // success while checking nothing. It already happened once here.
    expect(files.length).toBeGreaterThan(0);
    expect(allBlocks.length).toBeGreaterThan(0);
  });

  it('exercises every recipe', () => {
    const used = new Set(allBlocks.map((block) => block.recipe));
    expect([...used].sort()).toEqual(Object.keys(RECIPES).sort());
  });

  it.each(files)('%s matches what the plugin produces', async (file) => {
    const filePath = path.join(DOCS_DIR, file);
    const original = fs.readFileSync(filePath, 'utf8');
    let updated = original;

    // Right to left, so replacing one block does not move the offsets of the
    // blocks before it.
    const blocks = findBlocks(original).reverse();

    for (const block of blocks) {
      const body = (await renderRecipe(block.recipe))[block.slot];
      expect(body).not.toBe('');
      updated = replaceBlock(updated, block, body);
    }

    if (UPDATE) {
      if (updated !== original) {
        fs.writeFileSync(filePath, updated, 'utf8');
      }
      return;
    }

    expect(updated).toBe(original);
  });
});
