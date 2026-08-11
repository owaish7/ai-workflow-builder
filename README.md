# AI Agent Workflow Builder — a mini n8n

Chain AI-agent steps into workflows, start them multiple ways, and gate every action
behind **two independent permission layers**. Built on **nhost (Postgres + Hasura +
Auth) + GraphQL + Next.js**.

- **Backend:** nhost Cloud — Hasura GraphQL over Postgres, nhost Auth (JWT).
- **Handlers:** the workflow executor, the two Hasura **Actions**, and the webhook /
  scheduled / db-event / notify triggers run as **Next.js serverless API routes on
  Vercel** (`web/app/api/*`), called by Hasura Actions and Event/Cron Triggers.
- **Frontend:** Next.js (App Router) on Vercel, `@nhost/react` for auth and `urql` +
  `graphql-ws` for live subscriptions.
- **LLM:** Groq (`llama-3.3-70b-versatile`), with a disclosed stubbed fallback if no key.

> **Live app:** https://ai-workflow-builder-two.vercel.app
> **Demo recording:** https://drive.google.com/file/d/1SNJl4spxmBTfGAmB2ZfEMwrO-7R8puFd/view?usp=sharing

> **Why handlers on Vercel, not nhost Functions?** nhost Functions deploy via nhost's
> Git integration, which re-validates the whole `nhost.toml` project config on every
> push — impossible to reproduce byte-perfectly without the nhost CLI (which needs
> Docker). Running the handlers as Vercel API routes keeps the whole system Docker-free
> and deterministic; they're serverless HTTP endpoints behind Hasura Actions/Triggers
> either way, so the architecture is identical.

---

## What's in the box

| Piece | Where |
|---|---|
| Schema (10 tables + `org_usage` view) | [`nhost/migrations/default/1723334400000_init/up.sql`](nhost/migrations/default/1723334400000_init/up.sql) |
| Hasura config applier (relationships, **both permission layers**, actions, cron + event triggers) | [`scripts/setup-hasura.mjs`](scripts/setup-hasura.mjs) |
| Reviewable Hasura metadata (YAML) | [`docs/hasura-metadata/`](docs/hasura-metadata/) |
| Workflow executor (pause/resume, retry, quota) | [`web/lib/server/executor.ts`](web/lib/server/executor.ts) |
| Actions: `triggerWorkflowRun`, `approveStep` | [`web/app/api/triggerWorkflowRun/route.ts`](web/app/api/triggerWorkflowRun/route.ts), [`web/app/api/approveStep/route.ts`](web/app/api/approveStep/route.ts) |
| Triggers: webhook / scheduled / db-event / notify | [`web/app/api/webhook/route.ts`](web/app/api/webhook/route.ts), [`web/app/api/scheduled/route.ts`](web/app/api/scheduled/route.ts), [`web/app/api/dbEvent/route.ts`](web/app/api/dbEvent/route.ts), [`web/app/api/notify/route.ts`](web/app/api/notify/route.ts) |
| Frontend | [`web/app`](web/app), [`web/components`](web/components) |
| Design write-up | [`WRITEUP.md`](WRITEUP.md) |

**Step types:** `llm_call`, `http_request`, `db_write`, `notify`, `conditional_branch`, `approval_gate`.
**Trigger types:** `manual`, `webhook`, `scheduled`, `db_event`.

---

## Setup

Docker-free throughout — schema and Hasura config are applied by two small Node scripts
that call Hasura's APIs directly.

