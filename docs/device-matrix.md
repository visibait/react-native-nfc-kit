---
title: Device matrix
description: What has been validated on hardware, what has not, and the procedure for each row.
---

Mocks, simulators, emulators and compiler checks are never reported here as
hardware validation. A test suite proves the bookkeeping; only a tag proves the
radio.

This page is the checklist, and it is honest about its own state: **nothing in it
has been run yet.** Every row is marked accordingly, and a `1.0.0` that has not
been through it would be a claim the project has not earned.

## How to use this

Each row is a claim the library makes, the smallest setup that tests it, and what
"passed" means. Record the device, the OS version and the date next to the row when
you run it — a row passing on one Android version says nothing about another, and
the version is the part people forget to write down.

Legend: **✅ passed** · **❌ failed** · **⬜ not run**

## Reading, both platforms

| #   | Claim                                          | Setup                                      | Passed when                                                                          | iOS | Android |
| --- | ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ | --- | ------- |
| 1   | `withTag` reads an NDEF message                | NTAG213 with a URL record                  | The URL comes back intact                                                            | ⬜  | ⬜      |
| 2   | `withTag` writes and reads back                | Blank NTAG215                              | A written message reads back byte for byte                                           | ⬜  | ⬜      |
| 3   | A blank tag is formatted on first write        | Factory-fresh NTAG213                      | `tag.is('ndefFormatable')` is true and `formatNdef` succeeds                         | ⬜  | ⬜      |
| 4   | A locked tag is refused before the write       | NTAG213 previously locked read-only        | `getNdefStatus().writable` is false; no partial write occurs                         | ⬜  | ⬜      |
| 5   | An oversized message is refused, not truncated | NTAG213 (144 bytes) and a 300-byte message | `ndefCapacityExceeded`, and the tag still holds its old message                      | ⬜  | ⬜      |
| 6   | ISO 7816 SELECT and READ BINARY                | DESFire EV1                                | `sendApdu` returns `9000` and the expected data                                      | ⬜  | ⬜      |
| 7   | The same, on a newer card                      | DESFire **EV2**                            | As above. EV2 is called out because it is a known break elsewhere                    | ⬜  | ⬜      |
| 8   | Command chaining and `61xx` follow-ups         | A card returning more than one frame       | `sendApdu` reassembles without the caller looping                                    | ⬜  | ⬜      |
| 9   | ISO 15693 read                                 | ICODE SLIX                                 | `readSingleBlock` returns the block                                                  | ⬜  | ⬜      |
| 10  | FeliCa read                                    | FeliCa Lite-S                              | `readWithoutEncryption` returns the block                                            | ⬜  | ⬜      |
| 11  | NTAG password authentication                   | NTAG213 with a password set                | `passwordAuthenticate` succeeds, and **one** wrong attempt is enough to stop testing | ⬜  | ⬜      |
| 12  | The `techs` list matches the tag               | Each tag above                             | No technology is claimed that an operation then refuses                              | ⬜  | ⬜      |

## Android only

| #   | Claim                                                   | Setup                                                    | Passed when                                                                                                       | Status |
| --- | ------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| 13  | MIFARE Classic is reachable where the chipset allows it | Classic 1K, on an NXP-controller device                  | `tag.is('mifareClassic')` is true and a raw exchange works                                                        | ⬜     |
| 14  | MIFARE Classic is absent where it is not                | Classic 1K, on a Broadcom-controller device              | `nfc.supports('mifareClassic')` is false — **not** a method that throws                                           | ⬜     |
| 15  | Tag removal is reported by polling                      | Any tag, API 34–36                                       | `tag.onLost` fires within roughly 500 ms of the tag leaving                                                       | ⬜     |
| 16  | Tag removal is reported by the platform                 | Any tag, **API 37**                                      | `capabilities.tagLost` is `native` and `onLost` latency drops noticeably                                          | ⬜     |
| 17  | `presenceCheckDelayMs` prevents a mid-crypto loss       | DESFire authentication with the default 125 ms, then 500 | The default loses the tag part-way; 500 ms completes                                                              | ⬜     |
| 18  | A tag launches the app                                  | NTAG with a matching MIME record, app closed             | `withLaunchTag` returns it, and `readNdef` works from the dispatched message                                      | ⬜     |
| 19  | A rotation does not replay the launch tag               | As above, then rotate the screen                         | The second read answers `null`                                                                                    | ⬜     |
| 20  | A tag arrives while the app runs                        | As above, app in the background                          | `onBackgroundTag` fires once                                                                                      | ⬜     |
| 21  | `DISPATCH_NFC_MESSAGE` is required, or is not           | **API 37** with background reading                       | Dispatch works with the permission and fails without it — **this is the one unverified inference in the library** | ⬜     |
| 22  | The same manifest still dispatches below API 37         | API 36, permission absent                                | Dispatch works                                                                                                    | ⬜     |
| 23  | Reader mode survives backgrounding                      | Open a session, background the app, return               | The session resumes rather than dying silently                                                                    | ⬜     |
| 24  | Reader mode survives NFC being switched off mid-session | Open a session, disable NFC                              | A coded error, not a hang                                                                                         | ⬜     |

## Card emulation, Android only

