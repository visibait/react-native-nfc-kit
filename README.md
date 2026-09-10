# react-native-nfc-kit

[![npm](https://img.shields.io/npm/v/react-native-nfc-kit)](https://www.npmjs.com/package/react-native-nfc-kit)
[![license](https://img.shields.io/npm/l/react-native-nfc-kit)](LICENSE)

A modern NFC library for React Native and Expo. Built on the Expo Modules API with
Swift and Kotlin, New Architecture native, and typed end to end.

```bash
npx expo install react-native-nfc-kit
```

> **Status: `0.9.0`.** Every layer is implemented and tested — 1342 tests, with the
> NDEF codec, the protocol layers, card emulation, the Web NFC shim and the config
> plugin each at 100% coverage. What is missing is not code: **no row of
> [the device matrix](docs/device-matrix.md) has been run yet.** That is the only
> thing between this and a `1.0.0`, and it is why the version says so.

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

All of it: reading and writing on both platforms, the protocol layers, card
emulation on Android, background tags, Wallet passes, React hooks, and the same API
in a browser. The sections below walk through each one.

### The NDEF codec

`react-native-nfc-kit/ndef` is pure TypeScript over `Uint8Array` with no native
dependency, so it works in a bundler, in Node and on the web — useful on a server
that builds messages, and in tests that never touch a device. See
[docs/ndef.md](docs/ndef.md).

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

Android also reports when a tag leaves the field (`tag.onLost`) and delivers tags
that arrive through an intent — the tap that launched the app, or one that came in
while it was running:

```ts
const ticket = await nfc.withLaunchTag(async (tag) =>
  tag.is('ndef') ? decodeMessage(await tag.readNdef()) : null,
);
```

See [docs/setup/background-reading.md](docs/setup/background-reading.md). iOS does
neither: CoreNFC has no removal callback, and background NDEF reading happens
entirely inside the system without the app being handed the tag. `nfc.capabilities`
says which of these the device you are on actually does.

### Card emulation

`react-native-nfc-kit/hce` makes the phone answer a terminal as though it were a
card — a door reader, a turnstile, another phone:

```ts
import { hce } from 'react-native-nfc-kit/hce';

const session = await hce.emulateNdef(
  encodeMessage([createUriRecord('https://www.ventry.es/entrada')]),
);
```

Android only, and the app has to be running: Android starts its HCE service without
reference to any Activity, so when there is no JavaScript runtime the terminal is
answered `6F00` by native rather than left waiting. iOS has `CardSession` from 17.4
but it needs an Apple-granted entitlement and works only in the EEA, so
`hce.isSupported()` answers `false` there. See
[docs/setup/hce.md](docs/setup/hce.md).

### In a browser

The same API works on the web, backed by Web NFC, with no import changes: the native
boundary is a small session-based contract, and the web build implements it. Chrome
on Android only, NDEF only, and the calls a browser cannot serve reject
`unsupportedPlatform` rather than pretending. See
[docs/setup/web.md](docs/setup/web.md).

The emulated card is plain TypeScript — `createType4Card` answers the same APDU
sequence a DESFire does — so it is tested by playing a reader's whole conversation
through it rather than on a device.

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
edited by hand. See [docs/setup/bare-react-native.md](docs/setup/bare-react-native.md).

## What has not been validated on hardware

Nothing, yet — and that is stated here rather than left to be discovered.
[docs/device-matrix.md](docs/device-matrix.md) is the checklist: 45 rows covering
every claim this library makes, each with the setup that tests it and what "passed"
means. Not one has been run.

The automated suite proves the bookkeeping — including a soak test that runs thirty
iterations of every entry point and asserts nothing is left held. Only a tag proves
the radio, which is why the version is `0.9.0` and why
[RELEASING.md](RELEASING.md) lists what a `1.0.0` needs first.

## Documentation

The full documentation lives under [docs/](docs/) and is built as a Mintlify site
from [docs/docs.json](docs/docs.json). Start at [docs/index.md](docs/index.md), or
go straight to the [setup page for your use case](docs/setup/overview.md).

## Coming from react-native-nfc-manager

There is a migration guide with an API equivalence table, the six differences that
will change your code, and a worked example:
[docs/migrating-from-nfc-manager.md](docs/migrating-from-nfc-manager.md). Both
libraries can be installed side by side, so it can be done a screen at a time.

## Setup, per use case

Most NFC support questions are setup questions, so each page covers one case and
gives both routes — the Expo plugin option, and the exact plist and manifest XML
for a bare project. The bare snippets are generated from the plugin and compared
in CI, so the two cannot drift apart.

| You want to                              | Page                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| Read or write NDEF tags                  | [docs/setup/ndef.md](docs/setup/ndef.md)                             |
| Send APDUs to a smartcard                | [docs/setup/iso7816.md](docs/setup/iso7816.md)                       |
| Read FeliCa cards                        | [docs/setup/felica.md](docs/setup/felica.md)                         |
| Read MIFARE Classic                      | [docs/setup/mifare-classic.md](docs/setup/mifare-classic.md)         |
| Handle a tag that launches your app      | [docs/setup/background-reading.md](docs/setup/background-reading.md) |
| Emulate a card for a terminal            | [docs/setup/hce.md](docs/setup/hce.md)                               |
| Read an Apple Wallet pass                | [docs/setup/vas.md](docs/setup/vas.md)                               |
| Read a tag from a browser                | [docs/setup/web.md](docs/setup/web.md)                               |
| Install into a bare React Native project | [docs/setup/bare-react-native.md](docs/setup/bare-react-native.md)   |

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
| Background tags       | Tested against the fake native module: the launch tag is consumed once, every tag is released even when its handler throws             |
| Web NFC shim          | The record mapping is round-tripped in both directions, and the whole boundary is driven through a fake `NDEFReader`                   |
| Wallet passes         | Validation and decoding tested against the fake native module; the read itself needs an entitlement Apple grants case by case          |
| Card emulation        | The emulated Type 4 tag is driven through a whole reader conversation, using the same functions an app uses to talk to a real card     |
| Config plugin         | 150 tests through Expo's own introspection compiler, so the assertions are about what `expo prebuild` produces                         |
| Leaks                 | 30 iterations of every entry point, asserting no session, no native listener and no handle is left behind                              |
| The documentation     | Every import in a code block is checked against the barrels that define it, and the site's navigation against the files on disk        |
| The published package | `publint` and `arethetypeswrong` against a packed tarball, so a broken `exports` map fails before a user finds it                      |

1342 tests in total, across three Jest projects: one in plain Node for the layers
that need no platform, one under `jest-expo` for everything above the native
boundary, and one for the config plugin.

**What none of that covers:** behaviour against a real tag. No emulator or simulator
can present one. That is [the device matrix](docs/device-matrix.md), it is a release
requirement rather than an afterthought, and none of it has been run.

## Roadmap

| Phase | Contents                                                         | Status                   |
| ----- | ---------------------------------------------------------------- | ------------------------ |
| M0    | Repository scaffold, tooling, CI                                 | done                     |
| M1    | NDEF codec (pure TypeScript, no native)                          | done                     |
| M2    | Android core: reader mode, tech adapters, errors, sessions, tags | done                     |
| M3    | iOS core: session actor, one-shot continuations, tag handles     | done                     |
| M4    | Protocol layers: ISO 7816, ISO 15693, FeliCa, NTAG/Ultralight    | done                     |
| M5    | Config plugin, bare React Native, React hooks                    | done                     |
| M6    | Tag removal reporting, background tag reading                    | done                     |
| M7    | Host card emulation (Android)                                    | done                     |
| M8    | Observe mode, polling loop frames                                | done                     |
| M9    | Web NFC shim, documentation site, migration guide                | done                     |
| M10   | Error reference, device matrix, soak tests, release pipeline     | done, matrix not yet run |

Out of scope, deliberately: Apple's NFC & SE Platform (`CredentialSession`). It requires
an agreement with Apple, ABR onboarding, and an accredited-lab applet security review —
not something a general-purpose library can wrap.

## License

MIT
