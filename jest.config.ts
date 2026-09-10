import fs from 'node:fs';
import path from 'node:path';

import type { Config } from 'jest';

/**
 * Relative imports in `src` carry explicit `.js` extensions so the compiled ESM
 * output is valid for Node, which refuses extensionless specifiers in modules.
 * TypeScript resolves `./x.js` to `./x.ts` on its own; Jest's resolver does not,
 * so it needs the same mapping spelled out.
 */
const RESOLVE_TS_FROM_JS_SPECIFIER: Record<string, string> = {
  '^(\\.{1,2}/.*)\\.js$': '$1',
};

/**
 * Keeps only the roots that exist on disk.
 *
 * Layers arrive one milestone at a time, and git does not track an empty
 * directory -- so a root created on one machine is simply absent in a fresh
 * clone, and Jest refuses to start with a validation error rather than skipping
 * it. That failed in CI while passing locally, which is the worst shape a
 * configuration bug can take: the machine that would notice is the one that
 * cannot.
 */
function existingRoots(...roots: readonly string[]): string[] {
  return roots
    .filter((root) => fs.existsSync(path.join(__dirname, root)))
    .map((root) => `<rootDir>/${root}`);
}

/**
 * Two test projects, deliberately separated:
 *
 * - `pure` runs in plain Node with no React Native and no native module. The
 *   NDEF codec and the protocol framing layers live here, which is why they can
 *   be held to 100% coverage: they are functions over `Uint8Array`.
 * - `core` runs under the `jest-expo` preset, which intercepts
 *   `requireNativeModule()` and serves the mocks from `mocks/`. Session
 *   lifecycle, cancellation and error mapping are tested there.
 */
/**
 * Only `*.test.ts` files are suites. Shared helpers live alongside them inside
 * `__tests__`, and Jest's default pattern would otherwise try to run those as
 * empty test files.
 */
const TEST_MATCH = ['**/*.test.ts', '**/*.test.tsx'];

const config: Config = {
  projects: [
    {
      displayName: 'pure',
      testEnvironment: 'node',
      roots: existingRoots('src/__tests__', 'src/ndef', 'src/protocols'),
      transform: {
        // Jest does not substitute <rootDir> inside transform options, so the
        // path is resolved here. Being a TypeScript config, it can just do that.
        '^.+\\.[jt]sx?$': ['babel-jest', { configFile: path.join(__dirname, 'babel.config.js') }],
      },
      moduleNameMapper: RESOLVE_TS_FROM_JS_SPECIFIER,
      testMatch: TEST_MATCH,
    },
    {
      displayName: 'core',
      preset: 'jest-expo',
      roots: existingRoots('src/core', 'src/native', 'src/react', 'src/hce', 'src/vas'),
      moduleNameMapper: RESOLVE_TS_FROM_JS_SPECIFIER,
      testMatch: TEST_MATCH,
    },
    {
      // The config plugin is a separate TypeScript project that runs in Node
      // during `expo prebuild`, never on a device, so it is tested the way it
      // runs: plain Node, real `expo/config-plugins`, no React Native.
      displayName: 'plugin',
      testEnvironment: 'node',
      roots: existingRoots('plugin/src'),
      transform: {
        '^.+\\.[jt]sx?$': ['babel-jest', { configFile: path.join(__dirname, 'babel.config.js') }],
      },
      testMatch: TEST_MATCH,
    },
  ],

  // Milestones land one layer at a time, so a project can legitimately have no
  // tests yet; an empty project must not fail the suite.
  passWithNoTests: true,

  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    'plugin/src/**/*.ts',
    '!**/__tests__/**',
    '!**/*.test.{ts,tsx}',
    '!**/index.ts',
    '!src/**/*.web.ts',
  ],
  coverageReporters: ['text-summary', 'lcov'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85,
    },
    // The pure layers have no excuse: every branch of a byte codec or a protocol
    // encoder is reachable from a test, so an uncovered branch is an untested
    // branch. Both are held to 100%.
    './src/ndef/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    './src/protocols/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    // Card emulation is byte logic over an APDU exchange, so the emulated Type 4
    // tag and the framing around it are as testable as the codec: a terminal's
    // whole conversation can be played through them without a device.
    './src/hce/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    // Reading a Wallet pass is validation and hex decoding over one native call,
    // all of which is reachable from a test even though the entitlement it needs
    // is not something that can be obtained here.
    './src/vas/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    // The hooks are held to 100% too, including their unmount races: every
    // branch there is a state update that either happens after the component is
    // gone or does not, and both outcomes are reachable from a test.
    './src/react/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    // The config plugin is held to the same bar for the same reason: it is plain
    // TypeScript over plain objects, and every branch of it decides something
    // that fails silently on a device -- an entitlement that is never written, a
    // filter that never matches. There is no hardware to blame here.
    './plugin/src/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
};

export default config;
