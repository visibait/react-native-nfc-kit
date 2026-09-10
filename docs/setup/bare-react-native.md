# Bare React Native

This library is built on the Expo Modules API, which does **not** require the Expo
SDK. It requires the `expo` package, which ships the module and autolinking
infrastructure and little else.

Bare React Native is a supported route, not a footnote. The only thing you give up
is the config plugin, because there is no `prebuild` to run it — so the plist keys
and manifest XML are yours to write, and every page under `docs/setup/` gives you
exactly what to write.

## Install

```bash
npx install-expo-modules@latest
npm install react-native-nfc-kit
npx pod-install
```

`install-expo-modules` adds the `expo` package, switches the Babel config to
`babel-preset-expo`, and extends `metro.config.js` from `expo/metro-config`.

### Or by hand

```bash
npm install expo react-native-nfc-kit
```

`babel.config.js`:

```js
module.exports = { presets: ['babel-preset-expo'] };
```

`metro.config.js`:

```js
const { getDefaultConfig } = require('expo/metro-config');
module.exports = getDefaultConfig(__dirname);
```

iOS deployment target of 16.4 or higher, in `ios/Podfile`:

```ruby
platform :ios, '16.4'
```

Then `npx pod-install`.

## Requirements

| Axis         | Minimum  | Why                                                         |
| ------------ | -------- | ----------------------------------------------------------- |
| React Native | 0.86     | New Architecture only; the legacy one is gone from Expo 55+ |
| iOS          | 16.4     | The Expo SDK 57 podspec floor                               |
| Android      | API 24   | The Expo SDK 56+ floor                                      |
| Node         | 20.19.4+ | Expo SDK 57's requirement                                   |

CoreNFC has existed since iOS 11, so with a 16.4 floor there is no weak linking to
arrange and no `-weak_framework CoreNFC` hack to copy from anywhere.

## Native configuration

Pick the page for what you are building and copy the blocks under **Bare React
Native**:

- [ndef.md](ndef.md) — the baseline every project needs
- [iso7816.md](iso7816.md) — plus the AIDs you select
- [felica.md](felica.md) — plus the system codes you read
- [background-reading.md](background-reading.md) — plus intent filters

Those blocks are generated from the config plugin and checked in CI, so they are
what an Expo project would have got, not a description of it.

## The iOS capability

Editing the entitlements file is not enough on its own. The App ID needs the
capability too:

1. In the Apple Developer portal, open your App ID.
2. Enable **Near Field Communication Tag Reading**.
3. Regenerate the provisioning profile.

With "Automatically manage signing" in Xcode this happens for you. With a manually
managed profile it does not, and the failure appears at runtime as a session that
will not open.

## Verifying autolinking

If the module did not link, every call fails with `contractMismatch` and a message
telling you to rebuild — which is the right answer often enough to be worth
checking first.

```bash
# iOS: the pod should be listed.
grep -r ReactNativeNfcKit ios/Podfile.lock

# Android: the module should be in the generated autolinking package list.
grep -r nfckit android/app/build/generated/autolinking/ 2>/dev/null
```

On Android, a fresh `./gradlew :app:assembleDebug` regenerates that list. On iOS,
`npx pod-install` after any dependency change.

## What is not available in a bare project

Only the plugin itself. Everything else — the runtime API, the NDEF codec, the
protocol layers, the React hooks — is plain JavaScript and behaves identically.
