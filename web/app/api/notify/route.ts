// NOTIFY step, implemented as a Hasura Event Trigger (`on_notification_insert`).
// Fired whenever a `notify` step inserts into public.notifications. Delivery is stubbed
// (logged); if SLACK_WEBHOOK_URL is set and channel is "slack" it also posts to Slack.
import { verifyActionSecret } from '@/lib/server/db';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!verifyActionSecret(req)) return Response.json({ message: 'bad action secret' }, { status: 401 });
  const body: any = await req.json().catch(() => ({}));
  const row = body?.event?.data?.new;
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
  return Response.json({ delivered: true });
}
