# Reading and writing NDEF

This is the default setup: nothing to configure beyond installing the plugin.

```ts
const message = await nfc.withTag({ tech: ['ndef'], timeoutMs: 20_000 }, async (tag) => {
  if (!tag.is('ndef')) throw new Error('Not an NDEF tag');
  return tag.readNdef();
});
```

## Expo

```json
{
  "expo": {
    "plugins": [
      [
        "react-native-nfc-kit",
        { "readerUsageDescription": "Hold your card near the top of the phone" }
      ]
    ]
  }
}
```

`readerUsageDescription` is the text iOS shows in the scanning sheet. A default is
supplied, because iOS refuses to create a session when the key is missing or blank
and the resulting error says nothing about Info.plist — but the default is generic,
and this string is the only explanation your user gets for why the phone is asking
about a card. Write your own.

## Bare React Native

### `ios/<App>/<App>.entitlements`

<!-- generated: default.entitlements -->

```xml
<key>com.apple.developer.nfc.readersession.formats</key>
<array>
  <string>TAG</string>
</array>
```

<!-- /generated -->

`TAG` rather than `NDEF` is deliberate. This library uses `NFCTagReaderSession`
for every technology, NDEF included, so that one code path covers them all — and
that session type requires the `TAG` format. A narrower entitlement would read
better in a review and fail at runtime.

The entitlement also has to exist on the provisioning profile: in the Apple
Developer portal, enable **Near Field Communication Tag Reading** for the App ID,
then regenerate the profile. Xcode's "Automatically manage signing" does this for
you; a manually managed profile does not.

### `ios/<App>/Info.plist`

<!-- generated: default.infoPlist -->

```xml
<key>NFCReaderUsageDescription</key>
<string>Hold your device near an NFC tag to read it.</string>
```

<!-- /generated -->

### `android/app/src/main/AndroidManifest.xml`

<!-- generated: default.manifest -->

```xml
<uses-permission android:name="android.permission.NFC" />
<uses-feature android:name="android.hardware.nfc" android:required="false" />
<activity android:name=".MainActivity" android:launchMode="singleTop">
  <!-- your existing intent filters stay here -->
</activity>
```

<!-- /generated -->

`android:required="false"` keeps the app installable on devices without an NFC
controller. Set `requireNfcHardware: true` only if the app is useless without it —
`true` removes those devices from your Play Store audience entirely.

`singleTop` is not optional. Without it Android recreates the activity every time
a tag arrives through an intent, losing whatever was in flight. It is applied
unconditionally because it is harmless when no intents are configured.

## Writing

Writing needs no extra configuration, but it does need the tag to allow it:

```ts
await nfc.withTag({ tech: ['ndef'] }, async (tag) => {
  if (!tag.is('ndef')) throw new Error('Not an NDEF tag');

  const status = await tag.getNdefStatus();
  if (!status.writable) throw new Error('This tag is locked');
  if (status.capacity < bytes.length) throw new Error('Message too large for this tag');

  await tag.writeNdef(bytes);
});
```

A blank factory tag is often _NDEF formatable_ rather than NDEF, which is a
different technology: ask for `tech: ['ndef', 'ndefFormatable']` and narrow with
`tag.is('ndefFormatable')` to format it on first write.
