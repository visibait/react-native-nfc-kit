# Card emulation (HCE)

Making the phone answer a terminal as though it were a card: a door reader, a
turnstile, a check-in desk, another phone.

```ts
import { hce } from 'react-native-nfc-kit/hce';
import { createUriRecord, encodeMessage } from 'react-native-nfc-kit/ndef';

const session = await hce.emulateNdef(
  encodeMessage([createUriRecord('https://www.ventry.es/entrada')]),
);
// later
await session.stop();
```

## Two things to know before you build on this

**Android only.** iOS has had `CardSession` since 17.4, but it needs the
`com.apple.developer.nfc.hce` entitlement, which Apple grants case by case after a
request describing your use, and it works only in the EEA. That is not a
capability a library can offer, so `hce.isSupported()` answers `false` on iOS and
every other call rejects with `unsupportedPlatform`. Check `isSupported()` rather
than the platform.

**Your app has to be running.** Android starts its HCE service when a terminal
taps, with no reference to any Activity and no guarantee that a JavaScript runtime
exists. When yours does not, the terminal is answered `6F00` — a definite refusal,
so it reports "card not supported" instead of waiting for its own timeout and
reporting a hardware fault. If you need a card that answers with the app killed,
that is a native implementation, not this.

There is also a deadline per command, one second by default. Native enforces it,
because JavaScript is exactly what might be too busy to notice, and answers on
your behalf when it elapses.

## Expo

```json
{
  "expo": {
    "plugins": [
      [
        "react-native-nfc-kit",
        {
          "android": {
            "hce": {
              "description": "Ventry building access",
              "aidGroups": [{ "description": "Doors", "aids": ["F0010203040506"] }]
            }
          }
        }
      ]
    ]
  }
}
```

Leave `hce` out and no service is declared at all, which is what an app that only
reads tags wants — a declared service keeps the app registered as a card emulator,
so terminals keep selecting it.

### The AIDs

An AID is what a terminal asks for. Yours has to match what the terminal selects,
and it is 5 to 16 bytes of plain hexadecimal — the plugin rejects anything else,
because Android rejects it when the resource is compiled and by then the message is
about a resource, not about NFC.

For a closed system you control both ends of, use a registered RID or a value in
the `F0`-prefixed proprietary range. For an existing terminal, the AID is whatever
that terminal was built to select; you cannot choose it.

`hce.start({ aids })` registers them at runtime instead, which is what makes
changing an AID not require a new build. The service still has to be declared, and
the manifest's AIDs are what the app answers for before any JavaScript has run.

### `description`

Required by Android, and the user sees it in system settings next to other apps'
card emulation services. Name what your app does with it — "Ventry building
access" — rather than the technology.

### `requireDeviceUnlock`

Defaults to `false`. Set it to `true` for anything that authorises something: a
door, a payment. Leave it `false` for a public identifier, because a locked phone
gives the terminal no answer at all and the user has no way to tell why.

## What is not supported, and why

**The `payment` category.** An HCE service in that category needs a 260×96 banner
drawable and the user actively choosing your app as their default wallet — neither
of which a config plugin can arrange, and the second of which is a flow your app
has to run deliberately. Everything here uses the `other` category, which is the
right one for access control and ticketing.

**`setDiscoveryTechnology`** (Android 15, API 35). It restricts what the phone
polls for and listens to, but the only way to use it for reading is to give up
reader mode and take tags through intents instead — which is the acquisition model
this library deliberately does not use, because it brings back the `onPause`
churn and the two-different-event-sequences problem. Restricting _emulation_ is
what `preferSelf` and observe mode below already do.

## Not answering straight away

By default a card answers the moment a terminal selects it. That is wrong for
anything that authorises something: the user should be asked first, and asking
takes time the terminal is not going to wait for.

Observe mode is the platform's answer. The phone acknowledges the reader — so the
reader does not keep polling and give up — but the card stays silent until the app
says otherwise. Combined with the polling loop frames, an app can tell a reader is
there before any of its own code has been selected:

```ts
const session = await hce.start({
  onCommand: (apdu) => card.handle(apdu),
  observeMode: true,
  onPollingFrames: (frames) => {
    // A reader is present. Nothing has been answered yet.
    if (frames.some((frame) => frame.type === 'a')) askUserToConfirm();
  },
  onDeactivated: () => {
    // Back to silent for the next reader.
    void session.setObserveMode(true);
  },
});

// When the user confirms:
await session.setObserveMode(false);
```

Three things worth knowing:

- **It is not universally available.** Android 15 and later, _and_ a hardware
  capability on top of that: plenty of API 35 devices answer `false`. Check
  `nfc.capabilities.observeMode`, and read `session.observeMode` rather than
  assuming your request took effect — believing the card is silent while it is
  answering is the worst outcome available here, because the user is never asked
  and the transaction happens anyway.
