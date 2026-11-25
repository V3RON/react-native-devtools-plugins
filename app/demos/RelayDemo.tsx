import { useState } from 'react';
import { Text } from 'react-native';
import { commitLocalUpdate, Environment, fetchQuery, Network, RecordSource, Store, type Disposable } from 'relay-runtime';
import CountryQuery, { type queriesCountryQuery } from '../relay/__generated__/queriesCountryQuery.graphql';
import { DemoBox, DemoButton } from './ui';

// A Relay environment for the Relay Developer Tools extension. relay-runtime calls
// `__RELAY_DEVTOOLS_HOOK__.registerEnvironment` from the Environment constructor, i.e.
// at module load, so in dev the hook is installed before any module runs
// (metro.config.js). The operation is compiled by `npm run relay` (relay/queries.ts).
export const relayEnvironment = new Environment({
  network: Network.create(async (operation, variables) => {
    const res = await fetch('https://countries.trevorblades.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: operation.text, variables }),
    });
    return res.json();
  }),
  store: new Store(new RecordSource()),
});

const CODES = ['PL', 'JP', 'BR', 'KE'];

export function RelayDemo() {
  const [index, setIndex] = useState(0);
  const [summary, setSummary] = useState('no query yet');
  const run = () => {
    const code = CODES[index];
    setIndex((index + 1) % CODES.length);
    setSummary('loading…');
    fetchQuery<queriesCountryQuery>(relayEnvironment, CountryQuery, { code }).subscribe({
      next: (data) => setSummary(data.country ? `${data.country.emoji} ${data.country.name}` : 'not found'),
      error: (error: Error) => setSummary(`error: ${error.message}`),
    });
  };
  // An optimistic update (the panel's "Optimistic Updates" tab) and a local update, on
  // the PL record once it is in the store.
  const [optimistic, setOptimistic] = useState<Disposable | null>(null);
  const toggleOptimistic = () => {
    if (optimistic) {
      optimistic.dispose();
      setOptimistic(null);
      return;
    }
    setOptimistic(
      relayEnvironment.applyUpdate({
        storeUpdater: (store) => {
          const country = store.getRoot().getLinkedRecord('country', { code: 'PL' });
          country?.setValue('Polska (optimistic)', 'name');
        },
      })
    );
  };
  const localUpdate = () =>
    commitLocalUpdate(relayEnvironment, (store) => {
      const country = store.getRoot().getLinkedRecord('country', { code: 'PL' });
      country?.setValue(`Warsaw ${new Date().toISOString().slice(11, 19)}`, 'capital');
    });
  return (
    <DemoBox title="Relay" color="#f26b00">
      <DemoButton color="#f26b00" label={`Query country ${CODES[index]}`} onPress={run} />
      <DemoButton color="#f26b00" label={optimistic ? 'Revert optimistic' : 'Optimistic PL'} onPress={toggleOptimistic} />
      <DemoButton color="#f26b00" label="Local update PL" onPress={localUpdate} />
      <Text style={{ alignSelf: 'center', fontSize: 13 }}>{summary}</Text>
    </DemoBox>
  );
}
