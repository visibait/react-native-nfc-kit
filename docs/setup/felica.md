# Reading FeliCa

Suica, PASMO, Octopus, and the rest of the FeliCa family.

```ts
import { readWithoutEncryption } from 'react-native-nfc-kit/protocols';

await nfc.withTag({ tech: ['felica'] }, async (tag) => {
  if (!tag.is('felica')) throw new Error('Not a FeliCa card');
  const blocks = await readWithoutEncryption(tag, { serviceCodes: [0x090f], blocks: [0, 1, 2] });
});
```

## The iOS rule

As with ISO 7816 AIDs, **iOS filters FeliCa at the radio**: a card whose system
code is not declared in Info.plist never reaches the app. No error, no event.

`FFFF` is the wildcard and matches any system code. It is the right value while
you are working out which system code a card uses, and usually the wrong value to
ship, because it means every FeliCa card in the user's wallet is a candidate.

Common system codes: `0003` (the FeliCa standard), `FE00` (FeliCa Lite/Lite-S),
`12FC` (NDEF over FeliCa).

## Expo

```json
{
  "expo": {
    "plugins": [
      [
        "react-native-nfc-kit",
        {
          "readerUsageDescription": "Hold your card near the top of the phone",
          "ios": { "felicaSystemCodes": ["12FC"] }
        }
      ]
    ]
  }
}
```

Each code is exactly two bytes of plain hex. The plugin rejects any other length,
since a wrong-length code is accepted by the build and matches nothing on device.

## Bare React Native

### `ios/<App>/<App>.entitlements`

<!-- generated: felica.entitlements -->

```xml
<key>com.apple.developer.nfc.readersession.formats</key>
<array>
  <string>TAG</string>
</array>
```

<!-- /generated -->

### `ios/<App>/Info.plist`

<!-- generated: felica.infoPlist -->

```xml
<key>NFCReaderUsageDescription</key>
<string>Hold your device near an NFC tag to read it.</string>
<key>com.apple.developer.nfc.readersession.felica.systemcodes</key>
<array>
  <string>12FC</string>
</array>
```

<!-- /generated -->

### `android/app/src/main/AndroidManifest.xml`

<!-- generated: felica.manifest -->

```xml
<uses-permission android:name="android.permission.NFC" />
<uses-feature android:name="android.hardware.nfc" android:required="false" />
<activity android:name=".MainActivity" android:launchMode="singleTop">
  <!-- your existing intent filters stay here -->
</activity>
```

<!-- /generated -->

## Platform differences worth knowing

Both platforms reach FeliCa, but not identically:

- **Polling.** On iOS the session must include the `iso18092` polling option;
  asking for `tech: ['felica']` sets it for you.
- **IDm and PMm.** iOS exposes both on the tag's `ios` facet. Android gives you
  the IDm as the tag id and the PMm through a `polling` command.
- **Frame size.** Android's `maxTransceiveLength` is chipset-dependent and worth
  checking before sending a long multi-block read.
