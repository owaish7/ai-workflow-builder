// Hasura Action handler: triggerWorkflowRun(workflow_id).
// Verifies the shared secret, reads the caller from Hasura's session_variables,
// and runs the workflow (role + quota enforced inside runWorkflow).
import { verifyWebhookSecret } from './_lib/db';
import { runWorkflow } from './_lib/executor';

export default async function handler(req: any, res: any) {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ message: 'bad webhook secret' });

  const body = req.body || {};
  const workflowId = body.input?.workflow_id;
  const userId = body.session_variables?.['x-hasura-user-id'] || null;
  if (!workflowId) return res.status(400).json({ message: 'workflow_id required' });
  if (!userId) return res.status(400).json({ message: 'no authenticated user' });

  try {
    const result = await runWorkflow({ workflowId, ctx: { userId, triggerType: 'manual' } });
    if (['forbidden', 'quota_exceeded', 'error'].includes(result.status))
      return res.status(400).json({ message: result.message || result.status });
    return res.status(200).json(result);
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || e) });
  }
}