### Prerequisites
- Node ≥ 20
- An [nhost.io](https://nhost.io) account (free), a free [Groq](https://console.groq.com) key, GitHub + Vercel accounts.

### 1. Create the nhost project
1. Create a project; note its **subdomain** and **region**.
2. **Settings → Sign-In Methods → Email and Password:** on, and **“Require email
   verification” OFF** (so demo users sign in immediately).
3. **Settings → Hasura:** copy the **admin secret**.
   *(No env vars are needed on nhost — the handlers live on Vercel.)*

### 2. Apply schema + Hasura config
```bash
cp .env.example .env
```
Fill `.env` with `NHOST_SUBDOMAIN`, `NHOST_REGION`, `NHOST_ADMIN_SECRET`, and a random
`ACTION_SECRET` (any long string). Leave `NHOST_FUNCTIONS_URL` blank for now, then:
```bash
npm run setup:db
```
This creates the tables/view. (We finish the Hasura wiring in step 4, once we know the
Vercel URL.)

### 3. Deploy the frontend + handlers to Vercel
1. Push this repo to GitHub, import it in Vercel, set **Root Directory = `web`**.
2. **Environment Variables** (Vercel → Project → Settings):
   - `NEXT_PUBLIC_NHOST_SUBDOMAIN`, `NEXT_PUBLIC_NHOST_REGION`
   - `NHOST_ADMIN_SECRET` (same admin secret)
   - `GROQ_API_KEY`
   - `ACTION_SECRET` (same value as in `.env`)
3. Deploy and copy the app URL, e.g. `https://your-app.vercel.app`.
4. Back in nhost → **Allowed Redirect URLs:** add the Vercel URL and `http://localhost:3000`.

### 4. Point Hasura at the deployed handlers
Set `NHOST_FUNCTIONS_URL=https://your-app.vercel.app/api` in `.env`, then:
```bash
npm run setup:hasura
```
Tracks tables, wires relationships, installs **both permission layers**, and registers the
two Actions + cron + event triggers pointing at your Vercel `/api/*` routes. Idempotent.

### 5. Create demo users + seed the two orgs
1. Open the Vercel app → **Sign up**: `a.owner@example.com`, `a.editor@example.com`,
   `a.viewer@example.com`, `b.owner@example.com` (any password ≥ 6 chars).
2. Link them to orgs with roles:
   ```bash
   npm run seed
   ```
   Creates **Org A** / **Org B** and assigns owner/editor/viewer. Re-run any time.

---

## Final Task walkthrough

1. **Two orgs, real roles.** After seeding, Org A has owner/editor/viewer; Org B has its own owner.
2. **Build the workflow (Org A owner).** Sign in as `a.owner@…`, pick **Org A**, click
   **Create demo workflow** → `llm_call → conditional_branch → http_request → approval_gate
   → notify`, with **manual** + **webhook** triggers.
3. **Start it two ways.**
   - **Manual:** open the workflow → **▶ Run (manual)**.
   - **Webhook:** copy the token on the webhook trigger and POST:
     ```bash
     curl -X POST https://your-app.vercel.app/api/webhook \
       -H 'content-type: application/json' -d '{"token":"<paste-token>"}'
     ```
   - (Also **Run via db_event trigger** — inserts into the watched table so the Hasura
     Event Trigger starts the run.)
4. **Pause & approve.** The run pauses at `approval_gate`. **Approve →** shows only for an
   Org A owner/editor; a viewer sees “awaiting owner/editor”. Approving resumes the run.
5. **Live status.** Steps flip `pending → running → succeeded` (and `awaiting_approval` /
   `skipped`) with **no refresh**, over a GraphQL subscription.
6. **Cross-org isolation.** Sign in as `b.owner@…`, pick **Org B**. Org A’s workflows are
   invisible; pasting an Org A workflow ID into **“Trigger by ID”** is rejected. Direct-ID
   guessing fails because every Hasura permission is scoped through `org_members`.

Extra checks: point an `http_request` at a bad URL to see the **retry** (`attempt 2`) then
`failed`; watch `calls_used` climb in the quota card and block runs at the limit.

---

## The two permission layers (full detail in [WRITEUP.md](WRITEUP.md))

- **Layer 1 — org + role scoping.** One Hasura role, `user`. Every table permission is
  filtered through the `org_members` relationship on `X-Hasura-User-Id`, with the required
  role inside the filter (`role: {_in: [...]}`). Cross-org isolation and ID-guess resistance
  are automatic.
- **Layer 2 — step-level gating.** (a) *Authoring:* Hasura insert **checks** make
  `db_write`/`notify` steps and `webhook` triggers **owner-only**. (b) *Execution:* the
  `approveStep` handler re-checks the approver’s role before resuming — a mid-execution
  decision a row permission can’t express.

---

## Notes
- **Security:** the Vercel Action/trigger routes require the `x-action-secret` header
  (shared `ACTION_SECRET`) so they can’t be driven with a forged `session_variables` body.
  The webhook route is public but token-gated.
- **Stubbed LLM:** if `GROQ_API_KEY` is unset, `llm_call` returns a stubbed string after an
  ~800 ms disclosed delay ([`web/lib/server/groq.ts`](web/lib/server/groq.ts)).
- **notify delivery** is logged; set `SLACK_WEBHOOK_URL` and `channel:"slack"` to post to Slack.
- **Scheduled trigger** fires per-workflow at most every `intervalMinutes` (default 60; demo
  uses 1) via a Hasura cron trigger hitting `/api/scheduled` each minute.
- If you connected the repo to nhost's Git deploy earlier, you can **disconnect it** — it
  isn't used; schema + Hasura config come from the scripts.
