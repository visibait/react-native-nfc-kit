# Reading an Apple Wallet pass (VAS)

Value Added Service is how a till reads a loyalty card or a ticket out of Apple
Wallet. This is the till side: your app asks a nearby iPhone or Watch for a pass of
a type you own, and gets back the pass's data and a token identifying the device
that answered.

```ts
import { vas } from 'react-native-nfc-kit/vas';

const [response] = await vas.read({
  configurations: [{ passTypeIdentifier: 'pass.es.ventry.entrada' }],
  alertMessage: 'Hold the pass near the top of the phone',
});

if (response?.statusName === 'success') {
  await validate(response.vasData);
}
```

## Read this before you plan around it

**iOS only.** There is no Android equivalent to expose: VAS is an Apple protocol
read through CoreNFC's own session type. `nfc.capabilities.vas` is `false` on
Android, and `vas.read` rejects with `unsupportedPlatform` there.

**It needs an entitlement Apple grants case by case, and Apple has not published
what it is.** Their own documentation says: _"Using NFCVASReaderSession requires an
entitlement from Apple. Updates will include information about the entitlement and
a link to the entitlement request form."_ As of writing, that update has not
happened, and the documented values for
`com.apple.developer.nfc.readersession.formats` do not include one for VAS.

That is not as unhelpful as it sounds, and it is worth being precise about why:
request-gated entitlements work by Apple giving you the key when they approve you.
It appears in your App ID's capabilities, Xcode picks it up, and your provisioning
profile carries it. So **an app that has been granted it knows what to declare** —
you do not need this library to guess, and it deliberately does not.

**Nothing can check for it in advance.** There is no API that reports whether the
entitlement was granted, so `vas.isSupported()` answers a narrower question: is
this an iPhone that can read NFC at all. The entitlement shows up the first time
you read, as `entitlementMissing`.

## Expo

No plugin option, because there is nothing for the plugin to write that it could
know. Once Apple grants you the entitlement, put the key they give you in
`app.json` — `ios.entitlements` is a first-class Expo field:

```json
{
  "expo": {
    "ios": {
      "entitlements": {
        "com.apple.developer.nfc.readersession.formats": ["TAG"]
      }
    }
  }
}
```

You also need the `react-native-nfc-kit` plugin for the usage description and the
reader-session format, exactly as in [ndef.md](ndef.md); VAS adds nothing to that.

## Bare React Native

Same picture: the entitlements from [ndef.md](ndef.md), plus whatever key Apple
gives you, in `ios/<App>/<App>.entitlements`.

## The pass type identifier

`pass.es.ventry.entrada` — yours, from the Apple Developer portal, and the same one
your `.pkpass` files declare. A phone offers only passes of a type you asked for,
which is the mechanism that stops a till reading somebody's hotel key.

Several may be listed, and the phone answers for whichever it holds. That is how a
till that accepts more than one kind of pass is built:

```ts
await vas.read({
  configurations: [
    { passTypeIdentifier: 'pass.es.ventry.entrada' },
    { passTypeIdentifier: 'pass.es.ventry.abono' },
  ],
});
```

## Modes

`normal` (the default) asks for the pass's data. `urlOnly` does the opposite: it
hands the pass a URL and asks for nothing back, which is how a till points a
customer's phone at something. It needs a `url`, and passing that mode without one
is rejected before the session opens — CoreNFC accepts it and then hands the pass
nothing.

## The status words

Real APDU status words, the same scheme as everything else in this library, with
names so a caller does not have to memorise hex:

| Name                            | Value    | Means                                     |
| ------------------------------- | -------- | ----------------------------------------- |
| `success`                       | `0x9000` | The pass answered; `vasData` is populated |
| `dataNotFound`                  | `0x6A83` | The phone holds no pass of that type      |
| `dataNotActivated`              | `0x6287` | The pass exists but is not usable yet     |
| `userIntervention`              | `0x6984` | The user has to act on their phone first  |
| `wrongParameters`               | `0x6B00` | The request was malformed                 |
| `wrongLength`                   | `0x6700` | The request length was wrong              |
| `incorrectData`                 | `0x6A80` | The pass rejected the request data        |
| `unsupportedApplicationVersion` | `0x6340` | The pass is too old or too new            |

`dataNotFound` is the common one and is not a failure: it means the customer does
not have your pass. Distinguishing it from an error is why the status is named
rather than left as a number.

## Not validated on hardware

Everything here follows from CoreNFC's own header — the mode values, the status
words, the initialiser and delegate signatures were all read out of it rather than
recalled — and it compiles against the real CoreNFC in CI. What has **not** been
done is a read against an actual Wallet pass, because that needs the entitlement.
It is a row in the device matrix, marked unvalidated, and a report either way from
anyone who has the entitlement is welcome.
