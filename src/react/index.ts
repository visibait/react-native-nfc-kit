/**
 * React bindings, at `react-native-nfc-kit/react`.
 *
 * ```tsx
 * import { useNfcAvailability, useNfcScan } from 'react-native-nfc-kit/react';
 * ```
 *
 * They live on a subpath so the core API never imports React. That matters for
 * two real cases: a plain Node script that parses NDEF, and any consumer whose
 * bundler would otherwise pull React into a module that has no components in it.
 *
 * Each hook exists because of a specific mistake that is easy to make by hand and
 * invisible when made: unmounting mid-scan without cancelling, re-subscribing a
 * tag stream on every render, or showing "hold your card near the phone" on a
 * device where the user has just switched NFC off.
 */

export { useNfcAvailability } from './useNfcAvailability.js';
export type { UseNfcAvailabilityResult } from './useNfcAvailability.js';

export { useNfcScan } from './useNfcScan.js';
export type { NfcScanState, UseNfcScanResult } from './useNfcScan.js';

export { useNfcTagStream } from './useNfcTagStream.js';
export type { UseNfcTagStreamOptions, UseNfcTagStreamResult } from './useNfcTagStream.js';
