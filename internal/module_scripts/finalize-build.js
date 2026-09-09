#!/usr/bin/env node
/**
 * Writes a `package.json` type marker into each build output directory.
 *
 * `tsc` emits `.js` files regardless of module format, so Node decides how to
 * parse them from the nearest `package.json`. Without these markers, the ESM
 * output is parsed as CommonJS and every `import` in it is a syntax error — the
 * exact failure `publint` and `arethetypeswrong` report.
 */
const fs = require('node:fs');
const path = require('node:path');

const markers = [
  ['build/esm', 'module'],
  ['build/cjs', 'commonjs'],
];

for (const [dir, type] of markers) {
  const abs = path.join(process.cwd(), dir);
  if (!fs.existsSync(abs)) {
    console.error(`${dir} does not exist — run the build first.`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(abs, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
  console.log(`${dir}/package.json -> { "type": "${type}" }`);
}
