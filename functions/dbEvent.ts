// DATABASE-EVENT trigger. Fired by the Hasura Event Trigger `on_event_source_insert`
// whenever a row is inserted into public.event_source. Auto-starts the linked workflow
// with no button click.
import { verifyWebhookSecret } from './_lib/db';
import { runWorkflow } from './_lib/executor';

export default async function handler(req: any, res: any) {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ message: 'bad webhook secret' });

  const row = req.body?.event?.data?.new;
  if (!row?.workflow_id) return res.status(400).json({ message: 'no workflow_id in event row' });

  try {
    const result = await runWorkflow({
      workflowId: row.workflow_id,
      ctx: { system: true, triggerType: 'db_event' },
    });
    return res.status(200).json(result);
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || e) });
  }
}
