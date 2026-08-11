#!/usr/bin/env node
/**
 * Applies all Hasura configuration to an nhost Cloud project WITHOUT Docker or the
 * Hasura CLI — it talks to the Hasura metadata API directly and is idempotent
 * (safe to re-run). It is additive: it only touches the `public` objects below and
 * never replaces global metadata, so nhost's auth/storage config is left intact.
 *
 * Applies: table tracking, relationships, Layer-1 + Layer-2a permissions (role `user`),
 * the two Actions (triggerWorkflowRun, approveStep), the cron trigger, and the two
 * event triggers (db_event + notify).
 *
 * Usage:
 *   NHOST_SUBDOMAIN=xxx NHOST_REGION=eu-central-1 NHOST_ADMIN_SECRET=yyy \
 *     node scripts/setup-hasura.mjs
 * or copy .env.example -> .env and run `node scripts/setup-hasura.mjs` (auto-loads .env).
 */
import fs from 'node:fs';
import path from 'node:path';

// --- tiny .env loader (no dependency) ---
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SUBDOMAIN = process.env.NHOST_SUBDOMAIN;
const REGION = process.env.NHOST_REGION;
const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET;
if (!SUBDOMAIN || !REGION || !ADMIN_SECRET) {
  console.error('Missing env: NHOST_SUBDOMAIN, NHOST_REGION, NHOST_ADMIN_SECRET');
  process.exit(1);
}

const HASURA = `https://${SUBDOMAIN}.hasura.${REGION}.nhost.run`;
const FUNCTIONS = process.env.NHOST_FUNCTIONS_URL
  || `https://${SUBDOMAIN}.functions.${REGION}.nhost.run`;
const META = `${HASURA}/v1/metadata`;
const fn = (name) => `${FUNCTIONS}/${name}`;

async function meta(type, args, { ignore = [] } = {}) {
  const res = await fetch(META, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ type, args }),
  });
  const text = await res.text();
  if (res.ok) { console.log(`  ok   ${type}`); return; }
  const lc = text.toLowerCase();
  if (ignore.some((s) => lc.includes(s))) { console.log(`  skip ${type} (already applied)`); return; }
  console.error(`  FAIL ${type}: ${text}`);
  throw new Error(`${type} failed`);
}
const IGN_EXISTS = ['already', 'exist', 'cannot be applied', 'not found', 'no such'];

const src = 'default';
const T = (name) => ({ schema: 'public', name });
// session-scoped membership fragments (reused across tables)
const me = { user_id: { _eq: 'X-Hasura-User-Id' } };
const meRole = (roles) => ({ user_id: { _eq: 'X-Hasura-User-Id' }, role: { _in: roles } });
const meOwner = { user_id: { _eq: 'X-Hasura-User-Id' }, role: { _eq: 'owner' } };

