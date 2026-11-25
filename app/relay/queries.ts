// Relay operations, compiled by `npm run relay` into ./__generated__ (committed).
// This file is never imported: the app has no babel-plugin-relay, so a runtime
// `graphql` tag would throw. demos/RelayDemo.tsx imports the generated artifact.
import { graphql } from 'relay-runtime';

export const countryQuery = graphql`
  query queriesCountryQuery($code: ID!) {
    country(code: $code) {
      code
      name
      capital
      emoji
      continent {
        code
        name
      }
    }
  }
`;
