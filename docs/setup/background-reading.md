# Background tag reading

Configure this only to handle a tag tapped while your app is **closed or in the
background**. Reader mode — `nfc.withTag`, `nfc.openSession`, `nfc.onTag` — needs
none of it, and adding it unnecessarily means unrelated tags start launching your
app.

## Reading the tag

Two entry points, because a tag that started the app and a tag that arrived while
it was running are genuinely different situations.

```ts
// The app was not running and a tap started it. Safe to call on every launch:
// it answers null when a tag was not the reason.
const ticket = await nfc.withLaunchTag(async (tag) =>
  tag.is('ndef') ? decodeMessage(await tag.readNdef()) : null,
);

// The app was in the background, or on another screen.
const subscription = nfc.onBackgroundTag(async (tag) => {
  if (tag.is('ndef')) await handle(await tag.readNdef());
});
```

Both hand the tag to a callback and release it afterwards, the way `withTag`
does. A native handle that outlives its scope is a leak whose failure surfaces
somewhere else entirely, so there is no version of these that hands one out and
trusts you to give it back.

**`readNdef()` works; the radio usually does not.** By the time any JavaScript
runs, the card has almost always left the field — the user tapped and pocketed
it. What survives is the message the system read before dispatching the intent,
which travelled with it, so reading NDEF still answers. Anything needing the
radio (`transceive`, `writeNdef`, `getNdefStatus`) fails with `tagLost` unless the
card genuinely is still there.

`withLaunchTag` consumes the tag: a second call answers `null`. That is also what
stops a screen rotation from replaying a tap from minutes ago, since the recreated
activity is handed the same launch intent.

`tag.onLost` never fires for a background tag. It is not being watched, because a
watcher would do nothing but announce a departure that happened before the app was
looking.

## Expo

```json
{
  "expo": {
    "plugins": [
      [
        "react-native-nfc-kit",
        {
          "android": {
            "backgroundReading": {
              "ndef": [{ "mimeType": "application/vnd.ventry.ticket" }],
              "techLists": [["isoDep"], ["mifareUltralight", "ndef"]]
            },
            "dispatchNfcMessagePermission": true
          }
        }
      ]
    ]
  }
}
```

### NDEF filters

Each entry becomes one intent filter, matched against the **first record** of the
tag's message. Filter on a MIME type you control, or on your own URI scheme.

They are kept as separate filters rather than merged, because Android combines
sibling `<data>` attributes combinatorially: one filter holding both
`scheme="https"` and `mimeType="text/plain"` matches any https URI _or_ any
text/plain payload, which is not what the config appears to say.

One caveat that catches people out: from Android 16, an NDEF tag holding an
`http` or `https` URI dispatches `ACTION_VIEW` instead of `ACTION_NDEF_DISCOVERED`,
so a scheme filter for those two no longer fires on newer devices. Your own scheme
and MIME-type filters are unaffected.

### Tech lists

Each inner array is one `<tech-list>`, and a tag matches when it supports **every**
technology in that list. Separate lists are alternatives. So the example above
matches an ISO-DEP tag, or a tag that is both MIFARE Ultralight and NDEF.

`ACTION_TAG_DISCOVERED` is never written. It is deprecated as of API 37, and it is
also the widest filter there is — it fires for any tag at all, including ones your
app has no idea what to do with.

### iOS

There is nothing to configure. iOS reads NDEF tags in the background on its own,
without the app being involved, and opens a URL record's link. It cannot be
extended to other technologies and cannot be turned off by an app.

## The Android 17 permission

From Android 17 (API 37), an activity receiving NFC intents must be protected by
`android.permission.DISPATCH_NFC_MESSAGE` when the app targets an SDK above
`BAKLAVA`, so that only the NFC system service can dispatch to it.

The trap is that `android:permission` on an activity applies on **every** Android
version, and a permission the running platform does not define can be held by
nobody — so applying it on a device older than API 37 stands to block the very
dispatch it is meant to secure. One manifest ships to every version, so this is a
real choice, not a formality.

`dispatchNfcMessagePermission` therefore defaults to `'auto'`, which is narrow on
purpose:

| Setting  | Behaviour                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'auto'` | Applied only with background reading configured **and** a target SDK of 37 or higher readable from `expo-build-properties`. Warns instead of guessing when the target SDK is unknown. |
| `true`   | Always applied.                                                                                                                                                                       |
| `false`  | Never applied.                                                                                                                                                                        |

To let `'auto'` decide, declare the target SDK explicitly:

```json
["expo-build-properties", { "android": { "targetSdkVersion": 37 } }]
```

**This is provisional.** The behaviour above follows from the Android 17
documentation and has not been validated on API 37 hardware. If you are testing on
a device that new, `dispatchNfcMessagePermission` lets you decide it outright, and
a report either way is welcome.

## Bare React Native

### `android/app/src/main/AndroidManifest.xml`

<!-- generated: background-reading.manifest -->

```xml
<uses-permission android:name="android.permission.NFC" />
<uses-feature android:name="android.hardware.nfc" android:required="false" />
<activity android:name=".MainActivity" android:launchMode="singleTop" android:permission="android.permission.DISPATCH_NFC_MESSAGE">
  <!-- your existing intent filters stay here -->
  <intent-filter>
    <action android:name="android.nfc.action.NDEF_DISCOVERED" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="application/vnd.ventry.ticket" />
  </intent-filter>
  <intent-filter>
    <action android:name="android.nfc.action.TECH_DISCOVERED" />
  </intent-filter>
  <meta-data android:name="android.nfc.action.TECH_DISCOVERED" android:resource="@xml/nfc_kit_tech_filter" />
</activity>
```

<!-- /generated -->

### `android/app/src/main/res/xml/nfc_kit_tech_filter.xml`

<!-- generated: background-reading.techFilter -->

```xml
<resources>
  <tech-list>
    <tech>android.nfc.tech.IsoDep</tech>
  </tech-list>
  <tech-list>
    <tech>android.nfc.tech.MifareUltralight</tech>
    <tech>android.nfc.tech.Ndef</tech>
  </tech-list>
</resources>
```

<!-- /generated -->

The file name is arbitrary in a bare project — what matters is that the
`<meta-data>` above points at it — but keeping this name means a later `prebuild`
would overwrite the same file rather than leaving two.

### iOS

<!-- generated: background-reading.entitlements -->

```xml
<key>com.apple.developer.nfc.readersession.formats</key>
<array>
  <string>TAG</string>
</array>
```

<!-- /generated -->

<!-- generated: background-reading.infoPlist -->

```xml
<key>NFCReaderUsageDescription</key>
<string>Hold your device near an NFC tag to read it.</string>
```

<!-- /generated -->

Unchanged from the default setup: background reading is an Android-only
configuration.

## Checking it works

```bash
adb shell dumpsys package <your.package> | grep -A5 NDEF_DISCOVERED
```

Then tap a matching tag with the app closed. If nothing happens, in order of
likelihood: the first record does not match the filter, the activity is missing
`singleTop`, or you are on API 37 with the permission set the wrong way.
