// Hasura Action handler: triggerWorkflowRun(workflow_id).
import { verifyActionSecret } from '@/lib/server/db';
import { runWorkflow } from '@/lib/server/executor';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyActionSecret(req)) return Response.json({ message: 'bad action secret' }, { status: 401 });
  const body: any = await req.json().catch(() => ({}));
  const workflowId = body.input?.workflow_id;
  const userId = body.session_variables?.['x-hasura-user-id'] || null;
  if (!workflowId) return Response.json({ message: 'workflow_id required' }, { status: 400 });
  if (!userId) return Response.json({ message: 'no authenticated user' }, { status: 400 });

  try {
    const result = await runWorkflow({ workflowId, ctx: { userId, triggerType: 'manual' } });
    if (['forbidden', 'quota_exceeded', 'error'].includes(result.status))
      return Response.json({ message: result.message || result.status }, { status: 400 });
    return Response.json(result);
  } catch (e: any) {
    return Response.json({ message: String(e?.message || e) }, { status: 500 });
  }
}
