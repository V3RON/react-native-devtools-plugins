import { useNetworkActivityDevTools } from '@rozenite/network-activity-plugin';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

// Two public APIs exercised so the DevTools shell (network panel + GraphQL
// extension panels) has something real to inspect end to end.
const REST_URL = 'https://jsonplaceholder.typicode.com/todos?_limit=5';
const GRAPHQL_URL = 'https://countries.trevorblades.com/';
const GRAPHQL_QUERY = `
  query Continents {
    countries(where: { code: { in: ["PL", "DE", "US"] } }) {
      code
      name
      capital
      currency
      languages {
        code
        name
      }
    }
  }
`;

type Result =
  | { kind: 'idle' }
  | { kind: 'loading'; label: string }
  | { kind: 'done'; label: string; text: string }
  | { kind: 'error'; label: string; text: string };

async function fetchRest(): Promise<string> {
  const res = await fetch(REST_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const todos = (await res.json()) as { id: number; title: string; completed: boolean }[];
  return todos.map((t) => `#${t.id} ${t.completed ? '[x]' : '[ ]'} ${t.title}`).join('\n');
}

async function fetchGraphql(): Promise<string> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: GRAPHQL_QUERY }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    data?: { countries: { code: string; name: string; capital: string; currency: string }[] };
    errors?: { message: string }[];
  };
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('\n'));
  return (json.data?.countries ?? [])
    .map((c) => `${c.code}  ${c.name} — ${c.capital} (${c.currency})`)
    .join('\n');
}

function TestButton({
  label,
  running,
  onPress,
}: {
  label: string;
  running: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={running}
      style={({ pressed }) => [styles.button, (pressed || running) && styles.buttonPressed]}
    >
      {running ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{label}</Text>}
    </Pressable>
  );
}

export default function App() {
  // Surface this app's HTTP traffic in the Rozenite Network Activity panel.
  useNetworkActivityDevTools();

  const isDark = useColorScheme() === 'dark';
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  const run = (label: string, task: () => Promise<string>) => {
    setResult({ kind: 'loading', label });
    task()
      .then((text) => setResult({ kind: 'done', label, text }))
      .catch((err: Error) => setResult({ kind: 'error', label, text: String(err.message ?? err) }));
  };

  return (
    <View style={[styles.container, isDark && styles.containerDark]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Text style={styles.title}>DevTools PoC test app</Text>
      <Text style={styles.subtitle}>
        Fire a request below, then check the Rozenite network panel and the GraphQL extension
        panels in the DevTools shell.
      </Text>

      <View style={styles.buttons}>
        <TestButton
          label="Fetch REST (JSONPlaceholder)"
          running={result.kind === 'loading' && result.label === 'REST'}
          onPress={() => run('REST', fetchRest)}
        />
        <TestButton
          label="Fetch GraphQL (countries.trevorblades.com)"
          running={result.kind === 'loading' && result.label === 'GraphQL'}
          onPress={() => run('GraphQL', fetchGraphql)}
        />
      </View>

      <ScrollView style={styles.results} contentContainerStyle={styles.resultsContent}>
        {result.kind === 'idle' && <Text style={styles.hint}>No requests yet.</Text>}
        {result.kind !== 'idle' && (
          <>
            <Text style={styles.resultLabel}>
              {result.label} — {result.kind === 'loading' ? 'loading…' : result.kind}
            </Text>
            {result.kind === 'done' || result.kind === 'error' ? (
              <Text style={[styles.resultText, result.kind === 'error' && styles.resultError]}>
                {result.text}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'stretch',
    paddingTop: 80,
    paddingHorizontal: 24,
  },
  containerDark: {
    backgroundColor: '#0d1117',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    opacity: 0.7,
    marginBottom: 24,
  },
  buttons: {
    gap: 12,
  },
  button: {
    backgroundColor: '#20232a',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  results: {
    flex: 1,
    marginTop: 24,
  },
  resultsContent: {
    paddingBottom: 40,
  },
  hint: {
    opacity: 0.5,
  },
  resultLabel: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    opacity: 0.6,
    marginBottom: 8,
  },
  resultText: {
    fontSize: 14,
    lineHeight: 22,
    fontFamily: 'Menlo',
  },
  resultError: {
    color: '#e5484d',
  },
});
