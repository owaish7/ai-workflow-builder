'use client';

import { useMemo, useState } from 'react';
import { useQuery } from 'urql';
import { useUserData, useSignOut } from '@nhost/react';
import { MY_CONTEXT, ORG_USAGE } from '../lib/graphql';
import WorkflowList from './WorkflowList';

export default function Home() {
  const user = useUserData();
  const { signOut } = useSignOut();
  const [activeOrg, setActiveOrg] = useState<string>('');

  const [ctx] = useQuery({ query: MY_CONTEXT, variables: { me: user?.id }, pause: !user });
  const orgs = ctx.data?.organizations ?? [];
  const roleByOrg: Record<string, string> = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of ctx.data?.org_members ?? []) m[r.org_id] = r.role;
    return m;
  }, [ctx.data]);

  // default to first org once loaded
  const orgId = activeOrg || orgs[0]?.id || '';
  const role = roleByOrg[orgId] || 'viewer';

  const [usage, reUsage] = useQuery({ query: ORG_USAGE, variables: { org: orgId }, pause: !orgId });
  const u = usage.data?.org_usage?.[0];

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div className="row">
          <strong>AI Workflow Builder</strong>
          {orgs.length > 0 && (
            <select
              style={{ width: 'auto' }}
              value={orgId}
              onChange={(e) => setActiveOrg(e.target.value)}
            >
              {orgs.map((o: any) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
          {orgId && <span className="pill">role: {role}</span>}
        </div>
        <div className="row">
          <span className="muted small">{user?.email}</span>
          <button onClick={() => signOut()}>Sign out</button>
        </div>
      </div>

      {orgs.length === 0 && !ctx.fetching && (
        <div className="card">
          <p>You are not a member of any organization yet.</p>
          <p className="muted small">
            Run the seed (<code>scripts/seed.mjs</code>) after signing up your demo users, or ask an
            owner to add you via <code>org_members</code>.
          </p>
        </div>
      )}

      {orgId && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div className="muted small">Usage this period</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>
                  {u ? `${u.calls_used} / ${u.calls_allowed}` : '…'} <span className="muted small">calls</span>
                </div>
              </div>
              <div className="row" style={{ gap: 24 }}>
                <div><div className="muted small">Runs this month</div><div style={{ fontSize: 18 }}>{u?.runs_this_month ?? '…'}</div></div>
                <div><div className="muted small">Avg run</div><div style={{ fontSize: 18 }}>{u ? `${u.avg_run_seconds}s` : '…'}</div></div>
              </div>
            </div>
            {u && u.calls_used >= u.calls_allowed && (
              <p className="small" style={{ color: 'var(--red)' }}>Quota exhausted — new runs will be rejected.</p>
            )}
          </div>

          <WorkflowList orgId={orgId} role={role} onRan={() => reUsage({ requestPolicy: 'network-only' })} />
        </>
      )}
    </div>
  );
}
