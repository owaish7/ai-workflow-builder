// Admin GraphQL client for nhost functions. Uses the admin secret to bypass row
// permissions so the executor can create/advance runs on behalf of the system.
// nhost injects NHOST_SUBDOMAIN / NHOST_REGION / NHOST_ADMIN_SECRET into functions.

const SUBDOMAIN = process.env.NHOST_SUBDOMAIN || '';
const REGION = process.env.NHOST_REGION || '';
const ADMIN_SECRET =
  process.env.NHOST_ADMIN_SECRET || process.env.HASURA_GRAPHQL_ADMIN_SECRET || '';

// Resolve the GraphQL endpoint from whichever env var nhost provides. If your project's
// functions don't get NHOST_SUBDOMAIN/REGION, set HASURA_GRAPHQL_URL as a project env var.
export const GRAPHQL_URL =
  process.env.HASURA_GRAPHQL_URL ||
  process.env.NHOST_GRAPHQL_URL ||
  (process.env.NHOST_BACKEND_URL ? `${process.env.NHOST_BACKEND_URL}/v1/graphql` : '') ||
  `https://${SUBDOMAIN}.hasura.${REGION}.nhost.run/v1/graphql`;

export async function admin<T = any>(
  query: string,
  variables: Record<string, any> = {},
): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json();
  if (json.errors) throw new Error('GraphQL error: ' + JSON.stringify(json.errors));
  return json.data as T;
}

// Returns the caller's role in an org, or null if they are not a member.
export async function memberRole(userId: string, orgId: string): Promise<string | null> {
  const data = await admin<{ org_members: { role: string }[] }>(
    `query ($u: uuid!, $o: uuid!) {
       org_members(where: { user_id: { _eq: $u }, org_id: { _eq: $o } }) { role }
     }`,
    { u: userId, o: orgId },
  );
  return data.org_members[0]?.role ?? null;
}

// Verify the shared secret Hasura sends with every Action / event / cron call, so the
// publicly-reachable function endpoints cannot be invoked with a forged payload.
export function verifyWebhookSecret(req: any): boolean {
  const expected = process.env.NHOST_WEBHOOK_SECRET;
  if (!expected) return true; // not configured (e.g. local) -> don't block
  const got = req.headers['nhost-webhook-secret'] || req.headers['x-nhost-webhook-secret'];
  return got === expected;
}
