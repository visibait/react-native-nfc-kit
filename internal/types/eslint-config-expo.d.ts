// `eslint-config-expo` ships no type declarations. Rather than loosening
// `noImplicitAny` repo-wide for one import, declare the shape actually used:
// a flat-config array that gets spread into `defineConfig`.
declare module 'eslint-config-expo/flat.js' {
  import type { Linter } from 'eslint';

  const config: Linter.Config | Linter.Config[];
  export default config;
}
