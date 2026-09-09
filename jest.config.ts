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
 * Two test projects, deliberately separated:
 *
 * - `pure` runs in plain Node with no React Native and no native module. The
 *   NDEF codec and the protocol framing layers live here, which is why they can
 *   be held to 100% coverage: they are functions over `Uint8Array`.
 * - `core` runs under the `jest-expo` preset, which intercepts
 *   `requireNativeModule()` and serves the mocks from `mocks/`. Session
 *   lifecycle, cancellation and error mapping are tested there.
 */
const config: Config = {
  projects: [
    {
      displayName: 'pure',
      testEnvironment: 'node',
      roots: ['<rootDir>/src/__tests__', '<rootDir>/src/ndef', '<rootDir>/src/protocols'],
      transform: {
        // Jest does not substitute <rootDir> inside transform options, so the
        // path is resolved here. Being a TypeScript config, it can just do that.
        '^.+\\.[jt]sx?$': ['babel-jest', { configFile: path.join(__dirname, 'babel.config.js') }],
      },
      moduleNameMapper: RESOLVE_TS_FROM_JS_SPECIFIER,
    },
    {
      displayName: 'core',
      preset: 'jest-expo',
      roots: ['<rootDir>/src/core', '<rootDir>/src/react', '<rootDir>/src/hce'],
      moduleNameMapper: RESOLVE_TS_FROM_JS_SPECIFIER,
    },
  ],

  // Milestones land one layer at a time, so a project can legitimately have no
  // tests yet; an empty project must not fail the suite.
  passWithNoTests: true,

  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/__tests__/**',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/index.ts',
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
    // The pure layers have no excuse: every branch of a byte codec is reachable
    // from a test, so an uncovered branch is an untested branch.
    //
    // src/protocols gets the same threshold in M4, once it has files. Jest fails
    // outright on a threshold path with no coverage data, so it is added then.
    './src/ndef/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
};

export default config;
