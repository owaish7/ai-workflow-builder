# Design write-up

## Schema reasoning

The data model mirrors the ownership chain the brief demands —
**org → members → workflows → steps/triggers**, and **workflow → runs → step_runs** —
because every access decision ultimately resolves to *“which org is this, and what is the
caller’s role in it?”* Making that chain explicit with foreign keys lets a single
membership join answer the question from any table.

- **`organizations`** carries the quota (`calls_used` / `calls_allowed`, `period_start`) so
  quota is an org-level fact, not scattered per workflow.
- **`org_members`** `(org_id, user_id, role)` with a unique `(org_id, user_id)` is the pivot
  every permission routes through. Role lives here, not in the JWT, because a user can have
  *different* roles in different orgs — a single JWT role couldn’t express that.
- **`workflows` / `workflow_steps` / `workflow_triggers`** — steps are ordered by an integer
  `position` (reordered by swapping positions) and typed, with a free-form `jsonb config`
  so new step behaviour never needs a migration.
- **`workflow_runs`** has a first-class `paused` status; **`step_runs`** is one row per step
  per run and holds everything the UI and executor need: `status`, `input`, `output`,
  `error`, `attempt`, and `approved_by` / `approved_at` for gates. The subscription reads
  this table directly, so writing status transitions here *is* the live feed.
- **`db_write_results`**, **`notifications`** (fires the notify Event Trigger) and
  **`event_source`** (watched by the DB-event Trigger) are the concrete side-effect targets
  for those step/trigger types.
- **Aggregation:** the `org_usage` **view** computes usage this period, `runs_this_month`,
  and average run duration in SQL — one tracked object the quota card reads.

## The two permission layers, enforced differently

**Layer 1 — org + role scoping (declarative, in Hasura).** Rather than three Hasura roles
juggling an org-id claim, there is **one role, `user`**, and every table’s permission filter
threads through the `org_members` relationship on `X-Hasura-User-Id`:

```yaml
filter: { organization: { members: { user_id: { _eq: X-Hasura-User-Id } } } }   # read
check:  { organization: { members: { user_id: { _eq: X-Hasura-User-Id },
                                     role: { _in: [owner, editor] } } } }         # write
```

Because the filter *requires* a membership row for the caller, an editor in Org A simply
cannot select or mutate Org B’s rows — and guessing a row ID doesn’t help, since the same
filter still runs. Viewers get read-only because `workflow_runs` / `step_runs` expose **no**
insert/update to `user` at all: runs are created only by the Action handler (admin).

**Layer 2 — step-level gating, in two places on purpose.**
- *Authoring (declarative):* the insert **check** on `workflow_steps` is a boolean `_or` that
  says *“owner/editor for ordinary steps, but owner-only when `type ∈ {db_write, notify}`.”*
  `workflow_triggers` does the same for `webhook`. So the “reaches outside the sandbox” step
  types are locked down at write time, by the database.
- *Execution (imperative):* clearing an `approval_gate` **cannot** be a row permission — it’s
  a decision made mid-run about whether to *resume*, not about reading/writing a row. So
  `approveStep` (an Action handler) looks up the approver’s role in the run’s org and rejects
  anyone who isn’t owner/editor **before** it resumes. Same intent as Layer 1, but enforced
  in code because the moment of enforcement is execution, not a CRUD call.

The Action endpoints are additionally protected by the `nhost-webhook-secret` header so the
publicly-reachable function URLs can’t be driven with a forged `session_variables` payload.

## Approval-gate pause / resume

The executor ([`functions/_lib/executor.ts`](functions/_lib/executor.ts)) is a plain
sequential loop, which makes pausing trivial: it iterates steps by `position`, and when it
reaches an `approval_gate` it sets that `step_run` to `awaiting_approval`, sets the
`workflow_run` to `paused`, and **returns**. No timers, no queue, no long-lived
invocation — the run’s state lives entirely in the database.

`triggerWorkflowRun` pre-creates a `pending` `step_run` for every step, then calls the loop
from index 0. Every transition is written back to `step_runs`/`workflow_runs`, so the
subscription paints progress live and shows the paused state.

Resuming is symmetric. `approveStep` verifies the approver (Layer 2b), stamps
`approved_by`/`approved_at` and marks the gate `succeeded`, then calls the **same loop**
starting just after the gate’s position. It reconstructs the value downstream steps consume
from the last succeeded step_run before the gate, flips the run back to `running`, and
finishes — completing the run and incrementing the org’s `calls_used` on success. Real
`llm_call`/`http_request` steps run with one retry; a failure marks the step `failed` and the
run `failed`. `conditional_branch` evaluates the previous step’s output and can skip the next
step or stop the run, which is how the demo’s LLM sentiment result changes what happens next.
