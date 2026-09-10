import type { Config } from 'prettier';

const config: Config = {
  printWidth: 100,
  singleQuote: true,
  trailingComma: 'all',
  semi: true,
  bracketSpacing: true,
  arrowParens: 'always',
  endOfLine: 'lf',
  overrides: [
    {
      files: ['*.md', '*.mdx'],
      options: { proseWrap: 'preserve' },
    },
  ],
};

export default config;
