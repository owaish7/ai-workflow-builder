# AI Agent Workflow Builder — a mini n8n

Chain AI-agent steps into workflows, start them multiple ways, and gate every action
behind **two independent permission layers**. Built on **nhost (Postgres + Hasura +
Auth + Functions) + GraphQL + Next.js**.

- **Backend:** nhost Cloud — Hasura GraphQL over Postgres, serverless Functions for the
  Action handlers and triggers.
- **Frontend:** Next.js (App Router) on Vercel, `@nhost/react` for auth and `urql` +
  `graphql-ws` for live subscriptions.
- **LLM:** Groq (`llama-3.3-70b-versatile`), with a disclosed stubbed fallback if no key.

> **Live app:** _add your Vercel URL here_
> **Demo recording:** _add your recording link here_

---

## What's in the box

| Piece | Where |
|---|---|
| Schema (10 tables + `org_usage` view) | [`nhost/migrations/default/1723334400000_init/up.sql`](nhost/migrations/default/1723334400000_init/up.sql) |
| Hasura config applier (relationships, **both permission layers**, actions, cron + event triggers) | [`scripts/setup-hasura.mjs`](scripts/setup-hasura.mjs) |
| Reviewable Hasura metadata (YAML) | [`docs/hasura-metadata/`](docs/hasura-metadata/) |
| Workflow executor (pause/resume, retry, quota) | [`functions/_lib/executor.ts`](functions/_lib/executor.ts) |
| Actions: `triggerWorkflowRun`, `approveStep` | [`functions/triggerWorkflowRun.ts`](functions/triggerWorkflowRun.ts), [`functions/approveStep.ts`](functions/approveStep.ts) |
| Triggers: webhook / scheduled / db-event / notify | [`functions/webhook.ts`](functions/webhook.ts), [`functions/scheduled.ts`](functions/scheduled.ts), [`functions/dbEvent.ts`](functions/dbEvent.ts), [`functions/notify.ts`](functions/notify.ts) |
| Frontend | [`web/`](web/) |
| Design write-up | [`WRITEUP.md`](WRITEUP.md) |

**Step types:** `llm_call`, `http_request`, `db_write`, `notify`, `conditional_branch`, `approval_gate`.
**Trigger types:** `manual`, `webhook`, `scheduled`, `db_event`.

---

## Setup

Everything below is **Docker-free** — the schema and Hasura config are applied by two
small Node scripts that call Hasura's APIs directly.

