# react-native-nfc-kit

## 2.1.0

### Minor Changes

- d1a3d89: Report where the device's NFC antenna is, and whether Secure NFC is on.

  `nfc.getAntennaInfo()` answers with the device's dimensions in millimetres and the
  position of each NFC antenna within them, which is what turns "hold the card here"
  into a hint drawn in the right place instead of in the middle of the screen. Android
  14 and later, through `NfcAdapter.getNfcAntennaInfo`. It resolves `null` — never
  rejects — on iOS, on the web, below Android 14, and on the many Android 14 devices
  whose manufacturer left the numbers empty, so a screen laying out a hint needs no
  try/catch and still has to keep its generic fallback.

  `nfc.isSecureNfcEnabled()` reports Android's Secure NFC setting, which restricts NFC
  to an unlocked screen and is the usual explanation for a background or launch tag
  that silently does nothing on one device and works on another. Android 10 and later;
  `false` where the setting does not exist. It is a call rather than a capability
  because the user can change it while the app is running.

  Both are reflected in `nfc.capabilities` as `antennaInfo` and `secureNfc`, and there
  is a new page in the docs covering the coordinate system, foldables, and why `null`
  is a normal answer.

  **This bumps the native contract to version 6, so a development build has to be
  rebuilt.** Updating the JavaScript alone leaves the installed binary reporting
  version 5, and every call will fail with `contractMismatch` until
  `npx expo run:android`, `npx expo run:ios` or an EAS build has run again.

## 2.0.0

### Major Changes

- ef9f71c: First stable release.

  Everything is in place and validated on hardware: reading and writing on both
  platforms, the protocol layers over one native primitive, card emulation on Android
  including observe mode, background and launch tags, Apple Wallet passes, React hooks,
  and the same API in a browser over Web NFC.
