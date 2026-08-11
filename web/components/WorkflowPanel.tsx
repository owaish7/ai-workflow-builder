'use client';

import { useState } from 'react';
import { useClient, useMutation, useSubscription } from 'urql';
import {
  ADD_STEP, DELETE_STEP, UPDATE_STEP_POSITION, ADD_TRIGGER, DELETE_TRIGGER,
  TRIGGER_RUN, APPROVE_STEP, FIRE_DB_EVENT, RUN_PROGRESS, LATEST_RUN,
} from '../lib/graphql';

const STEP_TYPES = ['llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate'];
const OWNER_ONLY_STEPS = ['db_write', 'notify'];
const TRIGGER_TYPES = ['manual', 'webhook', 'scheduled', 'db_event'];
const OWNER_ONLY_TRIGGERS = ['webhook'];

const PRESET: Record<string, any> = {
  llm_call: { system: 'You are concise.', prompt: 'Summarize this: {{input}}' },
  http_request: { url: 'https://httpbin.org/get', method: 'GET' },
  db_write: {},
  notify: { channel: 'log', message: 'Step reached' },
  conditional_branch: { op: 'contains', value: 'positive', onTrue: 'continue', onFalse: 'skip_next' },
  approval_gate: {},
};

const SUB = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || '';
const REG = process.env.NEXT_PUBLIC_NHOST_REGION || '';
const WEBHOOK_URL = `https://${SUB}.functions.${REG}.nhost.run/webhook`;

export default function WorkflowPanel({ workflow, role, orgId, onChanged, onRan }: any) {
  const client = useClient();
  const [, addStep] = useMutation(ADD_STEP);
  const [, delStep] = useMutation(DELETE_STEP);
  const [, moveStep] = useMutation(UPDATE_STEP_POSITION);
  const [, addTrigger] = useMutation(ADD_TRIGGER);
  const [, delTrigger] = useMutation(DELETE_TRIGGER);
  const [, triggerRun] = useMutation(TRIGGER_RUN);
  const [, approve] = useMutation(APPROVE_STEP);
  const [, fireEvent] = useMutation(FIRE_DB_EVENT);

  const canEdit = role === 'owner' || role === 'editor';
  const isOwner = role === 'owner';

  const [newType, setNewType] = useState('llm_call');
  const [cfg, setCfg] = useState(JSON.stringify(PRESET.llm_call, null, 2));
  const [newTrigger, setNewTrigger] = useState('manual');
  const [runId, setRunId] = useState('');
  const [msg, setMsg] = useState('');

  const steps = [...(workflow.steps || [])].sort((a, b) => a.position - b.position);

  function pickType(t: string) { setNewType(t); setCfg(JSON.stringify(PRESET[t] || {}, null, 2)); }

  async function onAddStep() {
    let config: any = {};
    try { config = cfg.trim() ? JSON.parse(cfg) : {}; } catch { return alert('Config must be valid JSON'); }
    const position = (steps[steps.length - 1]?.position || 0) + 1;
    const r = await addStep({ obj: { workflow_id: workflow.id, position, type: newType, config } });
    if (r.error) return alert(r.error.message);
    onChanged();
  }

  async function swap(i: number, j: number) {
    if (j < 0 || j >= steps.length) return;
    const a = steps[i], b = steps[j];
    await moveStep({ id: a.id, position: b.position });
    await moveStep({ id: b.id, position: a.position });
    onChanged();
  }

  async function onAddTrigger() {
    const config = newTrigger === 'webhook' ? { token: crypto.randomUUID() }
      : newTrigger === 'scheduled' ? { intervalMinutes: 1, enabled: true } : {};
    const r = await addTrigger({ obj: { workflow_id: workflow.id, type: newTrigger, config } });
    if (r.error) return alert(r.error.message);
    onChanged();
  }

  async function attachLatestRun() {
    // find the run the auto-trigger just created and attach the live view
    for (let i = 0; i < 8; i++) {
      const r = await client.query(LATEST_RUN, { workflow: workflow.id }, { requestPolicy: 'network-only' }).toPromise();
      const id = r.data?.workflow_runs?.[0]?.id;
      if (id) { setRunId(id); return; }
      await new Promise((res) => setTimeout(res, 700));
    }
  }

  async function run() {
    setMsg('starting…');
    const r = await triggerRun({ workflow_id: workflow.id });
    if (r.error) { setMsg('Error: ' + r.error.message); return; }
    const out = r.data.triggerWorkflowRun;
    setRunId(out.run_id);
    setMsg(`run ${out.status}`);
    onRan();
  }

  async function runViaEvent() {
    setMsg('firing db_event…');
    const r = await fireEvent({ org: orgId, workflow: workflow.id });
    if (r.error) { setMsg('Error: ' + r.error.message); return; }
    setMsg('db_event fired — attaching run…');
    await attachLatestRun();
    onRan();
  }

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      {/* ---------- steps ---------- */}
      <h3>Steps</h3>
      {steps.length === 0 && <p className="muted small">No steps yet.</p>}
      {steps.map((s, i) => (
        <div key={s.id} className="stepline">
          <span className="pill">{s.position}</span>
          <strong style={{ minWidth: 150 }}>{s.type}</strong>
          <code style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {JSON.stringify(s.config)}
          </code>
          {canEdit && (
            <>
              <button onClick={() => swap(i, i - 1)} disabled={i === 0}>↑</button>
              <button onClick={() => swap(i, i + 1)} disabled={i === steps.length - 1}>↓</button>
              <button className="danger" onClick={async () => { await delStep({ id: s.id }); onChanged(); }}>✕</button>
            </>
          )}
        </div>
      ))}

      {canEdit && (
        <div className="card" style={{ marginTop: 12, background: 'var(--panel2)' }}>
          <div className="row">
            <div>
              <label>Step type</label>
              <select style={{ width: 200 }} value={newType} onChange={(e) => pickType(e.target.value)}>
                {STEP_TYPES.map((t) => {
                  const locked = OWNER_ONLY_STEPS.includes(t) && !isOwner;
                  return <option key={t} value={t} disabled={locked}>{t}{locked ? ' (owner only)' : ''}</option>;
                })}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label>Config (JSON)</label>
              <textarea rows={4} value={cfg} onChange={(e) => setCfg(e.target.value)} />
            </div>
          </div>
          <button className="primary" style={{ marginTop: 8 }} onClick={onAddStep}>Add step</button>
          <p className="muted small">
            Layer 2a: <code>db_write</code> / <code>notify</code> steps and <code>webhook</code> triggers are
            owner-only — the server rejects them for editors even if forced.
          </p>
        </div>
      )}

      {/* ---------- triggers ---------- */}
      <h3 style={{ marginTop: 16 }}>Triggers</h3>
      {(workflow.triggers || []).map((t: any) => (
        <div key={t.id} className="stepline">
          <span className="pill">{t.type}</span>
          {t.type === 'webhook' && <code style={{ flex: 1 }}>POST {WEBHOOK_URL} · token {t.config?.token}</code>}
          {t.type === 'scheduled' && <span className="muted small">every {t.config?.intervalMinutes ?? 60} min</span>}
          <div style={{ flex: 1 }} />
          {canEdit && <button className="danger" onClick={async () => { await delTrigger({ id: t.id }); onChanged(); }}>✕</button>}
        </div>
      ))}
      {canEdit && (
        <div className="row" style={{ marginTop: 8 }}>
          <select style={{ width: 200 }} value={newTrigger} onChange={(e) => setNewTrigger(e.target.value)}>
            {TRIGGER_TYPES.map((t) => {
              const locked = OWNER_ONLY_TRIGGERS.includes(t) && !isOwner;
              return <option key={t} value={t} disabled={locked}>{t}{locked ? ' (owner only)' : ''}</option>;
            })}
          </select>
          <button onClick={onAddTrigger}>Add trigger</button>
        </div>
      )}

      {/* ---------- run controls ---------- */}
      <h3 style={{ marginTop: 16 }}>Run</h3>
      <div className="row">
        {canEdit ? (
          <>
            <button className="primary" onClick={run}>▶ Run (manual)</button>
            <button onClick={runViaEvent}>Run via db_event trigger</button>
          </>
        ) : (
          <span className="muted small">Viewers cannot trigger runs.</span>
        )}
        {msg && <span className="small muted">{msg}</span>}
      </div>

      {runId && <RunView runId={runId} role={role} onApprove={approve} />}
    </div>
  );
}

