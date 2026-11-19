# react-native-nfc-kit

## 2.2.0

### Minor Changes

- c8243fb: Keep tags away from the system while the app is in front.

  On Android, a tag on the reader at a moment when no session holds reader mode goes to the system's own dispatcher. On most devices that shows a "new tag" screen over the app; on a device with more than one app declaring the same technology it shows Android's "choose an app" screen. To the person holding the phone, both look like the reader has stopped working. Several gaps let that happen, and they are closed here.

  - `android.readerLingerMs` (new session option, 0–10000): when a session closes, reader mode stays on for that long, still registered but ignoring what it is given, and a session opened within the window takes it over without reader mode ever going off. Without it, closing a session and opening the next one left a few seconds in which a tag still on the reader was handed to the system.
  - Foreground dispatch for background tags: an app that declares `backgroundReading.techLists` now also claims those tags while its activity is resumed, for exactly the declared tech lists. They reach the app through `onNewIntent`, the same path a background tag takes, instead of the system chooser. Reader mode still takes precedence whenever a session is open; this covers the moments with no session, such as between two screens or while JavaScript reloads. On Android 15 and later the pending intent opts in to starting the activity only while the app is visible, so the system no longer logs (or applies) a background-activity-launch block for it. Nothing is claimed unless the app declared background reading.
  - Reader mode is no longer switched off when it is not on. The call is not free: it restarts polling, so a tag resting on the reader was discovered again and dispatched. A JavaScript reload made two such calls during teardown.
  - `onSessionInvalidated` is now emitted when the session dies natively (teardown, NFC switched off), and `onAvailabilityChanged` when the adapter is switched on or off, so JavaScript can reopen instead of waiting on a session that no longer exists.
  - Tag handles of a session are released when their tag leaves the field, and closed on the tag I/O thread when the session ends, instead of accumulating for the life of the session.

  The native contract version is now 7.

## 2.1.1

### Patch Changes

- 4688a58: Closing a tag that Android has already invalidated no longer throws.

  Once a tag leaves the field and another one is discovered, or reader mode is
  restarted, Android invalidates the old `Tag`, and closing its connection throws
  `SecurityException: Tag ( ID: ... ) is out of date`. Only `IOException` was
  caught, so the exception escaped from the module's teardown: on Android it
  aborted destroying the React host, which showed up as a failed reload in a
  development build and as a crash when the app's React context was torn down in
  production. A stale tag has nothing to close, so it is now treated like one
  that has already gone.

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
