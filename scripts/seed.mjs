#!/usr/bin/env node
/**
 * Seeds two organizations and links already-signed-up auth users to them with roles.
 * Idempotent. Run AFTER the demo users have signed up in the app (so they exist in
 * auth.users) and AFTER setup-db.mjs + setup-hasura.mjs.
 *
 *   NHOST_SUBDOMAIN / NHOST_REGION / NHOST_ADMIN_SECRET  (env or .env)
 *   Demo user emails (override via env; defaults shown):
 *     SEED_A_OWNER  = a.owner@example.com
 *     SEED_A_EDITOR = a.editor@example.com
 *     SEED_A_VIEWER = a.viewer@example.com
 *     SEED_B_OWNER  = b.owner@example.com
 */
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const { NHOST_SUBDOMAIN, NHOST_REGION, NHOST_ADMIN_SECRET } = process.env;
if (!NHOST_SUBDOMAIN || !NHOST_REGION || !NHOST_ADMIN_SECRET) {
  console.error('Missing env: NHOST_SUBDOMAIN, NHOST_REGION, NHOST_ADMIN_SECRET');
  process.exit(1);
}
const URL = `https://${NHOST_SUBDOMAIN}.hasura.${NHOST_REGION}.nhost.run/v1/graphql`;

async function gql(query, variables = {}) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': NHOST_ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function userIdByEmail(email) {
  const d = await gql(`query ($e: citext!) { users(where: { email: { _eq: $e } }) { id } }`, { e: email });
  return d.users[0]?.id ?? null;
}

async function upsertOrg(name, allowed) {
  const d = await gql(`query ($n: String!) { organizations(where: { name: { _eq: $n } }) { id } }`, { n: name });
  if (d.organizations[0]) return d.organizations[0].id;
  const ins = await gql(
    `mutation ($n: String!, $a: Int!) { insert_organizations_one(object: { name: $n, calls_allowed: $a }) { id } }`,
    { n: name, a: allowed },
  );
  return ins.insert_organizations_one.id;
}

async function link(orgId, email, role) {
  const uid = await userIdByEmail(email);
  if (!uid) { console.warn(`  ! no auth user for ${email} — sign this user up first, then re-run`); return; }
  await gql(
    `mutation ($o: uuid!, $u: uuid!, $r: String!) {
       insert_org_members_one(
         object: { org_id: $o, user_id: $u, role: $r },
         on_conflict: { constraint: org_members_org_id_user_id_key, update_columns: [role] }
       ) { id }
     }`,
    { o: orgId, u: uid, r: role },
  );
  console.log(`  linked ${email} as ${role}`);
}

const A_OWNER = process.env.SEED_A_OWNER || 'a.owner@example.com';
const A_EDITOR = process.env.SEED_A_EDITOR || 'a.editor@example.com';
const A_VIEWER = process.env.SEED_A_VIEWER || 'a.viewer@example.com';
const B_OWNER = process.env.SEED_B_OWNER || 'b.owner@example.com';

const orgA = await upsertOrg('Org A', 100);
const orgB = await upsertOrg('Org B', 100);
console.log('Org A:', orgA, '\nOrg B:', orgB);

console.log('Linking Org A members:');
await link(orgA, A_OWNER, 'owner');
await link(orgA, A_EDITOR, 'editor');
await link(orgA, A_VIEWER, 'viewer');
console.log('Linking Org B members:');
await link(orgB, B_OWNER, 'owner');

console.log('\nSeed complete.');
