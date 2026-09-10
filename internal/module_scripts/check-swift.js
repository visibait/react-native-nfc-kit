#!/usr/bin/env node
/**
 * Syntax-checks the Swift sources with `swiftc -parse`.
 *
 * This exists so iOS is not entirely unverifiable away from a Mac. `-parse` does
 * syntax only: it resolves no imports and checks no types, so it catches typos,
 * unbalanced braces and malformed declarations, and nothing else. The
 * authoritative check is the macOS job in CI, which compiles against the real
 * CoreNFC and ExpoModulesCore.
 *
 * Being precise about that boundary matters. A check that looks like it verifies
 * more than it does is worse than no check, because it invites trusting a green
 * run that proved very little.
 *
 * Skips cleanly when no Swift toolchain is installed, so it never blocks a
 * contributor who only touches TypeScript. Install one from https://swift.org
 * (Windows and Linux toolchains are official) to have it actually run.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IOS_DIR = path.join(process.cwd(), 'ios');

/** Locations a Swift toolchain lands in, beyond whatever is already on PATH. */
function candidateCompilers() {
  const candidates = ['swiftc'];

  if (process.platform === 'win32') {
    const root = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Swift', 'Toolchains');
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        candidates.push(path.join(root, entry, 'usr', 'bin', 'swiftc.exe'));
      }
    }
  }

  return candidates;
}

/**
 * PATH the compiler is run with.
 *
 * On Windows the compiler needs the Swift runtime DLLs alongside it, and a shell
 * that did not inherit the installer's PATH (Git Bash, most CI shells) fails with
 * "error while loading shared libraries" rather than anything that names Swift.
 * Adding the known runtime directory turns a confusing failure into a working
 * check.
 */
function compilerEnv() {
  if (process.platform !== 'win32') {
    return process.env;
  }

  const base = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Swift');
  const extra = [];

  for (const group of ['Toolchains', 'Runtimes']) {
    const dir = path.join(base, group);
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const entry of fs.readdirSync(dir)) {
      extra.push(path.join(dir, entry, 'usr', 'bin'));
    }
  }

  if (extra.length === 0) {
    return process.env;
  }
  return {
    ...process.env,
    PATH: `${extra.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

const SWIFT_ENV = compilerEnv();

function findCompiler() {
  for (const candidate of candidateCompilers()) {
    const probe = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      shell: false,
      env: SWIFT_ENV,
    });
    if (probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

function main() {
  if (!fs.existsSync(IOS_DIR)) {
    console.log('No ios/ directory; nothing to check.');
    return;
  }

  const sources = fs
    .readdirSync(IOS_DIR)
    .filter((name) => name.endsWith('.swift'))
    .map((name) => path.join(IOS_DIR, name));

  if (sources.length === 0) {
    console.log('No Swift sources; nothing to check.');
    return;
  }

  const compiler = findCompiler();
  if (compiler === null) {
    console.log(
      'No Swift toolchain found, so the syntax check was skipped.\n' +
        'Install one from https://swift.org to run it locally; CI checks iOS properly on macOS.',
    );
    return;
  }

  const result = spawnSync(compiler, ['-parse', ...sources], {
    encoding: 'utf8',
    shell: false,
    env: SWIFT_ENV,
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (output.length > 0) {
    console.log(output);
  }

  if (result.status !== 0) {
    console.error(`\nSwift syntax check failed (${sources.length} file(s) checked).`);
    process.exit(result.status ?? 1);
  }

  console.log(
    `Swift syntax OK: ${sources.length} file(s) parsed on ${os.platform()}.\n` +
      'Types and imports are checked by the macOS job in CI, not here.',
  );
}

main();
