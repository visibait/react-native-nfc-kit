import { useCallback, useEffect, useState } from 'react';

import { nfc, type NfcAvailability, type NfcCapabilities } from '../core/nfc.js';

export interface UseNfcAvailabilityResult extends NfcAvailability {
  /** True until the first answer arrives. */
  readonly loading: boolean;
  /** True when NFC is present and switched on, which is what a screen usually asks. */
  readonly ready: boolean;
  readonly capabilities: NfcCapabilities | null;
  /** Re-reads availability now. Rarely needed; changes arrive on their own. */
  readonly refresh: () => void;
}

const UNKNOWN: NfcAvailability = { supported: false, enabled: false, capabilities: null };

/**
 * Availability of NFC on this device, kept current.
 *
 * ```tsx
 * const { ready, supported, loading } = useNfcAvailability();
 *
 * if (loading) return <Spinner />;
 * if (!supported) return <Text>This device has no NFC.</Text>;
 * if (!ready) return <Button title="Turn NFC on" onPress={() => nfc.openSettings()} />;
 * ```
 *
 * The Android user can switch NFC off while your screen is open, so this
 * subscribes rather than only reading once — a button that says "hold your card
 * near the phone" while NFC is off is a support ticket.
 *
 * Before the first answer arrives, `supported` and `enabled` read `false` with
 * `loading` true. Treat `loading` as "do not decide yet" rather than showing the
 * unsupported state for a frame.
 */
export function useNfcAvailability(): UseNfcAvailabilityResult {
  const [availability, setAvailability] = useState<NfcAvailability>(UNKNOWN);
  const [loading, setLoading] = useState(true);
  const [refreshCount, setRefreshCount] = useState(0);

  const refresh = useCallback(() => {
    setRefreshCount((count) => count + 1);
  }, []);

  useEffect(() => {
    let active = true;

    // Attached before the first read, so a change landing between the two is not
    // lost. No mounted guard here on purpose: the cleanup below detaches this
    // listener, so it cannot fire afterwards, and a guard against something that
    // cannot happen claims that it can.
    const subscription = nfc.onAvailabilityChange((next) => {
      setAvailability(next);
      setLoading(false);
    });

    void nfc
      .getAvailability()
      .then((next) => {
        if (active) {
          setAvailability(next);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
      subscription.remove();
    };
  }, [refreshCount]);

  return {
    supported: availability.supported,
    enabled: availability.enabled,
    capabilities: availability.capabilities,
    ready: availability.supported && availability.enabled,
    loading,
    refresh,
  };
}
