---
title: Error reference
description: Every NfcErrorCode, what causes it, and what to do about it.
---

Every rejection from this library is an `NfcError` carrying a `code`. That is the
whole point of the type: a code can be branched on, and a message cannot.

```ts
import { NfcError } from 'react-native-nfc-kit';

try {
  await nfc.withTag({ tech: ['ndef'] }, read);
} catch (error) {
  if (NfcError.is(error, 'userCancelled')) return; // not a failure
  if (NfcError.is(error, 'tagLost')) return retry();
  throw error;
}
```

`NfcError.is` brands on the error's `name`, not on `instanceof`, so it still works
when two copies of the package end up in one bundle — which happens, and which
breaks `instanceof` in a way that is very hard to see.

Every error also carries `nativeCode` when the platform supplied one
(`NFCReaderError:201`, `android.nfc.TagLostException`), `platform`, `cause`, and
`recoverable` — whether moving the tag away and back is worth trying.

## The four you should always handle

Everything else is a bug, a tag problem, or a configuration problem. These four are
ordinary life:

| Code             | What happened                                 | What to do                                                             |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| `userCancelled`  | The user dismissed the iOS scanning sheet.    | Nothing. Not a failure — do not show an error.                         |
| `tagLost`        | The tag left the field mid-operation.         | Ask the user to hold it still and retry. `recoverable` is `true`.      |
| `sessionTimeout` | iOS ended the session at its 60-second limit. | Offer to scan again. The limit is the system's and cannot be extended. |
| `nfcDisabled`    | NFC is switched off. Android only.            | `nfc.openSettings()` takes the user there.                             |

## Session lifecycle

| Code             | Cause                                                                                       | Remedy                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `userCancelled`  | The user dismissed the system sheet on iOS.                                                 | Treat as a normal exit. Distinct from `aborted` on purpose.                                                           |
| `sessionTimeout` | iOS caps a reader session at 60 seconds.                                                    | Start another session. Splitting a long protocol across sessions is the only way past it.                             |
| `sessionClosed`  | The tag or session was used after it was closed — usually a tag kept from inside `withTag`. | Do the work inside the callback. A tag is only valid there.                                                           |
| `systemBusy`     | A session is already open. The platform allows one at a time.                               | Close the first. On iOS a second session queues behind the first rather than failing immediately, so this is a guard. |
| `aborted`        | Your own `AbortSignal` fired.                                                               | Nothing. You asked for it.                                                                                            |
| `timeout`        | The `timeoutMs` you passed elapsed.                                                         | Raise it, or accept it. Distinct from `sessionTimeout`, which is the platform's limit rather than yours.              |

## Hardware, permissions and configuration

| Code                 | Cause                                                                                                                                                                             | Remedy                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nfcUnsupported`     | No usable NFC. An iPhone 6s or earlier, an iPad, the Simulator, or an Android device with no controller.                                                                          | Check `nfc.isSupported()` before offering the feature. Nothing else helps.                                                                            |
| `nfcDisabled`        | Android's NFC toggle is off.                                                                                                                                                      | `nfc.openSettings()`. iOS has no equivalent setting, so this never occurs there.                                                                      |
| `noActivity`         | Android reader mode needs a foreground activity and there was none.                                                                                                               | Do not start a scan from a background task or before the activity is attached.                                                                        |
| `entitlementMissing` | iOS refused the session for lack of an entitlement.                                                                                                                               | Check the reader-session format, and the AID or FeliCa system code declarations. See [setup](setup/overview).                                         |
| `notAuthorized`      | The system refused the operation. On Android usually a tag dispatched to another app or a backgrounded activity; on the web a declined permission or a call with no user gesture. | Bring the app to the foreground; on the web, call from a click.                                                                                       |
| `contractMismatch`   | The JavaScript bundle is newer than the installed native binary.                                                                                                                  | **Rebuild the development build.** This is the one error whose message tells you exactly that, because it is the commonest support question there is. |

## Tags

| Code                  | Cause                                                                 | Remedy                                                                                                                              |
| --------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tagLost`             | The tag left the field, or Android's presence check declared it gone. | Retry. For crypto sequences, raise `android.presenceCheckDelayMs`: the default 125 ms is shorter than DESFire authentication takes. |
| `tagConnectionFailed` | Connecting to a technology failed even though the tag listed it.      | Usually a tag held at an angle or moved during activation. Retry.                                                                   |
| `techUnavailable`     | An operation needs a technology this tag does not have here.          | Guard with `tag.is(...)`. On iOS `mifareClassic` is never available, at any OS version.                                             |
| `tagNotSupported`     | The platform recognised a tag it cannot work with.                    | Nothing at runtime. Worth logging the tag's `techs` for a bug report.                                                               |