| #   | Claim                                              | Setup                                      | Passed when                                                                   | Status |
| --- | -------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- | ------ |
| 25  | An emulated NDEF tag reads like a tag              | `hce.emulateNdef`, read by a second phone  | The second phone reads the message as an ordinary NDEF tag                    | ⬜     |
| 26  | The same, read by a real reader                    | An ACR122U or a door controller            | The reader completes the Type 4 sequence                                      | ⬜     |
| 27  | A custom AID reaches the handler                   | A terminal selecting your AID              | `onCommand` receives the SELECT                                               | ⬜     |
| 28  | The deadline answers when JavaScript does not      | A handler that sleeps past `timeoutMs`     | The terminal gets `6F00` rather than a dropped link                           | ⬜     |
| 29  | A killed app still answers definitively            | Force-stop the app, then tap               | The terminal gets `6F00`, not silence                                         | ⬜     |
| 30  | Observe mode holds the card silent                 | **API 35+** with `observeMode: true`       | The reader detects the phone but gets no answer until `setObserveMode(false)` | ⬜     |
| 31  | Polling frames arrive before any selection         | As above                                   | `onPollingFrames` fires while the card is still silent                        | ⬜     |
| 32  | `preferSelf` takes the tap from the default wallet | A device with a wallet app configured      | The tap reaches this app rather than the wallet                               | ⬜     |
| 33  | Observe mode is left off after a session           | Stop the session, then use another HCE app | The other app is not held silent                                              | ⬜     |

## iOS only

| #   | Claim                                     | Setup                                      | Passed when                                                           | Status |
| --- | ----------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------- | ------ |
| 34  | The 60-second limit is reported as itself | Open a session and wait                    | `sessionTimeout`, with a message naming the system limit              | ⬜     |
| 35  | Dismissing the sheet is not an error      | Open a session, tap Cancel                 | `userCancelled`, and the app shows no error                           | ⬜     |
| 36  | `setAlert` updates the sheet mid-session  | `openSession`, then `setAlert`             | The sheet text changes                                                | ⬜     |
| 37  | A missing AID declaration is diagnosable  | Remove `selectIdentifiers`, tap a DESFire  | The tag never arrives, and the docs' explanation matches what is seen | ⬜     |
| 38  | Tag loss surfaces on the next operation   | Pull the tag mid-APDU                      | `tagLost`, not `ioError`                                              | ⬜     |
| 39  | Reading a Wallet pass                     | An entitlement from Apple, and a real pass | `vas.read` returns `success` with the pass data                       | ⬜     |
| 40  | A missing VAS entitlement is diagnosable  | No entitlement                             | `entitlementMissing` on the first read                                | ⬜     |

## Web

| #   | Claim                                | Setup                        | Passed when                                      | Status |
| --- | ------------------------------------ | ---------------------------- | ------------------------------------------------ | ------ |
| 41  | Reading works in Chrome on Android   | HTTPS page, a click, an NTAG | The same code path as native returns the message | ⬜     |
| 42  | Writing works                        | As above                     | A written message reads back on a phone          | ⬜     |
| 43  | An unsupported browser is honest     | Safari, or desktop Chrome    | `nfc.isSupported()` is false; nothing throws     | ⬜     |
| 44  | A declined permission is diagnosable | Deny the prompt              | `notAuthorized`                                  | ⬜     |

## The soak run

Row 45, and the one worth doing even if nothing else is: **30 consecutive
operations per platform, without restarting the app.**

The automated half of this already runs in CI — `src/core/__tests__/soak.test.ts`
performs thirty iterations of every entry point and asserts the library ends with no
open session, no native listener and every handle released. That proves the
bookkeeping. What it cannot prove is that the platform agrees, which is what this
row is for.

Procedure:

1. Read the same tag thirty times with `withTag`, without restarting.
2. Thirty times, start a scan and cancel it before presenting a tag.
3. Thirty times, present a tag and pull it away mid-operation.
4. Thirty times, open a session and background the app before closing it.
5. Then read a tag normally.

Passed when the thirtieth iteration behaves like the first, and step 5 still works.
Failed if anything starts reporting `systemBusy`, if scanning stops starting, or if
latency grows across iterations — all three are the signature of a session or
listener that was not released.

| #   | Claim                            | Status iOS | Status Android |
| --- | -------------------------------- | ---------- | -------------- |
| 45  | Thirty iterations change nothing | ⬜         | ⬜             |

## Minimum coverage before a 1.0.0

Not every row, but not a token sample either:

- **Two Android devices with different NFC controllers**, one with MIFARE Classic
  and one without. Rows 13 and 14 are the whole reason.
- **One iPhone at the floor (iOS 16.4) and one current.** Row 34's timing and row
  37's diagnosis are the ones that differ.
- **Every tag type in the first table.** They are cheap, and each one has caught a
  real bug in some library.
- **Row 21 on an API 37 device**, because it is the only place this library makes an
  inference it has not been able to check. If it turns out to be wrong, the fix is a
  one-line default and the docs already say it is provisional.
- **Row 45 on both platforms.**

Rows 39 and 40 need an entitlement Apple grants case by case, and rows 30 to 33 need
a terminal. Those may reasonably stay open at 1.0.0 — but as open rows, not as
claims.