function RunView({ runId, role, onApprove }: { runId: string; role: string; onApprove: any }) {
  const [res] = useSubscription({ query: RUN_PROGRESS, variables: { runId } });
  const run = res.data?.workflow_runs_by_pk;
  const canApprove = role === 'owner' || role === 'editor';

  if (!run) return <p className="muted small" style={{ marginTop: 10 }}>Connecting to live run…</p>;

  return (
    <div className="card" style={{ marginTop: 12, background: 'var(--panel2)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>Run <code>{run.id.slice(0, 8)}</code> · trigger: {run.trigger_type}</div>
        <span className={`badge b-${run.status}`}>{run.status}</span>
      </div>
      <div style={{ marginTop: 8 }}>
        {run.step_runs.map((sr: any) => (
          <div key={sr.id} className="stepline">
            <span className="pill">{sr.position}</span>
            <strong style={{ minWidth: 150 }}>{sr.type}</strong>
            <span className={`badge b-${sr.status}`}>{sr.status.replace('_', ' ')}</span>
            {sr.attempt > 1 && <span className="muted small">attempt {sr.attempt}</span>}
            <div style={{ flex: 1 }} />
            {sr.status === 'awaiting_approval' && canApprove && (
              <button
                className="primary"
                onClick={async () => {
                  const r = await onApprove({ step_run_id: sr.id });
                  if (r.error) alert(r.error.message);
                }}
              >
                Approve →
              </button>
            )}
            {sr.status === 'awaiting_approval' && !canApprove && <span className="muted small">awaiting owner/editor</span>}
            {sr.error && <span className="small" style={{ color: 'var(--red)' }}>{sr.error}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