## Exchanges

| Code                   | Cause                                                                                       | Remedy                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ioError`              | The exchange failed for a reason the platform did not narrow down.                          | Retry once. `nativeCode` carries the original exception type, which is worth logging.            |
| `transceiveFailed`     | A command was rejected or the response was malformed.                                       | Check the command against the tag's datasheet. This is not a transport problem.                  |
| `transceiveTooLong`    | The command exceeded the tag's `maxTransceiveLength`.                                       | Split it. `tag.maxTransceiveLength()` reports the limit, and it is chipset-dependent on Android. |
| `authenticationFailed` | A key was rejected — MIFARE Classic sector authentication, or NTAG password authentication. | Check the key. **NTAG locks itself after a few failed attempts**, so do not retry in a loop.     |

## NDEF

| Code                   | Cause                                                            | Remedy                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ndefNotSupported`     | The tag has no NDEF application, or cannot be formatted for one. | A blank tag is often `ndefFormatable` rather than `ndef`: ask for both technologies and narrow.                                              |
| `ndefReadOnly`         | The tag is locked.                                               | Nothing. Check `getNdefStatus().writable` first to fail before the write rather than during it.                                              |
| `ndefCapacityExceeded` | The message is larger than the tag holds.                        | Check `getNdefStatus().capacity` against `encodedMessageLength(records)` before writing. A partly written tag is worse than a refused write. |
| `ndefMalformed`        | The bytes are not a valid NDEF message.                          | Often an unformatted tag, or a partial write from a previous attempt. Reformat it.                                                           |

## Card emulation

| Code                    | Cause                                                                            | Remedy                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `hceUnsupported`        | The controller does not implement host card emulation, or the AIDs were refused. | Check `nfc.capabilities.hce`. A refusal usually means the service is missing from the manifest — see [hce](setup/hce). |
| `hceNotEligible`        | The platform declined to let this app emulate a card.                            | On iOS this is the entitlement and the region. On Android, another app may own the AID.                                |
| `hceMaxDurationReached` | The platform ended an emulation session at its own limit.                        | Start another. Reserved for iOS `CardSession`, which is not offered by this library today.                             |

## Programming errors

These mean the call was wrong, not that NFC failed. They should never reach a user.

| Code                  | Cause                                                                                             | Remedy                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `invalidArgument`     | An argument was out of range or malformed — an empty `tech`, a bad hex string, an oversized APDU. | Read the message; it names the argument and the range.                                                                   |
| `unsupportedPlatform` | The call does not exist on this platform.                                                         | Guard with `nfc.capabilities`, or with `tag.android` / `tag.ios`, which are `undefined` on the other platform.           |
| `internalError`       | A bug here, or a platform failure with no better mapping.                                         | Worth an issue, with `nativeCode` and `cause`. Every occurrence of this is either a missing mapping or a genuine defect. |

## Two distinctions worth internalising

**`aborted` is not `userCancelled`.** The first is your `AbortSignal`; the second is
the user dismissing the sheet. The library being replaced collapsed a user
cancellation into "closed with no error", so the two could not be told apart — and
an app cannot decide whether to show a message without knowing which happened.

**`timeout` is not `sessionTimeout`.** The first is the deadline you set; the second
is iOS's 60-second cap on a reader session, which no library can extend. The remedy
differs: raise your own, or split the work.
