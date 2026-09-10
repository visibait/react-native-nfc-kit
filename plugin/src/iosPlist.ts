/** The NDEF application AID, which behaves surprisingly when declared. */
export const NDEF_APPLICATION_AID = 'D2760000850101';

/**
 * Merges requested values into whatever is already there, without duplicates.
 *
 * Existing values are kept because another plugin may legitimately have added
 * one, and the result is sorted so repeated prebuilds produce an identical file —
 * otherwise every snapshot comparison turns into a spurious diff.
 */
export function mergeStringList(existing: unknown, requested: readonly string[]): string[] {
  const previous = Array.isArray(existing)
    ? existing.filter((value): value is string => typeof value === 'string')
    : [];
  return [...new Set([...previous, ...requested])].sort();
}

/**
 * Normalises a hex option to uppercase.
 *
 * Apple's own samples are uppercase, and normalising also means `d276...` and
 * `D276...` cannot both end up in the list as separate entries.
 */
export function normalizeHex(value: string): string {
  return value.toUpperCase();
}

/**
 * Warns about AID choices that work, but not the way people expect.
 *
 * Declaring the NDEF application AID makes iOS hand a DESFire card over as an
 * `NFCISO7816Tag` rather than an `NFCMiFareTag`. That is a legitimate thing to
 * want, and it is also a genuinely baffling way to lose the MIFARE interface, so
 * it is worth one line at prebuild rather than an afternoon of debugging.
 */
export function selectIdentifierWarnings(identifiers: readonly string[]): string[] {
  return identifiers.some((aid) => normalizeHex(aid) === NDEF_APPLICATION_AID)
    ? [
        `ios.selectIdentifiers declares the NDEF application AID (${NDEF_APPLICATION_AID}). ` +
          'iOS then delivers cards that support it — DESFire among them — as ISO 7816 tags rather ' +
          'than MIFARE tags, so tag.is("mifareUltralight") and the MIFARE-specific commands stop ' +
          'matching. Remove it if you want the MIFARE interface.',
      ]
    : [];
}
