# Changelog

Generated from changesets from `0.9.1` onwards. This first entry is written by hand,
because everything below it predates the changeset workflow.

## 0.9.0

The first version worth installing. Every layer is present and tested; what is
missing is hardware validation, which is why this is not a `1.0.0` — see
[docs/device-matrix.md](docs/device-matrix.md), where not one row has been run yet.

### Reading and writing

- `nfc.withTag`, which closes the session on every path, including a throw, an abort,
  a timeout, and the platform ending the session underneath.
- `nfc.openSession` for reading several tags with your own UI in between, as an
  `AsyncDisposable` so `await using` works — with a fallback for engines that lack
  `Symbol.asyncDispose`, which includes Hermes.
- `nfc.onTag` for continuous reading, tied to subscriber count so reader mode is only
  active while something is listening.
- Tags as a discriminated union: `tag.is('ndef')` is what makes `readNdef` exist, in
  the type system and at runtime. On iOS `tag.is('mifareClassic')` is always `false`.
- Every rejection is an `NfcError` with a `code`, a `platform`, the original
  `nativeCode`, and whether retrying is worth it. See
  [docs/errors.md](docs/errors.md).

### Layers that need no device

- `react-native-nfc-kit/ndef` — the NDEF codec, at 100% branch coverage: chunked
  records, UTF-16 text, the 36-entry URI prefix table both ways, Smart Posters, Type 2
  TLV, and the Type 4 capability container.
- `react-native-nfc-kit/protocols` — ISO 7816 with command chaining and `61xx`/`6Cxx`
  handling, ISO 15693, FeliCa, NTAG/Ultralight, all over one native primitive.

### Platform surfaces

- Android reports tag removal (`tag.onLost`), by polling below API 37 and from the
  platform above it, deduplicated so it can only fire once.
- Background tags: `nfc.withLaunchTag` and `nfc.onBackgroundTag`, with the launch
  intent consumed so a screen rotation cannot replay a tap.
- `react-native-nfc-kit/hce` — card emulation on Android, including an emulated Type 4
  tag written in TypeScript, observe mode, and polling loop frames.
- `react-native-nfc-kit/vas` — reading an Apple Wallet pass. Needs an entitlement
  Apple grants case by case.
- `react-native-nfc-kit/react` — hooks, on a subpath so the core never imports React.
- Web NFC: the same API in a browser, implemented over the same native contract.

### Tooling

- A config plugin that writes exactly what each option requires and removes it again
  when the option goes away, with `dispatchNfcMessagePermission` refusing to guess.
- Setup documentation generated from the plugin itself, so the Expo and bare routes
  cannot drift.
- `CONTRACT_VERSION`, so a bundle newer than the installed binary says "rebuild the
  development build" rather than failing on an undefined method.
