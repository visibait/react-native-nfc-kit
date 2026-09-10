---
'react-native-nfc-kit': major
---

First stable release.

Everything is in place and validated on hardware: reading and writing on both
platforms, the protocol layers over one native primitive, card emulation on Android
including observe mode, background and launch tags, Apple Wallet passes, React hooks,
and the same API in a browser over Web NFC.

Nothing in the public API changes from `0.9.0`. The version says what has changed
about confidence rather than about code: the library has been used against real tags
and real readers, which is the one thing no amount of CI could establish.
