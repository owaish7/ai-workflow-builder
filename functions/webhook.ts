// Public inbound WEBHOOK endpoint. External systems POST here with a per-trigger token
// to start a run without any UI. The token (stored in the webhook trigger's config)
// is the auth; the run executes as a pre-authorized system context (quota still applies).
//   POST /webhook   body: { "token": "..." }   (or ?token= / x-webhook-token header)
import { admin } from './_lib/db';
import { runWorkflow } from './_lib/executor';

const FIND_TRIGGER = `query ($c: jsonb!) {
  workflow_triggers(where: { type: { _eq: "webhook" }, config: { _contains: $c } }) {
    workflow_id
  }
}`;

export default async function handler(req: any, res: any) {
  const token = req.body?.token || req.query?.token || req.headers['x-webhook-token'];
  if (!token) return res.status(400).json({ message: 'token required' });

  try {
    const data = await admin<any>(FIND_TRIGGER, { c: { token } });
    const trigger = data.workflow_triggers[0];
    if (!trigger) return res.status(404).json({ message: 'no webhook trigger matches this token' });

    const result = await runWorkflow({
      workflowId: trigger.workflow_id,
      ctx: { system: true, triggerType: 'webhook' },
    });
    return res.status(200).json(result);
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || e) });
  }
}
