// Workflow executor: a plain sequential loop that RETURNS when it hits an approval
// gate (setting the run to `paused`), and can be re-entered to resume after approval.
// Every state transition is written to step_runs / workflow_runs so the GraphQL
// subscription reflects progress live.
import { admin, memberRole } from './db';
import { llmCall } from './groq';

export type Ctx = { userId?: string | null; system?: boolean; triggerType: string };
type RunResult = { run_id?: string; status: string; message?: string };

// ---------------- GraphQL documents ----------------
const GET_WORKFLOW = `query ($id: uuid!) {
  workflows_by_pk(id: $id) {
    id org_id name
    organization { id calls_used calls_allowed }
    steps(order_by: { position: asc }) { id position type config }
  }
}`;

const GET_RUN = `query ($id: uuid!) {
  workflow_runs_by_pk(id: $id) {
    id workflow_id org_id status
    step_runs { id step_id position status output }
  }
}`;

const INSERT_RUN = `mutation ($obj: workflow_runs_insert_input!) {
  insert_workflow_runs_one(object: $obj) { id }
}`;

const INSERT_STEP_RUNS = `mutation ($objs: [step_runs_insert_input!]!) {
  insert_step_runs(objects: $objs) { returning { id step_id } }
}`;

const UPDATE_STEP_RUN = `mutation ($id: uuid!, $set: step_runs_set_input!) {
  update_step_runs_by_pk(pk_columns: { id: $id }, _set: $set) { id }
}`;

const UPDATE_RUN = `mutation ($id: uuid!, $set: workflow_runs_set_input!) {
  update_workflow_runs_by_pk(pk_columns: { id: $id }, _set: $set) { id }
}`;

const INC_QUOTA = `mutation ($id: uuid!) {
  update_organizations_by_pk(pk_columns: { id: $id }, _inc: { calls_used: 1 }) { calls_used }
}`;

const INSERT_DBWRITE = `mutation ($obj: db_write_results_insert_input!) {
  insert_db_write_results_one(object: $obj) { id }
}`;

const INSERT_NOTIFY = `mutation ($obj: notifications_insert_input!) {
  insert_notifications_one(object: $obj) { id }
}`;

// ---------------- helpers ----------------
function toText(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.text === 'string') return v.text;
  return JSON.stringify(v);
}

