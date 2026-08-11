-- AI Agent Workflow Builder — initial schema
-- Relationships: org -> members -> workflows -> steps/triggers, workflow -> runs -> step_runs
-- Written idempotently (IF NOT EXISTS / OR REPLACE) so it can be applied via the
-- nhost migration system OR re-run through scripts/setup-db.mjs without Docker.

-- ---------- shared updated_at trigger ----------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------- organizations (with usage quota) ----------
CREATE TABLE IF NOT EXISTS public.organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  calls_used    integer NOT NULL DEFAULT 0,
  calls_allowed integer NOT NULL DEFAULT 100,
  period_start  date NOT NULL DEFAULT current_date,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- org membership (user + role, scoped to an org) ----------
CREATE TABLE IF NOT EXISTS public.org_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON public.org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org  ON public.org_members(org_id);

-- ---------- workflows ----------
CREATE TABLE IF NOT EXISTS public.workflows (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflows_org ON public.workflows(org_id);

-- ---------- workflow steps (ordered, typed, JSONB config) ----------
CREATE TABLE IF NOT EXISTS public.workflow_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  type        text NOT NULL CHECK (type IN
                 ('llm_call','http_request','db_write','notify','conditional_branch','approval_gate')),
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_steps_workflow ON public.workflow_steps(workflow_id);

-- ---------- workflow triggers ----------
CREATE TABLE IF NOT EXISTS public.workflow_triggers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('manual','webhook','scheduled','db_event')),
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_triggers_workflow ON public.workflow_triggers(workflow_id);

-- ---------- workflow runs (one per execution, supports paused) ----------
CREATE TABLE IF NOT EXISTS public.workflow_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','paused','succeeded','failed')),
  trigger_type text,
  started_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON public.workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_org ON public.workflow_runs(org_id);
DROP TRIGGER IF EXISTS trg_runs_updated ON public.workflow_runs;
CREATE TRIGGER trg_runs_updated BEFORE UPDATE ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- step runs (one per step per run) ----------
CREATE TABLE IF NOT EXISTS public.step_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_id     uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  position    integer NOT NULL,
  type        text NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','awaiting_approval','succeeded','failed','skipped')),
  input       jsonb,
  output      jsonb,
  error       text,
  attempt     integer NOT NULL DEFAULT 0,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_step_runs_run ON public.step_runs(run_id);
DROP TRIGGER IF EXISTS trg_step_runs_updated ON public.step_runs;
CREATE TRIGGER trg_step_runs_updated BEFORE UPDATE ON public.step_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- db_write target (for db_write step type) ----------
CREATE TABLE IF NOT EXISTS public.db_write_results (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dbwrite_org ON public.db_write_results(org_id);

-- ---------- notifications (target for `notify` steps; fires the notify Event Trigger) ----------
CREATE TABLE IF NOT EXISTS public.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  channel    text NOT NULL DEFAULT 'log',
  message    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_org ON public.notifications(org_id);

-- ---------- event_source (watched table for the DB-event trigger) ----------
CREATE TABLE IF NOT EXISTS public.event_source (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_source_org ON public.event_source(org_id);

-- ---------- aggregation: org usage this month + avg run duration ----------
CREATE OR REPLACE VIEW public.org_usage AS
SELECT
  o.id            AS org_id,
  o.calls_used,
  o.calls_allowed,
  o.period_start,
  COUNT(r.id) FILTER (WHERE r.started_at >= date_trunc('month', now()))            AS runs_this_month,
  COALESCE(
    AVG(EXTRACT(EPOCH FROM (r.finished_at - r.started_at)))
      FILTER (WHERE r.finished_at IS NOT NULL),
    0)::numeric(10,2)                                                              AS avg_run_seconds
FROM public.organizations o
LEFT JOIN public.workflow_runs r ON r.org_id = o.id
GROUP BY o.id;
