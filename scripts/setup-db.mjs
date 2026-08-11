#!/usr/bin/env node
/**
 * Applies the schema (nhost/migrations/default/1723334400000_init/up.sql) to the nhost
 * Cloud Postgres via Hasura's run_sql API — no Docker or CLI needed. The SQL is
 * idempotent, so this is safe to re-run. Run this BEFORE scripts/setup-hasura.mjs.
 *
 *   NHOST_SUBDOMAIN=xxx NHOST_REGION=eu-central-1 NHOST_ADMIN_SECRET=yyy \
 *     node scripts/setup-db.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

const sqlPath = path.join(__dirname, '..', 'nhost', 'migrations', 'default', '1723334400000_init', 'up.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');
const url = `https://${NHOST_SUBDOMAIN}.hasura.${NHOST_REGION}.nhost.run/v2/query`;

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': NHOST_ADMIN_SECRET },
  body: JSON.stringify({ type: 'run_sql', args: { source: 'default', sql, cascade: false } }),
});
const text = await res.text();
if (!res.ok) { console.error('run_sql failed:\n', text); process.exit(1); }
console.log('Schema applied.');
