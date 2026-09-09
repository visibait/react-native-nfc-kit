#!/usr/bin/env node
// Removes every build artifact produced by `npm run build`.
const fs = require('node:fs');
const path = require('node:path');

const targets = ['build', path.join('plugin', 'build'), '.tmp', 'coverage', 'tsconfig.tsbuildinfo'];

for (const target of targets) {
  const abs = path.join(process.cwd(), target);
  if (fs.existsSync(abs)) {
    fs.rmSync(abs, { recursive: true, force: true });
    console.log(`removed ${target}`);
  }
}
