import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text } from 'react-native';
import { DemoBox, DemoButton } from './ui';

// A TanStack Query client for the TanStack Query DevTools extension, which finds it
// through `window.__TANSTACK_QUERY_CLIENT__` (read when the extension is injected and
// watched afterwards), as its store listing asks.
export const queryClient = new QueryClient();

declare global {
  // eslint-disable-next-line no-var
  var __TANSTACK_QUERY_CLIENT__: QueryClient | undefined;
}
if (__DEV__) globalThis.__TANSTACK_QUERY_CLIENT__ = queryClient;

type Post = { id: number; title: string };

function Posts() {
  const [user, setUser] = useState(1);
  const client = useQueryClient();
  const posts = useQuery({
    queryKey: ['posts', { user }],
    queryFn: async (): Promise<Post[]> => {
      const res = await fetch(`https://jsonplaceholder.typicode.com/posts?userId=${user}&_limit=3`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
  const createPost = useMutation({
    mutationKey: ['createPost'],
    mutationFn: async (title: string): Promise<Post> => {
      const res = await fetch('https://jsonplaceholder.typicode.com/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, userId: user }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
  return (
    <DemoBox title={`TanStack Query: user ${user}`} color="#ef4444">
      <DemoButton color="#ef4444" label="Next user" onPress={() => setUser((u) => (u % 5) + 1)} />
      <DemoButton color="#ef4444" label="Invalidate" onPress={() => client.invalidateQueries({ queryKey: ['posts'] })} />
      <DemoButton color="#ef4444" label="Create post (mutation)" onPress={() => createPost.mutate(`PoC ${Date.now()}`)} />
      <Text style={{ alignSelf: 'center', fontSize: 13 }}>
        {posts.isFetching ? 'fetching…' : posts.error ? 'error' : `${posts.data?.length ?? 0} posts`}
        {createPost.data ? `, created ${createPost.data.id}` : ''}
      </Text>
    </DemoBox>
  );
}

export function QueryDemo() {
  return (
    <QueryClientProvider client={queryClient}>
      <Posts />
    </QueryClientProvider>
  );
}
