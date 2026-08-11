// NOTIFY step, implemented as a Hasura Event Trigger (`on_notification_insert`).
// Fired whenever a `notify` step inserts into public.notifications. Delivery is stubbed
// (logged); if SLACK_WEBHOOK_URL is set it will also post to Slack — the wiring is real.
import { verifyWebhookSecret } from './_lib/db';

export default async function handler(req: any, res: any) {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ message: 'bad webhook secret' });

  const row = req.body?.event?.data?.new;
  const message = row?.message ?? '(no message)';
  const channel = row?.channel ?? 'log';

  console.log(`NOTIFY [${channel}] org=${row?.org_id} run=${row?.run_id}: ${message}`);

  const slack = process.env.SLACK_WEBHOOK_URL;
  if (slack && channel === 'slack') {
    try {
      await fetch(slack, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
    } catch (e) {
      console.error('slack post failed', e);
    }
  }
  return res.status(200).json({ delivered: true });
}
