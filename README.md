# react-native-nfc-kit

A modern NFC library for React Native and Expo. Built on the Expo Modules API with
Swift and Kotlin, New Architecture native, and typed end to end.

> **Status: pre-release (`0.0.0`).** The NDEF codec, the session API and both
> native implementations are in place and building in CI. Not yet validated
> against real tags on real hardware -- see [the roadmap](#roadmap).

## Why another NFC library

- **The platform asymmetry is in the type system.** MIFARE Classic does not exist on
  iOS, raw `NfcA`/`NfcB` transceive does not exist on iOS, and tag-removal callbacks
  are Android-only. A `Tag` here is a discriminated union: technology-specific methods
  only exist after you narrow with a guard. No silent `undefined`, no methods that lie.
- **Sessions cannot leak.** `nfc.withTag()` closes the session on every path, including
  a throw or an abort mid-operation. Forgetting to close is the single most common bug
  when working with NFC on React Native.
- **One structured error type.** Every rejection is an `NfcError` with a stable
  machine-readable `code`, the original `nativeCode`, and a `cause`. Nothing is
  flattened into an untyped string.
- **Bytes are `Uint8Array` end to end.** Not arrays of boxed JS numbers.
- **Cancellation and timeouts are first-class.** Every awaitable takes an
  `AbortSignal` and an explicit timeout.

## Requirements

|                     | Minimum                 |
| ------------------- | ----------------------- |
| Expo SDK            | 57 (React Native 0.86)  |
| React Native (bare) | 0.86                    |
| iOS                 | 16.4, physical device   |
| Android             | API 24                  |
| Node                | 20.19.4 / 22.13 / 24.3+ |

## NFC requires a development build

**NFC does not work in Expo Go.** It needs custom native code, which Expo Go cannot
load. Use a development build:

```bash
npx expo run:ios      # or
npx expo run:android  # or
eas build --profile development
```

Also note that iOS has no NFC support in the Simulator at all — you need a physical
device (iPhone 7 or later for NDEF, iPhone XS or later for background tag reading).

## What works today

The NDEF codec is done: `react-native-nfc-kit/ndef` is pure TypeScript over
`Uint8Array` with no native dependency, so it works in a bundler, in Node and on
the web. See [docs/ndef.md](docs/ndef.md).

```ts
import {
  createUriRecord,
  createTextRecord,
  encodeMessage,
  decodeMessage,
  isUriRecord,
  decodeUriRecord,
} from 'react-native-nfc-kit/ndef';

const bytes = encodeMessage([
  createUriRecord('https://www.ventry.es/entrada'),
  createTextRecord('Entrada general', { languageCode: 'es' }),
]);

for (const record of decodeMessage(bytes)) {
  if (isUriRecord(record)) {
    console.log(decodeUriRecord(record).uri);
  }
}
```

It covers the parts that are usually missing or wrong elsewhere: chunked record
reassembly, UTF-16 text records, the URI prefix table in both directions with
longest-match selection, Smart Posters, Type 2 TLV framing and the Type 4
capability container.

Reading and writing tags works on both platforms, with the protocol layers
(`react-native-nfc-kit/protocols`) on top: ISO 7816 with command chaining and
`61xx`/`6Cxx` handling, ISO 15693, FeliCa, and NTAG/Ultralight.

### React hooks

`react-native-nfc-kit/react` is a separate subpath, so the core API never imports
React.

```tsx
import { useNfcAvailability, useNfcScan } from 'react-native-nfc-kit/react';

function ScanScreen() {
  const { ready, loading } = useNfcAvailability();
  const { scan, cancel, scanning, data, error } = useNfcScan(
    async (tag) => (tag.is('ndef') ? tag.readNdef() : null),
    { tech: ['ndef'], timeoutMs: 20_000 },
  );

  if (loading) return <Spinner />;
  if (!ready) return <Text>Turn NFC on to continue.</Text>;

  return <Button title={scanning ? 'Cancel' : 'Scan'} onPress={scanning ? cancel : scan} />;
}
```

Unmounting cancels the scan, a second `scan()` joins the first rather than opening
a second session, and `useNfcTagStream` subscribes by value so an inline options
object does not restart reader mode on every render.

## Installation

### Expo

```bash
npx expo install react-native-nfc-kit
```

Then add the config plugin to `app.json` and prebuild:

```json
{
  "expo": {
    "plugins": [
      ["react-native-nfc-kit", { "readerUsageDescription": "Hold your card near the phone" }]
    ]
  }
}
```

```bash
npx expo prebuild --clean
```

### Bare React Native

Expo Modules do **not** require the full Expo SDK — only the `expo` package, which
ships just the module and autolinking infrastructure.

```bash
npx install-expo-modules@latest
npm install react-native-nfc-kit
npx pod-install
```

There is no `prebuild` in a bare project, so entitlements and the Android manifest are
edited by hand. Every page under `docs/setup/` documents both routes: the plugin option
for Expo, and the exact plist/XML for bare.

## How this is verified

Nothing here is claimed to work because it looks right.

| What                  | How                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| NDEF codec            | 353 unit tests, 100% branch coverage, byte fixtures from real tags                                                                     |
| Session and tag API   | Tests against a scripted fake native module, plus `@ts-expect-error` assertions proving an unguarded `tag.readNdef()` does not compile |
| Android               | `compileDebugKotlin` and a full `assembleDebug` in CI, plus a check that autolinking really registers the module                       |
| iOS                   | `pod install` and `xcodebuild` on a macOS runner against real CoreNFC; `npm run check:swift` gives a local syntax check anywhere       |
| Protocol layers       | 247 unit tests, 100% branch coverage: ISO 7816 chaining and `61xx`/`6Cxx`, ISO 15693, FeliCa, NTAG/Ultralight                          |
| React hooks           | 26 tests through `renderHook`, including the unmount races: a scan cancelled by navigating away, an answer arriving after unmount      |
| Config plugin         | 104 tests through Expo's own introspection compiler, so the assertions are about what `expo prebuild` produces                         |
| The published package | `publint` and `arethetypeswrong` against a packed tarball, so a broken `exports` map fails before a user finds it                      |

**What none of that covers:** behaviour against a real tag. No emulator or
simulator can present one. Hardware validation is tracked separately and is a
release requirement, not an afterthought.

## Roadmap

| Phase | Contents                                                              | Status |
| ----- | --------------------------------------------------------------------- | ------ |
| M0    | Repository scaffold, tooling, CI                                      | done   |
| M1    | NDEF codec (pure TypeScript, no native)                               | done   |
| M2    | Android core: reader mode, tech adapters, errors, sessions, tags      | done   |
| M3    | iOS core: session actor, one-shot continuations, tag handles          | done   |
| M4    | Protocol layers: ISO 7816, ISO 15693, FeliCa, NTAG/Ultralight         | done   |
| M5    | Config plugin, bare React Native, React hooks                         | done   |
| M6    | Continuous reading, `onTagLost`, observe mode, background tag reading | next   |
| M7    | Host card emulation (Android `HostApduService`, iOS `CardSession`)    |        |
| M8    | Apple VAS, presentment intent assertion                               |        |
| M9    | Web NFC shim, documentation site, migration guide                     |        |
| M10   | Device matrix pass, soak tests, `1.0.0`                               |        |

Out of scope, deliberately: Apple's NFC & SE Platform (`CredentialSession`). It requires
an agreement with Apple, ABR onboarding, and an accredited-lab applet security review —
not something a general-purpose library can wrap.

## License

MIT
