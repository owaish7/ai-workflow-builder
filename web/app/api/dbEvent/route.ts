// DATABASE-EVENT trigger. Fired by the Hasura Event Trigger `on_event_source_insert`
// whenever a row is inserted into public.event_source. Auto-starts the linked workflow.
import { verifyActionSecret } from '@/lib/server/db';
import { runWorkflow } from '@/lib/server/executor';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyActionSecret(req)) return Response.json({ message: 'bad action secret' }, { status: 401 });
  const body: any = await req.json().catch(() => ({}));
  const row = body?.event?.data?.new;
  if (!row?.workflow_id) return Response.json({ message: 'no workflow_id in event row' }, { status: 400 });

  try {
    const result = await runWorkflow({ workflowId: row.workflow_id, ctx: { system: true, triggerType: 'db_event' } });
    return Response.json(result);
  } catch (e: any) {
    return Response.json({ message: String(e?.message || e) }, { status: 500 });
  }
}
