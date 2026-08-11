'use client';

import { useState } from 'react';
import { useMutation, useQuery } from 'urql';
import {
  ORG_WORKFLOWS, CREATE_WORKFLOW, CREATE_WORKFLOW_FULL, TRIGGER_RUN,
} from '../lib/graphql';
import WorkflowPanel from './WorkflowPanel';

function StatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="muted small">never run</span>;
  return <span className={`badge b-${status}`}>{status}</span>;
}

export default function WorkflowList({ orgId, role, onRan }: { orgId: string; role: string; onRan: () => void }) {
  const [wf, refetch] = useQuery({ query: ORG_WORKFLOWS, variables: { org: orgId } });
  const [, createWorkflow] = useMutation(CREATE_WORKFLOW);
  const [, createFull] = useMutation(CREATE_WORKFLOW_FULL);
  const [, triggerRun] = useMutation(TRIGGER_RUN);

  const [name, setName] = useState('');
  const [openId, setOpenId] = useState<string>('');
  const [probeId, setProbeId] = useState('');
  const [probeMsg, setProbeMsg] = useState('');

  const canEdit = role === 'owner' || role === 'editor';
  const isOwner = role === 'owner';
  const reload = () => refetch({ requestPolicy: 'network-only' });

  async function create() {
    if (!name.trim()) return;
    const r = await createWorkflow({ org: orgId, name: name.trim() });
    if (r.error) return alert(r.error.message);
    setName('');
    reload();
  }

  async function createDemo() {
    const obj = {
      org_id: orgId,
      name: 'Support Triage (demo)',
      steps: {
        data: [
          { position: 1, type: 'llm_call', config: { system: 'You are a strict classifier. Reply with only one word.', prompt: 'Classify the sentiment of this message as POSITIVE or NEGATIVE:\n\n"This product is amazing, best purchase I have ever made!"' } },
          { position: 2, type: 'conditional_branch', config: { op: 'contains', value: 'positive', onTrue: 'continue', onFalse: 'skip_next' } },
          { position: 3, type: 'http_request', config: { url: 'https://httpbin.org/post', method: 'POST', body: { note: 'positive-path reached' } } },
          { position: 4, type: 'approval_gate', config: {} },
          { position: 5, type: 'notify', config: { message: 'Support triage finished after approval.' } },
        ],
      },
      triggers: {
        data: [
          { type: 'manual', config: {} },
          { type: 'webhook', config: { token: crypto.randomUUID() } },
        ],
      },
    };
    const r = await createFull({ obj });
    if (r.error) return alert(r.error.message);
    reload();
  }

  async function probe() {
    setProbeMsg('running…');
    const r = await triggerRun({ workflow_id: probeId.trim() });
    if (r.error) setProbeMsg('Rejected: ' + r.error.message);
    else setProbeMsg('Result: ' + JSON.stringify(r.data.triggerWorkflowRun));
    reload();
  }

  const workflows = wf.data?.workflows ?? [];

  return (
    <div className="grid">
      {canEdit && (
        <div className="card">
          <div className="row">
            <input placeholder="New workflow name" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="primary" onClick={create}>Create</button>
            <button onClick={createDemo} disabled={!isOwner} title={isOwner ? '' : 'owner only (adds notify + webhook)'}>
              Create demo workflow
            </button>
          </div>
        </div>
      )}

      {workflows.length === 0 && !wf.fetching && <p className="muted">No workflows in this org yet.</p>}

      {workflows.map((w: any) => (
        <div key={w.id} className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{w.name}</div>
              <div className="muted small">
                {w.steps.length} steps · triggers: {w.triggers.map((t: any) => t.type).join(', ') || 'none'} ·{' '}
                latest: <StatusBadge status={w.runs[0]?.status} />
              </div>
            </div>
            <button onClick={() => setOpenId(openId === w.id ? '' : w.id)}>
              {openId === w.id ? 'Close' : 'Open'}
            </button>
          </div>
          {openId === w.id && (
            <WorkflowPanel
              workflow={w}
              role={role}
              orgId={orgId}
              onChanged={reload}
              onRan={() => { reload(); onRan(); }}
            />
          )}
        </div>
      ))}

      <div className="card">
        <div className="muted small" style={{ marginBottom: 6 }}>
          Cross-org check — try to trigger a workflow by pasting its ID (e.g. an Org A workflow while
          signed in as Org B). The Action rejects it.
        </div>
        <div className="row">
          <input placeholder="workflow_id to probe" value={probeId} onChange={(e) => setProbeId(e.target.value)} />
          <button onClick={probe} disabled={!probeId.trim()}>Trigger by ID</button>
        </div>
        {probeMsg && <p className="small" style={{ marginTop: 6 }}>{probeMsg}</p>}
      </div>
    </div>
  );
}
