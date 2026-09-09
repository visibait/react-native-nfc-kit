// Expo CLI resolves the config plugin from this file at the package root. The
// implementation is TypeScript under `plugin/src` and is compiled to CommonJS
// into `plugin/build` by `npm run build:plugin`.
module.exports = require('./plugin/build/index');
