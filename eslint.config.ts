import type { Linter } from 'eslint';
import expoConfig from 'eslint-config-expo/flat.js';
import { defineConfig, globalIgnores } from 'eslint/config';

/**
 * Boundary rule, enforced by the linter rather than by convention: the pure
 * layers must stay pure. `src/ndef`, `src/protocols` and the card side of
 * `src/hce` are plain TypeScript over `Uint8Array`, which is what makes them
 * testable at 100% coverage with no native module and no simulator. An accidental
 * `react-native` import there would silently take that away.
 */
const PURE_LAYER_RESTRICTIONS: Linter.RulesRecord = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        {
          name: 'react-native',
          message:
            'src/ndef and src/protocols must stay platform-free so they can be unit tested without native code.',
        },
        {
          name: 'expo-modules-core',
          message:
            'src/ndef and src/protocols must stay platform-free so they can be unit tested without native code.',
        },
        {
          name: 'react',
          message: 'React belongs in src/react only.',
        },
      ],
      patterns: [
        {
          group: ['**/native/**', '**/core/**'],
          message:
            'The pure layers must not depend on the native boundary or the session core; the dependency runs the other way.',
        },
      ],
    },
  ],
};

export default defineConfig([
  globalIgnores([
    'build/**',
    'plugin/build/**',
    'mocks/**',
    'coverage/**',
    'node_modules/**',
    '.tmp/**',
    // The example is a separate app with its own dependency graph: it imports
    // this package by name, which only resolves once its own install has run.
    // Linting it from here would need that install, so it is checked by the
    // example-types job instead, where the dependencies actually exist.
    'example/**',
    'docs/.docusaurus/**',
    'docs/build/**',
  ]),
  expoConfig,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      // Bitwise operators are the whole point of an NDEF header codec.
      'no-bitwise': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      // The library uses `const X = {...} as const` paired with
      // `type X = (typeof X)[keyof typeof X]` instead of a TypeScript `enum`,
      // so the runtime value and the type always agree. A `.d.ts` declaring an
      // `enum` while the runtime ships a plain object is a lie the compiler
      // cannot catch, and is exactly what the library this replaces shipped.
      // This rule does not model that value/type pairing; TypeScript itself
      // still rejects a genuine redeclaration.
      '@typescript-eslint/no-redeclare': 'off',
      'object-shorthand': 'error',
    },
  },
  {
    // `src/hce/session.ts` and its barrel legitimately reach the native module;
    // the two files named here are the card itself and must not.
    files: ['src/ndef/**/*.ts', 'src/protocols/**/*.ts', 'src/hce/apdu.ts', 'src/hce/type4.ts'],
    rules: PURE_LAYER_RESTRICTIONS,
  },
  {
    // A web bundle has no React Native and no Expo modules. Importing either here
    // would fail at bundle time on the one platform these files exist for, which
    // is a mistake no type check can catch.
    files: ['src/**/*.web.ts', 'src/web/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              message: 'A web bundle has no React Native; use platform-free code here.',
            },
            {
              name: 'expo-modules-core',
              message: 'There is no native module on the web; this file is what replaces it.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['internal/**/*.js', '*.config.js', 'app.plugin.js'],
    languageOptions: {
      sourceType: 'commonjs',
    },
    rules: {
      'no-undef': 'off',
    },
  },
]);
