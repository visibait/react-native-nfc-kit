---
title: react-native-nfc-kit
description: Modern, typed NFC for React Native and Expo. New Architecture native, Swift and Kotlin, sessions that cannot leak.
---

NFC for React Native and Expo, built on the Expo Modules API. New Architecture
only, TypeScript throughout, and the asymmetry between iOS and Android visible in
the type system rather than discovered in production.

```ts
import { nfc } from 'react-native-nfc-kit';

const message = await nfc.withTag({ tech: ['ndef'], timeoutMs: 20_000 }, async (tag) => {
  if (!tag.is('ndef')) throw new Error('Not an NDEF tag');
  return tag.readNdef();
});
```

## Two things to know before reading further

**A tag carries no technology methods until you narrow it.** `tag.is('ndef')` is
what makes `readNdef` exist, in the type system and at runtime. That is how the
platform difference stays visible: on iOS `tag.is('mifareClassic')` is always
`false`, because CoreNFC cannot reach Crypto-1 at any OS version.

**`withTag` always closes the session.** On success, on a throw, on an abort, on a
timeout, and when the platform ends the session underneath. A leaked session keeps
the iOS sheet up and holds Android's NFC controller exclusively, which is the
failure that surfaces two screens later as something unrelated.

## What is here

| Entry point                      | What it is                                                       |
| -------------------------------- | ---------------------------------------------------------------- |
| `react-native-nfc-kit`           | Reading and writing tags: sessions, tags, errors                 |
| `react-native-nfc-kit/ndef`      | The NDEF codec. No native dependency, so it runs in Node too     |
| `react-native-nfc-kit/protocols` | ISO 7816, ISO 15693, FeliCa, NTAG/Ultralight, over one primitive |
| `react-native-nfc-kit/hce`       | Card emulation: answer a terminal as though you were a card      |
| `react-native-nfc-kit/vas`       | Read an Apple Wallet pass                                        |
| `react-native-nfc-kit/react`     | Hooks, on a subpath so the core never imports React              |

## You need a development build

NFC is native code, so it cannot run in Expo Go. `npx expo run:ios`,
`npx expo run:android`, `eas build` and `eas build --local` all produce a build
that works. This is not temporary: Expo Go on the App Store is frozen at SDK 54,
and Expo positions it as a learning tool rather than a development target.

## Where to go next

- **[Setup](setup/overview)** — the page for your use case, with both the Expo
  plugin option and the exact plist and manifest XML for a bare project.
- **[The NDEF codec](ndef)** — building and parsing messages, with or without a
  device.
- **[Coming from react-native-nfc-manager](migrating-from-nfc-manager)** — an API
  equivalence table and the differences that will change your code.