### Prerequisites
- Node ≥ 20
- An [nhost.io](https://nhost.io) account (free tier)
- A free [Groq](https://console.groq.com) API key
- GitHub + Vercel accounts

### 1. Create the nhost project
1. Create a project. Note its **subdomain** and **region**.
2. **Settings → Sign-in methods → Email and Password:** enabled, and turn **“Require
   email verification” OFF** (so demo users can sign in immediately).
3. **Settings → Environment Variables** — add (nhost forbids custom names starting with
   `NHOST_`/`HASURA_`, so the GraphQL URL uses a neutral name the functions read):
   - `GROQ_API_KEY` = your Groq key
   - `GRAPHQL_ENDPOINT` = `https://<subdomain>.hasura.<region>.nhost.run/v1/graphql`
4. **Settings → Hasura:** copy the **admin secret**.

### 2. Apply schema + Hasura config
```bash
cp .env.example .env      # fill NHOST_SUBDOMAIN, NHOST_REGION, NHOST_ADMIN_SECRET
npm run setup             # runs setup-db.mjs then setup-hasura.mjs
```
`setup:db` creates the tables/view via Hasura `run_sql`; `setup:hasura` tracks tables,
wires relationships, installs **both permission layers**, and registers the actions,
cron trigger and event triggers. Both are idempotent — safe to re-run.

### 3. Deploy the serverless functions
The scripts can’t upload functions, so deploy them via nhost’s Git integration:
1. Push this repo to GitHub.
2. nhost dashboard → **Deployments / Git** → connect the repo (base directory = repo
   root). nhost deploys everything in `functions/` and applies `nhost/migrations`.
   (There is intentionally **no `nhost/metadata`** in the repo, so this deploy can’t
   overwrite nhost’s own auth/storage config — Hasura config comes from step 2.)

### 4. Create demo users + seed the two orgs
1. Run the app (`cd web && cp .env.local.example .env.local && npm install && npm run dev`)
   or use your Vercel deployment, and **sign up** four users:
   `a.owner@example.com`, `a.editor@example.com`, `a.viewer@example.com`, `b.owner@example.com`
   (any password ≥ 6 chars).
2. Link them to orgs with roles:
   ```bash
   npm run seed
   ```
   Creates **Org A** and **Org B** and assigns owner/editor/viewer. Re-run any time.

### 5. Deploy the frontend (Vercel)
1. Import the repo, set **Root Directory = `web`**.
2. Env vars: `NEXT_PUBLIC_NHOST_SUBDOMAIN`, `NEXT_PUBLIC_NHOST_REGION`.
3. Deploy, then add the Vercel URL to nhost’s allowed redirect URLs.

---

## Final Task walkthrough

1. **Two orgs, real roles.** After seeding, Org A has owner/editor/viewer and Org B has
   its own owner.
2. **Build the workflow (Org A owner).** Open the app as `a.owner@…`, pick **Org A**,
   click **Create demo workflow**. It builds `llm_call → conditional_branch → http_request
   → approval_gate → notify` and attaches **manual** + **webhook** triggers. (Or build it
   by hand with the step/trigger editors.)
3. **Start it two ways.**
   - **Manual:** open the workflow → **▶ Run (manual)**.
   - **Webhook:** copy the token shown on the webhook trigger and POST:
     ```bash
     curl -X POST https://<subdomain>.functions.<region>.nhost.run/webhook \
       -H 'content-type: application/json' -d '{"token":"<paste-token>"}'
     ```
   - (Also try **Run via db_event trigger**, which inserts into the watched table and lets
     the Hasura Event Trigger start the run.)
4. **Pause & approve.** The run pauses at `approval_gate`. The **Approve →** button shows
   only for an Org A owner/editor; a viewer sees “awaiting owner/editor”. Approving resumes
   the run.
5. **Live status.** Each step flips `pending → running → succeeded` (and `awaiting_approval`
   / `skipped`) with **no refresh**, streamed over a GraphQL subscription.
6. **Cross-org isolation.** Sign in as `b.owner@…`, pick **Org B**. Org A’s workflows are
   invisible. Paste an Org A workflow ID into **“Trigger by ID”** → the Action rejects it
   (`caller is not an owner/editor in this org`). Direct-ID guessing fails too because every
   Hasura permission is scoped through `org_members`.

Extra checks: force a failure (e.g. an `http_request` to a bad URL) to see the **retry**
(`attempt 2`) and `failed` status; watch `calls_used` climb in the quota card and block new
runs at the limit.

---

## The two permission layers (short version — full detail in [WRITEUP.md](WRITEUP.md))

- **Layer 1 — org + role scoping.** One Hasura role, `user`. Every table permission is
  filtered through the `org_members` relationship joined on `X-Hasura-User-Id`, with the
  required role expressed inside the filter (`role: {_in: [...]}`). Cross-org isolation and
  ID-guess resistance are automatic.
- **Layer 2 — step-level gating.** (a) *Authoring:* Hasura insert **checks** make
  `db_write`/`notify` steps and `webhook` triggers **owner-only**. (b) *Execution:* the
  `approveStep` Action handler re-checks the approver’s role before resuming — a
  mid-execution decision a row permission can’t express.

---

## Notes
- **Stubbed LLM:** if `GROQ_API_KEY` is unset, `llm_call` returns a stubbed string after an
  ~800 ms disclosed delay ([`functions/_lib/groq.ts`](functions/_lib/groq.ts)).
- **notify delivery** is logged by the notify Event Trigger; set `SLACK_WEBHOOK_URL` and use
  `channel:"slack"` to post to Slack (wiring is real, delivery stubbed by default).
- **Scheduled trigger** fires per-workflow at most every `intervalMinutes` (default 60; the
  demo uses 1) via a Hasura cron trigger hitting `functions/scheduled.ts` each minute.
