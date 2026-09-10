<div align="center">

<a href="https://react-native-nfc-kit.mintlify.site/">
  <img src="https://raw.githubusercontent.com/visibait/react-native-nfc-kit/main/.github/assets/banner.jpg" alt="react-native-nfc-kit — modern, fully-typed NFC for React Native and Expo" width="100%">
</a>

<br>
<br>

[![npm](https://img.shields.io/npm/v/react-native-nfc-kit?color=6D5AE6&labelColor=1B1B22)](https://www.npmjs.com/package/react-native-nfc-kit)
[![downloads](https://img.shields.io/npm/dm/react-native-nfc-kit?color=6D5AE6&labelColor=1B1B22)](https://www.npmjs.com/package/react-native-nfc-kit)
[![CI](https://img.shields.io/github/actions/workflow/status/visibait/react-native-nfc-kit/ci.yml?branch=main&label=CI&color=6D5AE6&labelColor=1B1B22)](https://github.com/visibait/react-native-nfc-kit/actions/workflows/ci.yml)
[![types](https://img.shields.io/badge/types-included-6D5AE6?labelColor=1B1B22)](https://www.npmjs.com/package/react-native-nfc-kit)
[![license](https://img.shields.io/npm/l/react-native-nfc-kit?color=6D5AE6&labelColor=1B1B22)](LICENSE)

**[Documentation](https://react-native-nfc-kit.mintlify.site/)** &nbsp;·&nbsp;
[Quickstart](https://react-native-nfc-kit.mintlify.site/quickstart) &nbsp;·&nbsp;
[Setup guides](https://react-native-nfc-kit.mintlify.site/setup/overview) &nbsp;·&nbsp;
[Errors](https://react-native-nfc-kit.mintlify.site/errors) &nbsp;·&nbsp;
[Migrating from nfc-manager](https://react-native-nfc-kit.mintlify.site/migrating-from-nfc-manager)

</div>

<br>

## Install

```bash
npx expo install react-native-nfc-kit
npx expo prebuild --clean
```

> [!IMPORTANT]
> **NFC needs a development build.** It is native code, so Expo Go cannot load it.
> `npx expo run:android`, `npx expo run:ios` or `eas build` all work.

Read a tag in about ten lines, and the session cannot leak:

```ts
import { nfc } from 'react-native-nfc-kit';

const message = await nfc.withTag({ tech: ['ndef'], timeoutMs: 20_000 }, async (tag) => {
  if (!tag.is('ndef')) throw new Error('Not an NDEF tag');
  return tag.readNdef();
});
```

<br>

## Why you might want this one

**Your editor knows what the platform can do.** A `Tag` is a discriminated union, so
technology methods only exist after you narrow:

```ts
if (tag.is('isoDep')) {
  const response = await tag.transceive(command); // ✅ exists here
}
await tag.transceive(command); // ❌ does not compile
```

On iOS `tag.is('mifareClassic')` is always `false`, because CoreNFC genuinely cannot
reach it. You find that out from your editor rather than from a support ticket.

**Sessions close themselves.** `withTag` closes on every path — returning, throwing,
an `AbortSignal` firing, a timeout, the platform ending the session underneath. A
leaked session keeps the iOS sheet up and holds Android's NFC controller, and the
symptom appears two screens later.

**Errors you can branch on.** Every rejection is an `NfcError` with a stable `code`,
the original `nativeCode`, a `cause`, and whether retrying is worth it:

```ts
if (NfcError.is(error, 'userCancelled')) return; // not a failure
if (NfcError.is(error, 'tagLost')) return retry();
```

**Bytes are `Uint8Array`.** Not arrays of boxed numbers. A 1 KB APDU response is 1 KB.

**Cancellation and timeouts everywhere.** Every awaitable takes an `AbortSignal` and
a `timeoutMs`, and aborting before the call reaches the radio does not touch it.

<br>

## What you can do with it

| Import                           | What it gives you                                                              |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `react-native-nfc-kit`           | Read and write tags: sessions, tags, errors, availability                      |
| `react-native-nfc-kit/ndef`      | The NDEF codec — no native dependency, so it also runs in Node and the browser |
| `react-native-nfc-kit/protocols` | ISO 7816 (with chaining and `61xx`/`6Cxx`), ISO 15693, FeliCa, NTAG/Ultralight |
| `react-native-nfc-kit/hce`       | Card emulation: answer a terminal as though the phone were a card              |
| `react-native-nfc-kit/vas`       | Read an Apple Wallet pass                                                      |
| `react-native-nfc-kit/react`     | `useNfcAvailability`, `useNfcScan`, `useNfcTagStream`                          |

```ts
// Continuous reading, for a door or a check-in desk
const subscription = nfc.onTag({ tech: ['isoDep'] }, async (tag) => {
  if (tag.is('isoDep')) await validateTicket(tag);
});

// Be a card, not a reader
const session = await hce.emulateNdef(encodeMessage([createUriRecord(url)]));

// A tag that launched the app
const ticket = await nfc.withLaunchTag((tag) => (tag.is('ndef') ? tag.readNdef() : null));
```

<br>

## What works where

The interesting column is the one that says no. None of this is hidden behind a
method that exists and then throws — `nfc.capabilities` and `tag.is()` tell you at
runtime, and the types tell you before that.

| Feature                      |          iOS          | Android | Web (Chrome) |
| ---------------------------- | :-------------------: | :-----: | :----------: |
| Read and write NDEF          |          ✅           |   ✅    |      ✅      |
| ISO 7816 / ISO-DEP APDUs     |          ✅           |   ✅    |      —       |
| ISO 15693, FeliCa            |          ✅           |   ✅    |      —       |
| NTAG / MIFARE Ultralight     |          ✅           |   ✅    |      —       |
| MIFARE Classic               |           —           | chipset |      —       |
| Raw `NfcA` / `NfcB`          |           —           |   ✅    |      —       |
| Tag-removal callback         |           —           |   ✅    |      —       |
| Background / launch tags     |    system-handled     |   ✅    |      —       |
| Card emulation (HCE)         | entitlement, EEA only |   ✅    |      —       |
| Observe mode, polling frames |           —           | API 35+ |      —       |
| Apple Wallet passes (VAS)    |      entitlement      |    —    |      —       |
| Antenna location             |           —           | API 34+ |      —       |
| Secure NFC status            |           —           | API 29+ |      —       |

<br>

## Requirements

|                     | Minimum                     |
| ------------------- | --------------------------- |
| Expo SDK            | 57 (React Native 0.86)      |
| React Native (bare) | 0.86, with `expo` installed |
| iOS                 | 16.4, physical device       |
| Android             | API 24                      |
| Node                | 20.19.4 / 22.13 / 24.3+     |

New Architecture only. Bare React Native works too — Expo Modules need the `expo`
package, not the whole SDK. See
[the bare React Native guide](https://react-native-nfc-kit.mintlify.site/setup/bare-react-native).

<br>

## Setup, per use case

Most NFC support questions are setup questions, so there is one page per case. Each
gives both routes: the Expo plugin option, and the exact plist and manifest XML for a
bare project. The bare snippets are generated from the plugin itself, so the two
cannot drift.

| You want to                         | Page                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| Read or write NDEF tags             | [NDEF](https://react-native-nfc-kit.mintlify.site/setup/ndef)                           |
| Send APDUs to a smartcard           | [ISO 7816](https://react-native-nfc-kit.mintlify.site/setup/iso7816)                    |
| Read FeliCa cards                   | [FeliCa](https://react-native-nfc-kit.mintlify.site/setup/felica)                       |
| Read MIFARE Classic                 | [MIFARE Classic](https://react-native-nfc-kit.mintlify.site/setup/mifare-classic)       |
| Handle a tag that launches your app | [Background tags](https://react-native-nfc-kit.mintlify.site/setup/background-reading)  |
| Emulate a card for a terminal       | [Card emulation](https://react-native-nfc-kit.mintlify.site/setup/hce)                  |
| Read an Apple Wallet pass           | [Apple Wallet](https://react-native-nfc-kit.mintlify.site/setup/vas)                    |
| Read a tag from a browser           | [Web NFC](https://react-native-nfc-kit.mintlify.site/setup/web)                         |
| Install without the Expo SDK        | [Bare React Native](https://react-native-nfc-kit.mintlify.site/setup/bare-react-native) |

Also worth knowing about: [the error reference](https://react-native-nfc-kit.mintlify.site/errors), with every
`NfcErrorCode`, what causes it and what to do about it.

<br>

## Coming from react-native-nfc-manager

Both libraries can be installed side by side, so you can migrate one screen at a
time. [The migration guide](https://react-native-nfc-kit.mintlify.site/migrating-from-nfc-manager) has an API
equivalence table, the differences that actually change calling code, and a worked
before-and-after.

<br>

## How this is verified

Nothing here is claimed to work because it looks right.

- **1342 tests.** The NDEF codec, the protocol layers, card emulation, the Web NFC
  shim, the React hooks and the config plugin are each at **100% coverage** — they
  are byte logic and plain objects, so an uncovered branch is an untested branch.
- **A soak test**, because "it works the first five times" is the failure that
  matters: thirty iterations of every entry point, then an assertion that no session,
  no native listener and no tag handle is left behind.
- **Real native builds in CI.** `compileDebugKotlin` and a full `assembleDebug` on
  Android; `pod install` and `xcodebuild` against real CoreNFC on macOS. Plus a check
  that autolinking actually registers the module, because compiling proves the code
  is valid and not that it is reachable.
- **The config plugin is tested through Expo's own prebuild**, so the assertions are
  about what `expo prebuild` produces rather than about a reimplementation of it.
- **The published package** is checked with `publint` and `arethetypeswrong` against a
  packed tarball, so a broken `exports` map fails before a user finds it.
- **The documentation is checked too**: every import in every code block is resolved
  against the barrel that defines it.

What none of that covers is behaviour against a real tag — no emulator can present
one. [The device matrix](https://react-native-nfc-kit.mintlify.site/device-matrix) is the reproducible checklist for
that, and it is the right place to look if you hit something on a device or chipset
combination you would like covered.

<br>

<div align="center">

**MIT** © [visibait](https://github.com/visibait)

<sub>Made for production NFC by the team behind <b>Ventry</b>.</sub>

</div>
