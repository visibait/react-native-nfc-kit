# MIFARE Classic

Read this page before designing anything around MIFARE Classic, because the
constraint is not a configuration one.

## It is impossible on iOS

CoreNFC does not expose Crypto-1, at any iOS version, on any iPhone. There is no
entitlement that enables it and no workaround. `tag.is('mifareClassic')` is
therefore always `false` on iOS — not `undefined`, not a method that throws when
called, just a guard that does not match:

```ts
await nfc.withTag({ tech: ['mifareClassic', 'ndef'] }, async (tag) => {
  if (tag.is('mifareClassic')) {
    // Reachable on Android. On iOS this branch is never entered.
    await tag.authenticateSector(0, { keyA });
  } else if (tag.is('ndef')) {
    // Many Classic cards also present an NDEF application, which iOS can read.
    return tag.readNdef();
  }
});
```

That is the whole reason technologies are guards rather than optional methods: a
platform limit you can see in the type system is a design decision, and one you
discover in production is an outage.

## It is chipset-dependent on Android

MIFARE Classic is an optional Android technology. Devices with Broadcom or some
Intel NFC controllers do not implement it, and on those devices the technology is
simply absent from the tag's tech list.

The library gates on what the tag actually reports rather than guessing:

```ts
if (nfc.supports('mifareClassic')) {
  // This device's controller implements Crypto-1.
}
```

No heuristics are used to decide this. The library being replaced probed
`/dev/bcm2079x-i2c` and `/dev/pn544`, scanned `/system/lib`, and carried a
hardcoded special case for one Lenovo model. All of that is guesswork about a
question the platform answers directly.

## Configuration

None beyond the default setup — see [ndef.md](ndef.md) for the entitlement,
Info.plist and manifest, which are identical here.

The iOS entitlement is still worth having: a Classic card that also carries an
NDEF application is readable on iOS through that application, which is often
enough for a read-only use case.

## If you are choosing a card

Do not choose Classic. Crypto-1 has been broken since 2008 and the attacks are
practical with equipment that costs less than a phone. NTAG21x for NDEF, or
DESFire EV2/EV3 for anything with a security requirement, work on both platforms
and are cheaper to support than a card half your users cannot read.
