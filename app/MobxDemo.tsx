import { makeAutoObservable } from 'mobx';
import { observer } from 'mobx-react-lite';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// A tiny MobX store so the MobX DevTools extension has observables, actions and
// computeds to show. Every button press is one action -> a "Changes" log entry.
class TodoStore {
  todos: { id: number; title: string; done: boolean }[] = [];
  nextId = 1;

  constructor() {
    makeAutoObservable(this, {}, { name: 'TodoStore' });
  }

  get remaining() {
    return this.todos.filter((t) => !t.done).length;
  }

  add() {
    this.todos.push({ id: this.nextId, title: `Todo #${this.nextId}`, done: false });
    this.nextId += 1;
  }

  toggleFirstOpen() {
    const open = this.todos.find((t) => !t.done);
    if (open) open.done = true;
  }

  clear() {
    this.todos = [];
  }
}

export const todoStore = new TodoStore();

export const MobxDemo = observer(function MobxDemo() {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>
        MobX store: {todoStore.todos.length} todos, {todoStore.remaining} open
      </Text>
      <View style={styles.row}>
        <Btn label="Add todo" onPress={() => todoStore.add()} />
        <Btn label="Complete one" onPress={() => todoStore.toggleFirstOpen()} />
        <Btn label="Clear" onPress={() => todoStore.clear()} />
      </View>
    </View>
  );
});

function Btn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.btn, pressed && { opacity: 0.7 }]}>
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 16, padding: 12, borderRadius: 10, backgroundColor: '#f2f4f7' },
  title: { fontSize: 14, fontWeight: '600', marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8 },
  btn: { backgroundColor: '#ff7102', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10 },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
