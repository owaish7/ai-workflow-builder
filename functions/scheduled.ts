// SCHEDULED trigger. Hit every minute by the Hasura cron trigger `scheduled_workflow_tick`.
// Fires any `scheduled` trigger whose interval has elapsed since its last scheduled run.
// Trigger config: { intervalMinutes?: number = 60, enabled?: boolean = true }.
import { admin, verifyWebhookSecret } from './_lib/db';
import { runWorkflow } from './_lib/executor';

const LIST = `query {
  workflow_triggers(where: { type: { _eq: "scheduled" } }) {
    workflow_id config
  }
}`;

const LAST_RUN = `query ($w: uuid!) {
  workflow_runs(
    where: { workflow_id: { _eq: $w }, trigger_type: { _eq: "scheduled" } },
    order_by: { started_at: desc }, limit: 1
  ) { started_at }
}`;

export default async function handler(req: any, res: any) {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ message: 'bad webhook secret' });

  const fired: string[] = [];
  try {
    const { workflow_triggers: triggers } = await admin<any>(LIST);
    for (const t of triggers) {
      const cfg = t.config || {};
      if (cfg.enabled === false) continue;
      const intervalMs = (Number(cfg.intervalMinutes) || 60) * 60_000;
      const { workflow_runs: last } = await admin<any>(LAST_RUN, { w: t.workflow_id });
      const lastAt = last[0] ? new Date(last[0].started_at).getTime() : 0;
      if (Date.now() - lastAt >= intervalMs) {
        await runWorkflow({ workflowId: t.workflow_id, ctx: { system: true, triggerType: 'scheduled' } });
        fired.push(t.workflow_id);
      }
    }
    return res.status(200).json({ fired });
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || e) });
  }
}
