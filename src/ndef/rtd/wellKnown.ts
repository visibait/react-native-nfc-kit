/**
 * NFC Forum well-known record types (RTDs).
 *
 * A well-known type is a short ASCII string in the record's `type` field, valid
 * only when the TNF is `WellKnown` (0x01).
 */

import { bytesEqual, utf8Encode } from '../bytes.js';
import { Tnf, type NdefRecord } from '../record.js';

/**
 * The well-known type names this library knows about.
 *
 * `Text` and `Uri` are what real tags overwhelmingly contain. `SmartPoster` is
 * a composite record. The handover set is included so those records can be
 * recognised and passed through even before there is a decoder for each one --
 * recognising a record you cannot fully parse is more useful than treating it
 * as unknown bytes.
 */
export const WellKnownType = {
  Text: 'T',
  Uri: 'U',
  SmartPoster: 'Sp',
  Signature: 'Sig',
  /** Handover Carrier. */
  HandoverCarrier: 'Hc',
  /** Handover Request. */
  HandoverRequest: 'Hr',
  /** Handover Select. */
  HandoverSelect: 'Hs',
  /** Alternative Carrier. */
  AlternativeCarrier: 'ac',
  /** Collision Resolution. */
  CollisionResolution: 'cr',
  /** Generic Control. */
  GenericControl: 'Gc',
} as const;

export type WellKnownType = (typeof WellKnownType)[keyof typeof WellKnownType];

/**
 * Encodes a well-known type name to bytes.
 *
 * Returns a fresh array on every call so callers cannot accidentally mutate a
 * shared constant and corrupt every record built afterwards.
 */
export function wellKnownTypeBytes(type: string): Uint8Array {
  return utf8Encode(type);
}

/** Whether `record` is a well-known record of the given type. */
export function isWellKnownRecord(record: NdefRecord, type: string): boolean {
  return record.tnf === Tnf.WellKnown && bytesEqual(record.type, utf8Encode(type));
}
