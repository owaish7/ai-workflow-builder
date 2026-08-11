// Public inbound WEBHOOK endpoint. External systems POST here with a per-trigger token
// to start a run without any UI. The token is the auth; the run executes as a
// pre-authorized system context (quota still applies).
//   POST /api/webhook   body: { "token": "..." }   (or ?token= / x-webhook-token header)
import { admin } from '@/lib/server/db';
import { runWorkflow } from '@/lib/server/executor';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const FIND_TRIGGER = `query ($c: jsonb!) {
  workflow_triggers(where: { type: { _eq: "webhook" }, config: { _contains: $c } }) {
    workflow_id
  }
}`;

export async function POST(req: Request) {
  const body: any = await req.json().catch(() => ({}));
  const url = new URL(req.url);
  const token = body.token || url.searchParams.get('token') || req.headers.get('x-webhook-token');
  if (!token) return Response.json({ message: 'token required' }, { status: 400 });

  try {
    const data = await admin<any>(FIND_TRIGGER, { c: { token } });
    const trigger = data.workflow_triggers[0];
    if (!trigger) return Response.json({ message: 'no webhook trigger matches this token' }, { status: 404 });

    const result = await runWorkflow({ workflowId: trigger.workflow_id, ctx: { system: true, triggerType: 'webhook' } });
    return Response.json(result);
  } catch (e: any) {
    return Response.json({ message: String(e?.message || e) }, { status: 500 });
  }
}
