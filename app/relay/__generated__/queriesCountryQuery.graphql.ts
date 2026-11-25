/**
 * @generated SignedSource<<0c32f3e26bc9a259eec8ee9c4f193b34>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type queriesCountryQuery$variables = {
  code: string;
};
export type queriesCountryQuery$data = {
  readonly country: {
    readonly capital: string | null | undefined;
    readonly code: string;
    readonly continent: {
      readonly code: string;
      readonly name: string;
    };
    readonly emoji: string;
    readonly name: string;
  } | null | undefined;
};
export type queriesCountryQuery = {
  response: queriesCountryQuery$data;
  variables: queriesCountryQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "code"
  }
],
v1 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "code",
  "storageKey": null
},
v2 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "name",
  "storageKey": null
},
v3 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "code",
        "variableName": "code"
      }
    ],
    "concreteType": "Country",
    "kind": "LinkedField",
    "name": "country",
    "plural": false,
    "selections": [
      (v1/*:: as any*/),
      (v2/*:: as any*/),
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "capital",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "emoji",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "Continent",
        "kind": "LinkedField",
        "name": "continent",
        "plural": false,
        "selections": [
          (v1/*:: as any*/),
          (v2/*:: as any*/)
        ],
        "storageKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "queriesCountryQuery",
    "selections": (v3/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "queriesCountryQuery",
    "selections": (v3/*:: as any*/)
  },
  "params": {
    "cacheID": "96f9a3543d6191b68bf180793a5630d9",
    "id": null,
    "metadata": {},
    "name": "queriesCountryQuery",
    "operationKind": "query",
    "text": "query queriesCountryQuery(\n  $code: ID!\n) {\n  country(code: $code) {\n    code\n    name\n    capital\n    emoji\n    continent {\n      code\n      name\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "368463f106cd2241a35dc7e4b4182dd4";

export default node;
