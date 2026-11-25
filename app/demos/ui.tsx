import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// Shared look for the per-library demo boxes (one box per DevTools extension).
export function DemoBox({ title, color, children }: { title: string; color: string; children: ReactNode }) {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.row}>{children}</View>
    </View>
  );
}

export function DemoButton({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.btn, { backgroundColor: color }, pressed && { opacity: 0.7 }]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 12, padding: 12, borderRadius: 10, backgroundColor: '#f2f4f7' },
  title: { fontSize: 14, fontWeight: '600', marginBottom: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10 },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
