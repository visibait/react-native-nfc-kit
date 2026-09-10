---
title: Web NFC
description: The same API in a browser, what a browser can actually do, and what it refuses rather than guessing.
---

The same API works in a browser, backed by Web NFC. No import changes and no
platform branches:

```ts
import { nfc } from 'react-native-nfc-kit';

const message = await nfc.withTag({ tech: ['ndef'] }, async (tag) =>
  tag.is('ndef') ? tag.readNdef() : null,
);
```

This works because the native boundary is a small, session-based contract, and the
web build implements the same contract over Web NFC. Everything above it —
`withTag`, `openSession`, tags and their guards, the error codes, the React hooks —
is the same code running.

## What you actually get

**Chrome on Android, and nothing else** at the time of writing. Not Safari, not
Firefox, not desktop Chrome. `nfc.isSupported()` answers honestly, so a page can
hide its NFC affordance rather than offering something that cannot work.

**NDEF only.** A browser is handed records the platform has already interpreted; it
never gets the radio. So:

| Call                           | On the web                                 |
| ------------------------------ | ------------------------------------------ |
| `tag.readNdef()`               | Works                                      |
| `tag.writeNdef()`              | Works, with the caveat below               |
| `tag.makeNdefReadOnly()`       | Works where the browser implements it      |
| `tag.getNdefStatus()`          | Rejects `unsupportedPlatform`              |
| `tag.is('isoDep')` and friends | Always `false`                             |
| `transceive`, timeouts, format | Reject `unsupportedPlatform`               |
| `hce`, `vas`, background tags  | Reject, and their capabilities are `false` |

`getNdefStatus` rejecting is deliberate. Web NFC reports neither whether a tag is
writable nor how much room it has, and returning invented numbers would only move
the failure to the write, where it would surface as something else entirely.

**A write is not aimed at a tag.** `NDEFReader.write` writes to whichever tag is
next in the field rather than to the one your handle refers to. In practice that is
the tag still being held against the phone, and this is documented rather than
hidden because the difference matters if you ever hold two tags near a device.

**HTTPS and a user gesture are required.** Web NFC refuses to scan from a page that
is not secure, and the first call has to come from a click or a tap. A declined
permission surfaces as `notAuthorized`, which is the same code the native platforms
use for the same situation.

## Reading a tag's identifier

Chrome reports the serial number with colons — `04:a2:b3:c4`. This library
normalises it to plain lowercase hex, so `tag.idHex` reads the same on every
platform. The specification does not require a serial number at all, so `tag.id`
can be `null` on the web where it is populated on a phone.

## What is not translated

The bytes on the tag are never visible to a browser: Web NFC hands over records it
has already interpreted, so the shim rebuilds NDEF records from them and rebuilds
Web NFC's shape again in order to write. That mapping is faithful for text, URLs,
absolute URIs, MIME, external and unknown records, and it is round-trip tested in
both directions because a browser gives no way to check the result against real
bytes.

Two things it refuses rather than guessing:

- **Writing a smart poster.** Web NFC's write API builds records itself and cannot
  express a nested message. Write the URL and the title as separate records, or
  write that tag from a phone.
- **A record type Web NFC reports that this library does not recognise.** Reading
  it as opaque bytes would be a guess about what it means.

## Setup

Nothing. There is no manifest, no entitlement and no plugin option — the browser's
permission prompt is the whole configuration. Serve the page over HTTPS and call
from a user gesture.

## Whether it is worth using

Honestly: rarely as a product, often as a tool. It is a small share of browsers on
one platform, and any app that needs a tag on iOS needs a native build anyway. What
it is genuinely good for is a debugging page, an internal tool, or reading a tag
from a laptop-adjacent workflow — and the NDEF codec at
`react-native-nfc-kit/ndef` runs anywhere with no NFC at all, including Node, if
all you need is to build or parse a message.
