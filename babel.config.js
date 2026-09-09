// Used by Jest (via babel-jest) to transform the TypeScript sources. The
// published output is produced by `tsc`, not by Babel — see `npm run build`.
module.exports = function babelConfig(api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
