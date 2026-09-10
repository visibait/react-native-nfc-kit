#!/usr/bin/env node
/**
 * Checks the package as a consumer would receive it.
 *
 * Builds, packs a real tarball, and runs `publint` and `arethetypeswrong`
 * against it. Those two catch the class of problem that never shows up in the
 * source tree: a broken `exports` map, ESM output that Node parses as CommonJS,
 * types that resolve under one module resolution and not another. Both have
 * already caught real bugs here.
 *
 * A script rather than a chain of npm commands, because the chain worked locally
 * and failed in CI for three separate reasons:
 *
 * - `npm pack --pack-destination` does not create the directory. It only worked
 *   where an earlier manual command had left one behind.
 * - `.tmp/*.tgz` is expanded by the shell, and the shell npm uses on Windows
 *   does not expand globs, so the tools received a literal asterisk.
 * - Node refuses to execute a `.cmd` shim without a shell, so resolving the
 *   binaries by path and spawning them directly fails on Windows with no
 *   message at all.
 *
 * Each command is therefore a single quoted string run through the shell, and
 * spawn failures are reported rather than becoming a silent non-zero exit.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OUT_DIR = path.join(process.cwd(), '.tmp');
const isWindows = process.platform === 'win32';

/** Quotes a path so a space in it does not split the command. */
function quote(value) {
  return `"${value}"`;
}

/** Path to a locally installed tool, falling back to whatever is on PATH. */
function resolveBin(name) {
  const local = path.join(process.cwd(), 'node_modules', '.bin', isWindows ? `${name}.cmd` : name);
  return fs.existsSync(local) ? local : name;
}

function spawn(commandLine, options) {
  // A single command string rather than a command plus an argument array: with
  // `shell: true` Node concatenates arguments without escaping them, which it
  // now warns about, and quoting them here is the fix rather than the warning.
  const result = spawnSync(commandLine, { shell: true, ...options });

  if (result.error) {
    console.error(`Could not run: ${commandLine}\n${result.error.message}`);
    process.exit(1);
  }
  return result;
}

function run(commandLine) {
  const result = spawn(commandLine, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nFailed (exit ${result.status}): ${commandLine}`);
    process.exit(result.status ?? 1);
  }
}

function capture(commandLine) {
  const result = spawn(commandLine, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    console.error(`\nFailed (exit ${result.status}): ${commandLine}`);
    process.exit(result.status ?? 1);
  }
  return (result.stdout ?? '').trim();
}

function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  run('npm run build');

  // --silent so the only thing on stdout is the tarball's file name.
  const packed = capture(`npm pack --silent --pack-destination ${quote(OUT_DIR)}`);
  const fileName = packed.split(/\r?\n/).filter(Boolean).pop() ?? '';
  const tarball = path.join(OUT_DIR, fileName);

  if (!fs.existsSync(tarball)) {
    console.error(`npm pack reported "${packed}" but no tarball was written to ${OUT_DIR}.`);
    process.exit(1);
  }

  console.log(`\nChecking ${fileName}\n`);
  run(`${quote(resolveBin('publint'))} ${quote(tarball)}`);
  run(`${quote(resolveBin('attw'))} ${quote(tarball)}`);

  console.log('\nPackage looks correct to publint and arethetypeswrong.');
}

main();