async function main() {
  console.log(`Hasura: ${HASURA}\nFunctions: ${FUNCTIONS}\n`);

  // ---------------- 1. track tables + view ----------------
  console.log('# tracking tables');
  for (const name of ['organizations', 'org_members', 'workflows', 'workflow_steps',
    'workflow_triggers', 'workflow_runs', 'step_runs', 'db_write_results',
    'notifications', 'event_source', 'org_usage']) {
    await meta('pg_track_table', { source: src, table: T(name) }, { ignore: IGN_EXISTS });
  }

  // ---------------- 2. relationships ----------------
  console.log('# relationships');
  const objRel = (table, name, column) =>
    meta('pg_create_object_relationship',
      { source: src, table: T(table), name, using: { foreign_key_constraint_on: column } },
      { ignore: IGN_EXISTS });
  const arrRel = (table, name, remote, column) =>
    meta('pg_create_array_relationship',
      { source: src, table: T(table), name,
        using: { foreign_key_constraint_on: { table: T(remote), column } } },
      { ignore: IGN_EXISTS });

  await objRel('org_members', 'organization', 'org_id');
  await objRel('workflows', 'organization', 'org_id');
  await objRel('workflow_steps', 'workflow', 'workflow_id');
  await objRel('workflow_triggers', 'workflow', 'workflow_id');
  await objRel('workflow_runs', 'workflow', 'workflow_id');
  await objRel('workflow_runs', 'organization', 'org_id');
  await objRel('step_runs', 'run', 'run_id');
  await objRel('step_runs', 'step', 'step_id');
  await objRel('db_write_results', 'organization', 'org_id');
  await objRel('notifications', 'organization', 'org_id');
  await objRel('event_source', 'organization', 'org_id');
  await objRel('event_source', 'workflow', 'workflow_id');

  await arrRel('organizations', 'members', 'org_members', 'org_id');
  await arrRel('organizations', 'workflows', 'workflows', 'org_id');
  await arrRel('organizations', 'runs', 'workflow_runs', 'org_id');
  await arrRel('workflows', 'steps', 'workflow_steps', 'workflow_id');
  await arrRel('workflows', 'triggers', 'workflow_triggers', 'workflow_id');
  await arrRel('workflows', 'runs', 'workflow_runs', 'workflow_id');
  await arrRel('workflow_runs', 'step_runs', 'step_runs', 'run_id');

  // view -> members (manual relationship for permission scoping)
  await meta('pg_create_array_relationship', {
    source: src, table: T('org_usage'), name: 'members',
    using: { manual_configuration: { remote_table: T('org_members'), column_mapping: { org_id: 'org_id' } } },
  }, { ignore: IGN_EXISTS });

  // ---------------- 3. permissions (role `user`) ----------------
  console.log('# permissions');
  // drop-then-create makes each permission idempotent
  const perm = async (perm, table, role, definition) => {
    const dropType = `pg_drop_${perm}_permission`;
    const createType = `pg_create_${perm}_permission`;
    await meta(dropType, { source: src, table: T(table), role }, { ignore: IGN_EXISTS });
    await meta(createType, { source: src, table: T(table), role, permission: definition });
  };

  // organizations: members read; owner may rename
  await perm('select', 'organizations', 'user',
    { columns: ['id', 'name', 'calls_used', 'calls_allowed', 'period_start', 'created_at'], filter: { members: me } });
  await perm('update', 'organizations', 'user',
    { columns: ['name'], filter: { members: meOwner }, check: {} });

  // org_usage (aggregation view): members read
  await perm('select', 'org_usage', 'user',
    { columns: ['org_id', 'calls_used', 'calls_allowed', 'period_start', 'runs_this_month', 'avg_run_seconds'],
      filter: { members: me } });

  // org_members: read fellow members; only owner manages membership
  await perm('select', 'org_members', 'user',
    { columns: ['id', 'org_id', 'user_id', 'role', 'created_at'], filter: { organization: { members: me } } });
  await perm('insert', 'org_members', 'user',
    { columns: ['org_id', 'user_id', 'role'], check: { organization: { members: meOwner } } });
  await perm('update', 'org_members', 'user',
    { columns: ['role'], filter: { organization: { members: meOwner } }, check: {} });
  await perm('delete', 'org_members', 'user', { filter: { organization: { members: meOwner } } });

  // workflows: members read; owner/editor write
  const wfEditor = { organization: { members: meRole(['owner', 'editor']) } };
  await perm('select', 'workflows', 'user',
    { columns: ['id', 'org_id', 'name', 'created_by', 'created_at'], filter: { organization: { members: me } } });
  await perm('insert', 'workflows', 'user',
    { columns: ['org_id', 'name'], check: wfEditor, set: { created_by: 'x-hasura-user-id' } });
  await perm('update', 'workflows', 'user', { columns: ['name'], filter: wfEditor, check: wfEditor });
  await perm('delete', 'workflows', 'user', { filter: wfEditor });

  // workflow_steps: members read; owner/editor write BUT db_write/notify => owner only (Layer 2a)
  const stepEditor = { workflow: { organization: { members: meRole(['owner', 'editor']) } } };
  const stepGate = {
    _or: [
      { _and: [{ type: { _nin: ['db_write', 'notify'] } }, { workflow: { organization: { members: meRole(['owner', 'editor']) } } }] },
      { _and: [{ type: { _in: ['db_write', 'notify'] } }, { workflow: { organization: { members: meOwner } } }] },
    ],
  };
  await perm('select', 'workflow_steps', 'user',
    { columns: ['id', 'workflow_id', 'position', 'type', 'config', 'created_at'],
      filter: { workflow: { organization: { members: me } } } });
  await perm('insert', 'workflow_steps', 'user',
    { columns: ['workflow_id', 'position', 'type', 'config'], check: stepGate });
  await perm('update', 'workflow_steps', 'user',
    { columns: ['position', 'type', 'config'], filter: stepEditor, check: stepGate });
  await perm('delete', 'workflow_steps', 'user', { filter: stepEditor });

  // workflow_triggers: members read; owner/editor write BUT webhook => owner only (Layer 2a)
  const trgEditor = { workflow: { organization: { members: meRole(['owner', 'editor']) } } };
  const trgGate = {
    _or: [
      { _and: [{ type: { _neq: 'webhook' } }, { workflow: { organization: { members: meRole(['owner', 'editor']) } } }] },
      { _and: [{ type: { _eq: 'webhook' } }, { workflow: { organization: { members: meOwner } } }] },
    ],
  };
  await perm('select', 'workflow_triggers', 'user',
    { columns: ['id', 'workflow_id', 'type', 'config', 'created_at'],
      filter: { workflow: { organization: { members: me } } } });
  await perm('insert', 'workflow_triggers', 'user',
    { columns: ['workflow_id', 'type', 'config'], check: trgGate });
  await perm('update', 'workflow_triggers', 'user',
    { columns: ['type', 'config'], filter: trgEditor, check: trgGate });
  await perm('delete', 'workflow_triggers', 'user', { filter: trgEditor });

  // workflow_runs: members read ONLY (runs created/advanced by functions via admin; triggered via Action)
  await perm('select', 'workflow_runs', 'user',
    { columns: ['id', 'workflow_id', 'org_id', 'status', 'trigger_type', 'started_by', 'started_at', 'finished_at', 'updated_at'],
      filter: { organization: { members: me } } });

  // step_runs: members read ONLY (drives the live subscription; approvals go through the Action)
  await perm('select', 'step_runs', 'user',
    { columns: ['id', 'run_id', 'step_id', 'position', 'type', 'status', 'input', 'output', 'error', 'attempt', 'approved_by', 'approved_at', 'created_at', 'updated_at'],
      filter: { run: { organization: { members: me } } } });

  // db_write_results: members read
  await perm('select', 'db_write_results', 'user',
    { columns: ['id', 'run_id', 'org_id', 'payload', 'created_at'], filter: { organization: { members: me } } });

  // notifications: members read
  await perm('select', 'notifications', 'user',
    { columns: ['id', 'run_id', 'org_id', 'channel', 'message', 'created_at'], filter: { organization: { members: me } } });

  // event_source: members read; owner/editor may drop an event row (fires the DB-event trigger)
  await perm('select', 'event_source', 'user',
    { columns: ['id', 'org_id', 'workflow_id', 'payload', 'created_at'], filter: { organization: { members: me } } });
  await perm('insert', 'event_source', 'user',
    { columns: ['org_id', 'workflow_id', 'payload'], check: { organization: { members: meRole(['owner', 'editor']) } } });

  // ---------------- 4. Actions ----------------
  console.log('# actions');
  await meta('set_custom_types', {
    scalars: [], input_objects: [], enums: [],
    objects: [
      { name: 'RunResult', fields: [{ name: 'run_id', type: 'String' }, { name: 'status', type: 'String!' }, { name: 'message', type: 'String' }] },
      { name: 'StepResult', fields: [{ name: 'step_run_id', type: 'String' }, { name: 'status', type: 'String!' }, { name: 'message', type: 'String' }] },
    ],
  });
  const secretHeader = [{ name: 'nhost-webhook-secret', value_from_env: 'NHOST_WEBHOOK_SECRET' }];
  const action = async (name, args, output, comment) => {
    await meta('drop_action', { name, clear_data: true }, { ignore: IGN_EXISTS });
    await meta('create_action', {
      name,
      definition: {
        handler: fn(name), type: 'mutation', kind: 'synchronous',
        arguments: args, output_type: output, headers: secretHeader, forward_client_headers: false,
      },
      comment,
    });
    await meta('create_action_permission', { action: name, role: 'user' }, { ignore: IGN_EXISTS });
  };
  await action('triggerWorkflowRun', [{ name: 'workflow_id', type: 'uuid!' }], 'RunResult',
    'Starts a workflow run: verifies owner/editor, checks quota, executes steps, pauses on approval_gate.');
  await action('approveStep', [{ name: 'step_run_id', type: 'uuid!' }], 'StepResult',
    'Approves a paused approval_gate step after checking the approver role, then resumes the run.');

  // ---------------- 5. cron trigger (Scheduled) ----------------
  console.log('# cron trigger');
  await meta('delete_cron_trigger', { name: 'scheduled_workflow_tick' }, { ignore: IGN_EXISTS });
  await meta('create_cron_trigger', {
    name: 'scheduled_workflow_tick', webhook: fn('scheduled'), schedule: '* * * * *',
    payload: {}, include_in_metadata: true, headers: secretHeader,
    retry_conf: { num_retries: 0, timeout_seconds: 60, tolerance_seconds: 21600, retry_interval_seconds: 10 },
  });

  // ---------------- 6. event triggers (DB-event + notify) ----------------
  console.log('# event triggers');
  await meta('pg_delete_event_trigger', { source: src, name: 'on_event_source_insert' }, { ignore: IGN_EXISTS });
  await meta('pg_create_event_trigger', {
    source: src, name: 'on_event_source_insert', table: T('event_source'), webhook: fn('dbEvent'),
    insert: { columns: '*' }, headers: secretHeader,
    retry_conf: { num_retries: 0, interval_sec: 10, timeout_sec: 60 },
  });
  await meta('pg_delete_event_trigger', { source: src, name: 'on_notification_insert' }, { ignore: IGN_EXISTS });
  await meta('pg_create_event_trigger', {
    source: src, name: 'on_notification_insert', table: T('notifications'), webhook: fn('notify'),
    insert: { columns: '*' }, headers: secretHeader,
    retry_conf: { num_retries: 0, interval_sec: 10, timeout_sec: 60 },
  });

  console.log('\nDone. Hasura configured.');
}

main().catch((e) => { console.error(e); process.exit(1); });
