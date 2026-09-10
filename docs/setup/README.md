# Setup

Most NFC support questions are setup questions. A tag that works on Android and
appears not to exist on iOS, a session that fails to open with an error that never
mentions Info.plist, a tag that stops launching the app after an OS upgrade — all
configuration, none of it visible from the JavaScript.

So each page here covers one use case and gives **both routes**:

- **Expo** — the plugin options to put in `app.json`.
- **Bare React Native** — the exact plist keys and manifest XML to write by hand,
  because a bare project has no `prebuild` to write them for you.

The bare snippets are not transcribed. They are generated from the config plugin
and compared against these files in CI, so the two routes cannot drift apart.

## Pick your page

| You want to                                   | Page                                           |
| --------------------------------------------- | ---------------------------------------------- |
| Read or write NDEF tags                       | [ndef.md](ndef.md)                             |
| Send APDUs to a smartcard (DESFire, JavaCard) | [iso7816.md](iso7816.md)                       |
| Read FeliCa cards                             | [felica.md](felica.md)                         |
| Read MIFARE Classic                           | [mifare-classic.md](mifare-classic.md)         |
| Handle a tag that launches your app           | [background-reading.md](background-reading.md) |
| Emulate a card for a terminal                 | [hce.md](hce.md)                               |
| Read an Apple Wallet pass                     | [vas.md](vas.md)                               |
| Install into a bare React Native project      | [bare-react-native.md](bare-react-native.md)   |

## Before anything else: you need a development build

NFC is native code, so it cannot run in Expo Go. `npx expo run:ios`,
`npx expo run:android`, `eas build` and `eas build --local` all produce a
development build that works.

This is not a temporary state of affairs: Expo Go on the App Store is frozen at
SDK 54, and Expo now positions it as a learning tool rather than a development
target.

## How to check what you actually got

Two commands, in order of how much they tell you:

```bash
# What the plugin will write, without generating any native code.
npx expo config --type prebuild

# Actually generate it, with the plugin's own logging.
EXPO_DEBUG=1 npx expo prebuild --clean
```

Then read the files. On iOS:

```bash
cat ios/*/Info.plist
cat ios/*/*.entitlements
```

On Android:

```bash
cat android/app/src/main/AndroidManifest.xml
cat android/app/src/main/res/xml/nfc_kit_tech_filter.xml
```

If a value you expected is missing, the plugin either was not applied or rejected
your options — it fails the prebuild with a message naming the option rather than
writing something that would match no tag.

## What the plugin refuses to do

Options that would produce a configuration matching nothing are errors, not
warnings:

- An NDEF intent filter with neither a `mimeType` nor a `scheme`.
- A `host` or `pathPrefix` without a `scheme` — Android ignores both, so the
  filter would be far wider than it looks.
- An AID that is not plain hexadecimal, or outside the 5-to-16-byte range that
  ISO 7816 allows.
- A FeliCa system code that is not exactly two bytes.
- An empty tech list, which matches every tag.

Each of these otherwise fails silently at the radio, months later, on someone
else's phone.
