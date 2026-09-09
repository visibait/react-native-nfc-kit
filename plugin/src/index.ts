import type { ConfigPlugin } from 'expo/config-plugins';
import { createRunOncePlugin } from 'expo/config-plugins';

import { withAndroidNfc } from './withAndroidNfc';
import { withIosNfc } from './withIosNfc';
import { resolveProps, type NfcKitPluginProps } from './types';

const pkg = require('../../package.json') as { name: string; version: string };

const withNfcKit: ConfigPlugin<NfcKitPluginProps | undefined> = (config, props) => {
  const resolved = resolveProps(props);

  let next = withIosNfc(config, resolved);
  next = withAndroidNfc(next, resolved);
  return next;
};

export type { NfcKitPluginProps } from './types';

// `createRunOncePlugin` keys on name + version, so listing the plugin twice (for
// example once directly and once through another plugin) applies it only once.
export default createRunOncePlugin(withNfcKit, pkg.name, pkg.version);
