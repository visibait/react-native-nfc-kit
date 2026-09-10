import { useCallback, useEffect, useState } from 'react';
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  NfcError,
  createTextRecord,
  decodeTextRecord,
  isTextRecord,
  nfc,
  toHex,
  type NfcAvailability,
  type Tag,
} from 'react-native-nfc-kit';

/** What the last scan produced, in a shape the screen can render. */
interface ScanResult {
  readonly uid: string;
  readonly techs: string;
  readonly ndef: string;
}

export default function App() {
  const [availability, setAvailability] = useState<NfcAvailability | null>(null);
  const [status, setStatus] = useState('Idle');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void nfc.getAvailability().then(setAvailability);
    // Android reports NFC being switched on or off while the app is running.
    const subscription = nfc.onAvailabilityChange(setAvailability);
    return () => subscription.remove();
  }, []);

  /** Reads whatever is on the tag, and reports it. */
  const read = useCallback(async () => {
    setBusy(true);
    setResult(null);
    setStatus('Hold a tag against the phone…');

    try {
      const scanned = await nfc.withTag(
        {
          tech: ['ndef', 'isoDep', 'nfcA'],
          timeoutMs: 20_000,
          ios: { alertMessage: 'Hold your tag near the top of the phone' },
          android: { noPlatformSounds: false },
        },
        async (tag: Tag): Promise<ScanResult> => {
          const uid = tag.idHex ?? '(not exposed by this platform)';
          const techs = tag.techs.join(', ') || '(none)';

          // The guard is what makes readNdef exist: a plain Tag has no
          // technology methods at all.
          if (!tag.is('ndef')) {
            return { uid, techs, ndef: 'Tag is not NDEF formatted' };
          }

          const records = await tag.readNdef();
          if (records.length === 0) {
            return { uid, techs, ndef: '(empty)' };
          }

          const described = records.map((record) =>
            isTextRecord(record)
              ? `text: ${decodeTextRecord(record).text}`
              : `tnf ${record.tnf}, ${record.payload.length} byte(s): ${toHex(record.payload.subarray(0, 16))}`,
          );
          return { uid, techs, ndef: described.join('\n') };
        },
      );

      setResult(scanned);
      setStatus('Read complete');
    } catch (error) {
      setStatus(describe(error));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Writes a text record, so the write path gets exercised too. */
  const write = useCallback(async () => {
    setBusy(true);
    setResult(null);
    setStatus('Hold a writable tag against the phone…');

    try {
      await nfc.withTag(
        { tech: ['ndef'], timeoutMs: 20_000, ios: { alertMessage: 'Hold the tag to write' } },
        async (tag) => {
          if (!tag.is('ndef')) {
            throw new Error('This tag is not NDEF formatted');
          }
          const status = await tag.getNdefStatus();
          if (!status.writable) {
            throw new Error('This tag is read-only');
          }
          await tag.writeNdef([
            createTextRecord(`written at ${new Date().toISOString()}`, { languageCode: 'en' }),
          ]);
        },
      );
      setStatus('Write complete');
    } catch (error) {
      setStatus(describe(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const usable = availability?.supported === true && availability.enabled;

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>react-native-nfc-kit</Text>

        <Section title="Availability">
          <Row label="Supported" value={String(availability?.supported ?? '…')} />
          <Row label="Enabled" value={String(availability?.enabled ?? '…')} />
          <Row
            label="Platform"
            value={`${Platform.OS} ${availability?.capabilities?.osVersion ?? ''}`}
          />
          <Row label="Technologies" value={availability?.capabilities?.techs.join(', ') ?? '…'} />
          <Row
            label="Tag removal events"
            value={String(availability?.capabilities?.nativeTagLost ?? '…')}
          />
        </Section>

        <View style={styles.buttons}>
          <Button label="Read a tag" onPress={read} disabled={busy || !usable} />
          <Button label="Write text" onPress={write} disabled={busy || !usable} />
          {availability?.enabled === false && Platform.OS === 'android' ? (
            <Button
              label="Open NFC settings"
              onPress={() => void nfc.openSettings()}
              disabled={false}
            />
          ) : null}
        </View>

        <Section title="Status">
          <Text style={styles.status}>{status}</Text>
        </Section>

        {result ? (
          <Section title="Last tag">
            <Row label="UID" value={result.uid} />
            <Row label="Technologies" value={result.techs} />
            <Row label="NDEF" value={result.ndef} />
          </Section>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Turns any failure into something worth showing a human. */
function describe(error: unknown): string {
  if (NfcError.is(error)) {
    const retry = error.recoverable ? ' (worth trying again)' : '';
    return `${error.code}: ${error.message}${retry}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0f1115' },
  content: { padding: 20, gap: 16 },
  title: { color: '#f5f7fa', fontSize: 22, fontWeight: '600' },
  section: { backgroundColor: '#181b22', borderRadius: 12, padding: 14, gap: 6 },
  sectionTitle: { color: '#8b93a7', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  row: { flexDirection: 'row', gap: 10 },
  rowLabel: { color: '#8b93a7', width: 130, fontSize: 13 },
  rowValue: { color: '#e6eaf2', flex: 1, fontSize: 13 },
  status: { color: '#e6eaf2', fontSize: 14 },
  buttons: { gap: 10 },
  button: {
    backgroundColor: '#3b6fe0',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.75 },
  buttonDisabled: { backgroundColor: '#2a3038' },
  buttonLabel: { color: '#ffffff', fontSize: 15, fontWeight: '500' },
});
