---
'react-native-nfc-kit': minor
---

Keep tags away from the system while the app is in front.

On Android, a tag on the reader at a moment when no session holds reader mode goes to the system's own dispatcher. On most devices that shows a "new tag" screen over the app; on a device with more than one app declaring the same technology it shows Android's "choose an app" screen. To the person holding the phone, both look like the reader has stopped working. Several gaps let that happen, and they are closed here.

- `android.readerLingerMs` (new session option, 0–10000): when a session closes, reader mode stays on for that long, still registered but ignoring what it is given, and a session opened within the window takes it over without reader mode ever going off. Without it, closing a session and opening the next one left a few seconds in which a tag still on the reader was handed to the system.
- Foreground dispatch for background tags: an app that declares `backgroundReading.techLists` now also claims those tags while its activity is resumed, for exactly the declared tech lists. They reach the app through `onNewIntent`, the same path a background tag takes, instead of the system chooser. Reader mode still takes precedence whenever a session is open; this covers the moments with no session, such as between two screens or while JavaScript reloads. On Android 15 and later the pending intent opts in to starting the activity only while the app is visible, so the system no longer logs (or applies) a background-activity-launch block for it. Nothing is claimed unless the app declared background reading.
- Reader mode is no longer switched off when it is not on. The call is not free: it restarts polling, so a tag resting on the reader was discovered again and dispatched. A JavaScript reload made two such calls during teardown.
- `onSessionInvalidated` is now emitted when the session dies natively (teardown, NFC switched off), and `onAvailabilityChanged` when the adapter is switched on or off, so JavaScript can reopen instead of waiting on a session that no longer exists.
- Tag handles of a session are released when their tag leaves the field, and closed on the tag I/O thread when the session ends, instead of accumulating for the life of the session.

The native contract version is now 7.
