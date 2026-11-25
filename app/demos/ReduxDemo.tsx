import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { Text } from 'react-native';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { DemoBox, DemoButton } from './ui';

// A Redux Toolkit store for the Redux DevTools extension. configureStore picks up
// `window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__` when the store is created, i.e. at
// module load, so in dev that global is installed before any module runs (see
// metro.config.js). `name` is given because the extension otherwise reads
// `document.title`, which React Native does not have. `trace` fills the panel's Trace
// tab with the dispatch's stack.
const cart = createSlice({
  name: 'cart',
  initialState: { items: [] as { id: number; sku: string; qty: number }[], nextId: 1 },
  reducers: {
    addItem(state, action: PayloadAction<string>) {
      state.items.push({ id: state.nextId, sku: action.payload, qty: 1 });
      state.nextId += 1;
    },
    bumpFirst(state) {
      if (state.items[0]) state.items[0].qty += 1;
    },
    reset(state) {
      state.items = [];
    },
  },
});

// RTK Query, for the panel's "RTK Query" tab.
const usersApi = createApi({
  reducerPath: 'usersApi',
  baseQuery: fetchBaseQuery({ baseUrl: 'https://jsonplaceholder.typicode.com/' }),
  endpoints: (build) => ({
    getUser: build.query<{ id: number; name: string }, number>({ query: (id) => `users/${id}` }),
  }),
});

export const reduxStore = configureStore({
  reducer: { cart: cart.reducer, [usersApi.reducerPath]: usersApi.reducer },
  middleware: (getDefault) => getDefault().concat(usersApi.middleware),
  devTools: { name: 'PoC Redux store', trace: true, traceLimit: 12 },
});

type RootState = ReturnType<typeof reduxStore.getState>;

function Cart() {
  const dispatch = useDispatch();
  const items = useSelector((state: RootState) => state.cart.items);
  const qty = items.reduce((sum, item) => sum + item.qty, 0);
  const [loadUser, user] = usersApi.useLazyGetUserQuery();
  return (
    <DemoBox title={`Redux cart: ${items.length} lines, ${qty} items`} color="#764abc">
      <DemoButton color="#764abc" label="Add item" onPress={() => dispatch(cart.actions.addItem(`SKU-${items.length + 1}`))} />
      <DemoButton color="#764abc" label="+1 first" onPress={() => dispatch(cart.actions.bumpFirst())} />
      <DemoButton color="#764abc" label="Reset" onPress={() => dispatch(cart.actions.reset())} />
      <DemoButton color="#764abc" label="RTK Query user" onPress={() => loadUser((user.data?.id ?? 0) + 1)} />
      <Text style={{ alignSelf: 'center', fontSize: 13 }}>{user.data ? user.data.name : 'no user'}</Text>
    </DemoBox>
  );
}

export function ReduxDemo() {
  return (
    <Provider store={reduxStore}>
      <Cart />
    </Provider>
  );
}
