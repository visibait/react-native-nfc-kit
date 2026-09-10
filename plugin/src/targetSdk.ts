import { DISPATCH_NFC_MESSAGE_MIN_SDK } from './types';

/** The subset of the Expo config this module needs. */
export interface ConfigWithPlugins {
  plugins?: unknown;
}

const BUILD_PROPERTIES_PLUGIN = 'expo-build-properties';

function isBuildPropertiesName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  // Accepts the bare package name and any path that ends in it, since a plugin
  // can legitimately be referenced as './node_modules/expo-build-properties'.
  return name === BUILD_PROPERTIES_PLUGIN || name.endsWith(`/${BUILD_PROPERTIES_PLUGIN}`);
}

function readAndroidTargetSdk(props: unknown): number | undefined {
  if (typeof props !== 'object' || props === null) return undefined;
  const android = (props as { android?: unknown }).android;
  if (typeof android !== 'object' || android === null) return undefined;
  const value = (android as { targetSdkVersion?: unknown }).targetSdkVersion;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/**
 * Reads the project's Android target SDK, when it is knowable at config time.
 *
 * Only one source is authoritative before prebuild has run: an explicit
 * `targetSdkVersion` passed to `expo-build-properties`. Everything else comes
 * from the Expo SDK's own Gradle plugin and is not readable from here, so this
 * returns `undefined` rather than guessing — the caller is expected to say so out
 * loud instead of silently choosing a branch.
 *
 * The last matching entry wins, matching how Expo applies plugins in order.
 */
export function resolveTargetSdkVersion(config: ConfigWithPlugins): number | undefined {
  const plugins = config.plugins;
  if (!Array.isArray(plugins)) return undefined;

  let found: number | undefined;
  for (const entry of plugins) {
    if (!Array.isArray(entry)) continue;
    const [name, props] = entry as [unknown, unknown];
    if (!isBuildPropertiesName(name)) continue;
    const targetSdk = readAndroidTargetSdk(props);
    if (targetSdk !== undefined) found = targetSdk;
  }
  return found;
}

export interface DispatchPermissionDecision {
  readonly apply: boolean;
  /** Present when the decision was made without enough information. */
  readonly warning?: string;
}

/**
 * Decides whether the main activity gets `android.permission.DISPATCH_NFC_MESSAGE`.
 *
 * Both mistakes here are silent, which is why `'auto'` refuses to guess:
 *
 * - Missing on API 37 and above, with the app targeting a newer SDK: the system
 *   never dispatches an NFC intent to the activity.
 * - Present on a device below API 37: the platform does not define that
 *   permission, so nothing can hold it, and the same dispatch is blocked — on
 *   every older device rather than on new ones.
 *
 * Since a single manifest ships to every Android version, only the target SDK
 * tells us which side of that line the project sits on.
 */
export function decideDispatchPermission(options: {
  readonly setting: 'auto' | boolean;
  readonly backgroundReadingEnabled: boolean;
  readonly targetSdkVersion: number | undefined;
}): DispatchPermissionDecision {
  const { setting, backgroundReadingEnabled, targetSdkVersion } = options;

  if (setting !== 'auto') {
    return { apply: setting };
  }
  if (!backgroundReadingEnabled) {
    // Reader mode receives no intents, so there is nothing to protect.
    return { apply: false };
  }
  if (targetSdkVersion === undefined) {
    return {
      apply: false,
      warning:
        'Background NFC reading is configured, but the Android target SDK could not be read from ' +
        'the project, so android.permission.DISPATCH_NFC_MESSAGE was not applied. From Android 17 ' +
        '(API 37) an activity must be protected by it to be dispatched NFC intents when the app ' +
        'targets a newer SDK. Set android.dispatchNfcMessagePermission to true or false in the ' +
        'react-native-nfc-kit plugin options, or declare android.targetSdkVersion via ' +
        'expo-build-properties, to decide it explicitly.',
    };
  }
  return { apply: targetSdkVersion >= DISPATCH_NFC_MESSAGE_MIN_SDK };
}