- **The platform grants it only to the service it prefers.** That is what
  `preferSelf` (on by default) asks for, and it needs a foreground activity, so
  `session.preferred` tells you whether it was granted. Without it, observe mode
  and polling frames are both unavailable.
- **It is left off when the session stops.** Leaving it on would hold every other
  card emulation app on the device silent, and nothing else would turn it off.

### Polling loop filters

By default a preferred service sees the frames while the app is in front.
Registering filters asks for specific ones:

```ts
await hce.start({
  onCommand,
  pollingLoopFilters: [
    { pattern: '6a' }, // frames whose data starts with these bytes
    { pattern: '6a.*', isPattern: true, autoTransact: true },
  ],
});
```

`autoTransact` tells the platform to leave observe mode by itself on a match. That
is the low-latency route for a reader you already trust, and it gives up the
confirmation step observe mode exists to allow — a decision about trust rather than
about speed.

A frame's `gain` is vendor-specific, `-1` when the controller does not report it,
and not a distance. Its `timestamp` is the platform's own monotonic value: sound
for ordering frames and measuring the gap between them, and nothing else.

## Bare React Native

### `android/app/src/main/AndroidManifest.xml`

Inside `<application>`:

<!-- generated: hce.service -->

```xml
<service android:name="com.nfckit.hce.NfcKitHostApduService" android:exported="true" android:permission="android.permission.BIND_NFC_SERVICE">
  <intent-filter>
    <action android:name="android.nfc.cardemulation.action.HOST_APDU_SERVICE" />
  </intent-filter>
  <meta-data android:name="android.nfc.cardemulation.host_apdu_service" android:resource="@xml/nfc_kit_apduservice" />
</service>
```

<!-- /generated -->

`android:exported="true"` and the permission are not a choice: the NFC system
service binds this from another process, and the permission is what makes it the
only thing that can. Omit either and you get a service the platform silently never
uses.

### `android/app/src/main/res/xml/nfc_kit_apduservice.xml`

<!-- generated: hce.apduService -->

```xml
<host-apdu-service xmlns:android="http://schemas.android.com/apk/res/android" android:description="@string/nfc_kit_hce_description" android:requireDeviceUnlock="false">
  <aid-group android:description="@string/nfc_kit_hce_group_0" android:category="other">
    <aid-filter android:name="F0010203040506"/>
  </aid-group>
</host-apdu-service>
```

<!-- /generated -->

### `android/app/src/main/res/values/strings.xml`

<!-- generated: hce.strings -->

```xml
<string name="nfc_kit_hce_description" translatable="false">Ventry building access</string>
<string name="nfc_kit_hce_group_0" translatable="false">Doors</string>
```

<!-- /generated -->

The descriptions have to be string resources: the platform rejects a literal in
`host-apdu-service`, and they are user-visible, so they should be translatable
anyway. Copying the resource above without these gives you a build failure about a
missing symbol.

### iOS

Nothing. There is no iOS side to configure.

## Writing your own card

`emulateNdef` is a `createType4Card` wired to `hce.start`. For anything else —
your own applet, an existing terminal protocol — handle the APDUs yourself:

```ts
import {
  StatusWord,
  decodeCommandApdu,
  encodeResponseApdu,
  statusResponse,
} from 'react-native-nfc-kit/hce';

const session = await hce.start({
  onCommand: (bytes) => {
    const apdu = decodeCommandApdu(bytes);
    if (apdu.ins === 0xa4) return statusResponse(StatusWord.ok);
    if (apdu.ins === 0xca) return encodeResponseApdu(credentialBytes);
    return statusResponse(StatusWord.instructionNotSupported);
  },
  onDeactivated: (reason) => {
    // `linkLoss` means the phone moved away; `deselected` means the terminal
    // moved on to another application. Drop any per-conversation state either
    // way, or the next terminal inherits it.
    resetState();
  },
});
```

Return the full response including its status word. Throwing is allowed and
answers `6F00`, but a status word that says what went wrong is far more use to
whoever is holding the terminal.

## Checking it works

```bash
# The service should be listed, with its AIDs.
adb shell dumpsys nfc | grep -A10 "Registered HCE services"
```

Then tap a terminal. If nothing happens, in order of likelihood: the terminal is
selecting a different AID, the app is not in the foreground, or
`requireDeviceUnlock` is `true` and the phone is locked.

For observe mode specifically, `session.preferred` being `false` explains most
failures: the platform will not hand observe mode or polling frames to a service
it is not currently routing taps to.
