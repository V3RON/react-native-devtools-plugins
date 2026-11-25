import { ApolloClient, gql, HttpLink, InMemoryCache } from '@apollo/client';
import { ApolloProvider, useLazyQuery, useMutation } from '@apollo/client/react';
import { useState } from 'react';
import { Text } from 'react-native';
import { DemoBox, DemoButton } from './ui';

// An Apollo Client for the Apollo Client Devtools extension. With `devtools.enabled`
// the client registers itself on `window[Symbol.for("apollo.devtools")]` (and
// `window.__APOLLO_CLIENT__`), which the extension's hook reads whenever it is
// injected, so no early install is needed. Mutations go to a second public API
// (GraphQLZero) through the same client, by per-operation `context.uri`.
export const apolloClient = new ApolloClient({
  link: new HttpLink({ uri: 'https://countries.trevorblades.com/' }),
  cache: new InMemoryCache(),
  devtools: { enabled: true, name: 'PoC Apollo client' },
});

const CONTINENT = gql`
  query ApolloContinent($code: ID!) {
    continent(code: $code) {
      code
      name
      countries {
        code
        name
      }
    }
  }
`;

const CREATE_POST = gql`
  mutation ApolloCreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      id
      title
    }
  }
`;

const CODES = ['EU', 'AF', 'SA'];

function Continents() {
  const [index, setIndex] = useState(0);
  const [load, { data, loading, error }] = useLazyQuery<{
    continent: { code: string; name: string; countries: { code: string }[] } | null;
  }>(CONTINENT);
  const [createPost, created] = useMutation<{ createPost: { id: string; title: string } }>(CREATE_POST, {
    context: { uri: 'https://graphqlzero.almansi.me/api' },
  });
  const summary = created.loading
    ? 'mutating…'
    : created.data
      ? `created post ${created.data.createPost.id}`
      : loading
    ? 'loading…'
    : error
      ? `error: ${error.message}`
      : data?.continent
        ? `${data.continent.name}: ${data.continent.countries.length} countries`
        : 'no query yet';
  return (
    <DemoBox title="Apollo Client" color="#311c87">
      <DemoButton
        color="#311c87"
        label={`Query continent ${CODES[index]}`}
        onPress={() => {
          load({ variables: { code: CODES[index] } });
          setIndex((index + 1) % CODES.length);
        }}
      />
      <DemoButton
        color="#311c87"
        label="Create post (mutation)"
        onPress={() => createPost({ variables: { input: { title: `PoC ${Date.now()}`, body: 'from RN' } } })}
      />
      <Text style={{ alignSelf: 'center', fontSize: 13 }}>{summary}</Text>
    </DemoBox>
  );
}

export function ApolloDemo() {
  return (
    <ApolloProvider client={apolloClient}>
      <Continents />
    </ApolloProvider>
  );
}
