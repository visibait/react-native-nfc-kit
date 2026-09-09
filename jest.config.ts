import path from 'node:path';

import type { Config } from 'jest';

/**
 * Two test projects, deliberately separated:
 *
 * - `pure` runs in plain Node with no React Native and no native module. The
 *   NDEF codec and the protocol framing layers live here, which is why they can
 *   be held to 100% coverage — they are functions over `Uint8Array`.
 * - `core` runs under the `jest-expo` preset, which intercepts
 *   `requireNativeModule()` and serves the mocks from `mocks/`. Session
 *   lifecycle, cancellation and error mapping are tested here.
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
        '^.+\.[jt]sx?$': ['babel-jest', { configFile: path.join(__dirname, 'babel.config.js') }],
      },
    },
    {
      displayName: 'core',
      preset: 'jest-expo',
      roots: ['<rootDir>/src/core', '<rootDir>/src/react', '<rootDir>/src/hce'],
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
    // src/protocols gets the same 100% threshold in M4, once it has files:
    // Jest fails on a threshold path with no coverage data.
    // The pure layers have no excuse. Every branch of a byte codec is reachable
    // from a test, so any uncovered branch is an untested branch.
    './src/ndef/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
};

export default config;
