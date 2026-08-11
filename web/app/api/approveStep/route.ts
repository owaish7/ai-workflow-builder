// Hasura Action handler: approveStep(step_run_id).
// Layer 2b: the approver's role is checked HERE (a mid-execution decision a row
// permission can't express) before the paused run is resumed.
import { admin, memberRole, verifyActionSecret } from '@/lib/server/db';
import { resumeWorkflow } from '@/lib/server/executor';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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

export async function POST(req: Request) {
  if (!verifyActionSecret(req)) return Response.json({ message: 'bad action secret' }, { status: 401 });
  const body: any = await req.json().catch(() => ({}));
  const stepRunId = body.input?.step_run_id;
  const userId = body.session_variables?.['x-hasura-user-id'] || null;
  if (!stepRunId) return Response.json({ message: 'step_run_id required' }, { status: 400 });
  if (!userId) return Response.json({ message: 'no authenticated user' }, { status: 400 });

  try {
    const { step_runs_by_pk: sr } = await admin<any>(GET_STEP_RUN, { id: stepRunId });
    if (!sr) return Response.json({ message: 'step run not found' }, { status: 400 });
    if (sr.type !== 'approval_gate' || sr.status !== 'awaiting_approval')
      return Response.json({ message: 'step is not awaiting approval' }, { status: 400 });

    const role = await memberRole(userId, sr.run.org_id);
    if (!role || !['owner', 'editor'].includes(role))
      return Response.json({ message: 'only an owner/editor in this org can approve' }, { status: 400 });

    await admin(APPROVE, { id: stepRunId, uid: userId, at: new Date().toISOString() });
    const result = await resumeWorkflow(sr.run.id, sr.position);
    return Response.json({ step_run_id: stepRunId, status: result.status, message: result.message });
  } catch (e: any) {
    return Response.json({ message: String(e?.message || e) }, { status: 500 });
  }
}
