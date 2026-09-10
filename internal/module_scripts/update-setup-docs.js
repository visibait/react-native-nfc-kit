#!/usr/bin/env node
/**
 * Rewrites the generated blocks in `docs/setup/` from the config plugin.
 *
 * The comparison itself lives in the plugin test suite, so CI fails when a doc
 * and the plugin disagree. This is the other half: the way to make them agree
 * again after changing the plugin.
 *
 * A script rather than an inline `UPDATE_SETUP_DOCS=1 jest ...` in package.json,
 * because that syntax is a shell feature and the shell npm uses on Windows does
 * not have it.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const jest = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'jest.cmd' : 'jest',
);

const result = spawnSync(`"${jest}" --selectProjects plugin -t "setup documentation"`, {
  shell: true,
  stdio: 'inherit',
  env: { ...process.env, UPDATE_SETUP_DOCS: '1' },
});

if (result.error) {
  console.error(`Could not run jest: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
