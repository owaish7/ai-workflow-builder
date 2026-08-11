// Hasura Action handler: approveStep(step_run_id).
// Layer 2b step-level gating: the approver's role is checked HERE (a mid-execution
// decision that a row permission can't express) before the paused run is resumed.
import { admin, memberRole, verifyWebhookSecret } from './_lib/db';
import { resumeWorkflow } from './_lib/executor';

const GET_STEP_RUN = `query ($id: uuid!) {
  step_runs_by_pk(id: $id) {
    id status position type
    run { id org_id status }
  }
}`;

const APPROVE = `mutation ($id: uuid!, $uid: uuid!, $at: timestamptz!) {
  update_step_runs_by_pk(
    pk_columns: { id: $id },
    _set: { status: "succeeded", approved_by: $uid, approved_at: $at }
  ) { id }
}`;

export default async function handler(req: any, res: any) {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ message: 'bad webhook secret' });

  const body = req.body || {};
  const stepRunId = body.input?.step_run_id;
  const userId = body.session_variables?.['x-hasura-user-id'] || null;
  if (!stepRunId) return res.status(400).json({ message: 'step_run_id required' });
  if (!userId) return res.status(400).json({ message: 'no authenticated user' });

  try {
    const { step_runs_by_pk: sr } = await admin<any>(GET_STEP_RUN, { id: stepRunId });
    if (!sr) return res.status(400).json({ message: 'step run not found' });
    if (sr.type !== 'approval_gate' || sr.status !== 'awaiting_approval')
      return res.status(400).json({ message: 'step is not awaiting approval' });

    // The role check that can only live in the handler:
    const role = await memberRole(userId, sr.run.org_id);
    if (!role || !['owner', 'editor'].includes(role))
      return res.status(400).json({ message: 'only an owner/editor in this org can approve' });

    await admin(APPROVE, { id: stepRunId, uid: userId, at: new Date().toISOString() });
    const result = await resumeWorkflow(sr.run.id, sr.position);
    return res.status(200).json({ step_run_id: stepRunId, status: result.status, message: result.message });
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || e) });
  }
}