async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<{ result: T; attempt: number }> {
  let err: any;
  for (let a = 0; a <= retries; a++) {
    try {
      return { result: await fn(), attempt: a + 1 };
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

function evalCondition(cfg: any, prev: any): boolean {
  const text = toText(prev).toLowerCase();
  const val = String(cfg.value ?? '').toLowerCase();
  switch (cfg.op || 'contains') {
    case 'contains': return text.includes(val);
    case 'not_contains': return !text.includes(val);
    case 'eq': return text.trim() === val;
    case 'gt': return parseFloat(text) > parseFloat(val);
    case 'lt': return parseFloat(text) < parseFloat(val);
    case 'truthy': return text.trim().length > 0;
    default: return false;
  }
}

const setStep = (id: string, set: any) => admin(UPDATE_STEP_RUN, { id, set });
const setRun = (id: string, set: any) => admin(UPDATE_RUN, { id, set });

// Run a single step. Returns its output plus an optional control signal for branching.
async function executeStep(
  step: any, prev: any, wf: any, runId: string,
): Promise<{ output: any; control?: 'skip_next' | 'stop'; attempt: number }> {
  const cfg = step.config || {};
  switch (step.type) {
    case 'llm_call': {
      const prompt = String(cfg.prompt || 'Say hello.').replace('{{input}}', toText(prev));
      const { result, attempt } = await withRetry(() => llmCall(prompt, cfg.system), 1);
      return { output: { text: result }, attempt };
    }
    case 'http_request': {
      if (!cfg.url) throw new Error('http_request requires config.url');
      const { result, attempt } = await withRetry(async () => {
        const r = await fetch(cfg.url, {
          method: cfg.method || 'GET',
          headers: cfg.headers || {},
          body: cfg.body ? (typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body)) : undefined,
        });
        const raw = await r.text();
        let body: any; try { body = JSON.parse(raw); } catch { body = raw.slice(0, 2000); }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { status: r.status, body };
      }, 1);
      return { output: result, attempt };
    }
    case 'db_write': {
      const payload = cfg.data ?? prev ?? {};
      await admin(INSERT_DBWRITE, { obj: { run_id: runId, org_id: wf.org_id, payload } });
      return { output: { written: true }, attempt: 1 };
    }
    case 'notify': {
      const message = cfg.message ?? `Notify: ${toText(prev).slice(0, 200)}`;
      // Inserting here fires the `on_notification_insert` Hasura Event Trigger -> notify fn.
      await admin(INSERT_NOTIFY, { obj: { run_id: runId, org_id: wf.org_id, channel: cfg.channel || 'log', message } });
      return { output: { notified: true, message }, attempt: 1 };
    }
    case 'conditional_branch': {
      const cond = evalCondition(cfg, prev);
      const decision = cond ? (cfg.onTrue || 'continue') : (cfg.onFalse || 'skip_next');
      const control = decision === 'continue' ? undefined : (decision as 'skip_next' | 'stop');
      return { output: { condition: cond, decision, evaluated: toText(prev).slice(0, 200) }, control, attempt: 1 };
    }
    default:
      throw new Error('unknown step type: ' + step.type);
  }
}

// The shared loop. `startIndex` and `prev` let it start fresh or resume after a gate.
async function executeFrom(
  runId: string, wf: any, steps: any[], stepRunByStep: Record<string, string>,
  startIndex: number, prev: any,
): Promise<RunResult> {
  let skipNext = false;
  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    const srId = stepRunByStep[step.id];
    if (skipNext) { await setStep(srId, { status: 'skipped' }); skipNext = false; continue; }

    if (step.type === 'approval_gate') {
      await setStep(srId, { status: 'awaiting_approval', input: prev });
      await setRun(runId, { status: 'paused' });
      return { run_id: runId, status: 'paused', message: 'awaiting approval' };
    }

    await setStep(srId, { status: 'running', input: prev });
    try {
      const { output, control, attempt } = await executeStep(step, prev, wf, runId);
      await setStep(srId, { status: 'succeeded', output, attempt });
      prev = output;
      if (control === 'skip_next') skipNext = true;
      if (control === 'stop') break;
    } catch (e: any) {
      await setStep(srId, { status: 'failed', error: String(e?.message || e), attempt: 2 });
      await setRun(runId, { status: 'failed', finished_at: new Date().toISOString() });
      return { run_id: runId, status: 'failed', message: String(e?.message || e) };
    }
  }

  await setRun(runId, { status: 'succeeded', finished_at: new Date().toISOString() });
  await admin(INC_QUOTA, { id: wf.org_id }); // quota increments on completion
  return { run_id: runId, status: 'succeeded' };
}

// ---------------- public entry points ----------------

// Start a fresh run. Enforces caller role (unless system-triggered) and quota.
export async function runWorkflow(opts: { workflowId: string; ctx: Ctx }): Promise<RunResult> {
  const { workflows_by_pk: wf } = await admin<any>(GET_WORKFLOW, { id: opts.workflowId });
  if (!wf) return { status: 'error', message: 'workflow not found' };

  if (!opts.ctx.system) {
    const role = await memberRole(opts.ctx.userId!, wf.org_id);
    if (!role || !['owner', 'editor'].includes(role))
      return { status: 'forbidden', message: 'caller is not an owner/editor in this org' };
  }
  if (wf.organization.calls_used >= wf.organization.calls_allowed)
    return { status: 'quota_exceeded', message: 'organization quota exhausted' };
  if (!wf.steps.length) return { status: 'error', message: 'workflow has no steps' };

  const run = (await admin<any>(INSERT_RUN, {
    obj: {
      workflow_id: wf.id, org_id: wf.org_id, status: 'running',
      trigger_type: opts.ctx.triggerType,
      started_by: opts.ctx.system ? null : opts.ctx.userId,
    },
  })).insert_workflow_runs_one;

  const srRes = await admin<any>(INSERT_STEP_RUNS, {
    objs: wf.steps.map((s: any) => ({
      run_id: run.id, step_id: s.id, position: s.position, type: s.type, status: 'pending',
    })),
  });
  const stepRunByStep: Record<string, string> = {};
  for (const sr of srRes.insert_step_runs.returning) stepRunByStep[sr.step_id] = sr.id;

  return executeFrom(run.id, wf, wf.steps, stepRunByStep, 0, null);
}

// Resume a paused run after an approval gate at `gatePosition`.
export async function resumeWorkflow(runId: string, gatePosition: number): Promise<RunResult> {
  const { workflow_runs_by_pk: run } = await admin<any>(GET_RUN, { id: runId });
  if (!run) return { status: 'error', message: 'run not found' };
  const { workflows_by_pk: wf } = await admin<any>(GET_WORKFLOW, { id: run.workflow_id });
  const steps = wf.steps;

  const stepRunByStep: Record<string, string> = {};
  for (const sr of run.step_runs) stepRunByStep[sr.step_id] = sr.id;

  // Reconstruct the value downstream steps consume: output of the last succeeded step
  // before the gate.
  const before = run.step_runs
    .filter((sr: any) => sr.position < gatePosition && sr.status === 'succeeded')
    .sort((a: any, b: any) => b.position - a.position);
  const prev = before[0]?.output ?? null;

  const startIndex = steps.findIndex((s: any) => s.position > gatePosition);
  await setRun(runId, { status: 'running' });
  if (startIndex === -1) {
    // gate was the last step -> nothing left; complete.
    await setRun(runId, { status: 'succeeded', finished_at: new Date().toISOString() });
    await admin(INC_QUOTA, { id: wf.org_id });
    return { run_id: runId, status: 'succeeded' };
  }
  return executeFrom(runId, wf, steps, stepRunByStep, startIndex, prev);
}
