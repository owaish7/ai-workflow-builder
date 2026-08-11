// Admin GraphQL client for the API routes. Uses the nhost admin secret to bypass row
// permissions so the executor can create/advance runs on behalf of the system.
const ADMIN_SECRET =
  process.env.NHOST_ADMIN_SECRET || process.env.HASURA_GRAPHQL_ADMIN_SECRET || '';

export const GRAPHQL_URL =
  process.env.GRAPHQL_ENDPOINT ||
  `https://${process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN}.hasura.${process.env.NEXT_PUBLIC_NHOST_REGION}.nhost.run/v1/graphql`;

export async function admin<T = any>(query: string, variables: Record<string, any> = {}): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json();
  if (json.errors) throw new Error('GraphQL error: ' + JSON.stringify(json.errors));
  return json.data as T;
}

export async function memberRole(userId: string, orgId: string): Promise<string | null> {
  const data = await admin<{ org_members: { role: string }[] }>(
    `query ($u: uuid!, $o: uuid!) {
       org_members(where: { user_id: { _eq: $u }, org_id: { _eq: $o } }) { role }
     }`,
    { u: userId, o: orgId },
  );
  return data.org_members[0]?.role ?? null;
}

// Shared secret Hasura sends with every Action / event / cron call, so these
// publicly-reachable routes can't be driven with a forged session_variables payload.
export function verifyActionSecret(req: Request): boolean {
  const expected = process.env.ACTION_SECRET;
  if (!expected) return true; // not configured -> don't block (local dev)
  return req.headers.get('x-action-secret') === expected;
}
