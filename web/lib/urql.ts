import { Client, cacheExchange, fetchExchange, subscriptionExchange } from 'urql';
import { createClient as createWSClient } from 'graphql-ws';
import { nhost, GRAPHQL_HTTP, GRAPHQL_WS } from './nhost';

// Build a urql client that authenticates both HTTP and WebSocket traffic with the
// current nhost access token (so Hasura resolves X-Hasura-User-Id / role for permissions).
export function makeClient(): Client {
  const authHeader = () => {
    const token = nhost.auth.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const wsClient =
    typeof window !== 'undefined'
      ? createWSClient({
          url: GRAPHQL_WS,
          connectionParams: () => ({ headers: authHeader() }),
        })
      : null;

  return new Client({
    url: GRAPHQL_HTTP,
    exchanges: [
      cacheExchange,
      fetchExchange,
      subscriptionExchange({
        forwardSubscription: (request) => ({
          subscribe: (sink) => ({
            unsubscribe: wsClient!.subscribe({ ...request, query: request.query || '' }, sink),
          }),
        }),
      }),
    ],
    fetchOptions: () => ({ headers: authHeader() }),
    requestPolicy: 'cache-and-network',
  });
}
