---
'react-native-nfc-kit': patch
---

Closing a tag that Android has already invalidated no longer throws.

Once a tag leaves the field and another one is discovered, or reader mode is
restarted, Android invalidates the old `Tag`, and closing its connection throws
`SecurityException: Tag ( ID: ... ) is out of date`. Only `IOException` was
caught, so the exception escaped from the module's teardown: on Android it
aborted destroying the React host, which showed up as a failed reload in a
development build and as a crash when the app's React context was torn down in
production. A stale tag has nothing to close, so it is now treated like one
that has already gone.
