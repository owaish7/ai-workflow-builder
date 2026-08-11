// All GraphQL documents used by the app, as plain strings (urql accepts strings).

// My orgs + my role in each (Hasura scopes both to my memberships).
export const MY_CONTEXT = `
  query MyContext($me: uuid!) {
    organizations(order_by: { name: asc }) {
      id name calls_used calls_allowed
    }
    org_members(where: { user_id: { _eq: $me } }) { org_id role }
  }
`;

// An org's workflows WITH steps, triggers, and most recent run status.
export const ORG_WORKFLOWS = `
  query OrgWorkflows($org: uuid!) {
    workflows(where: { org_id: { _eq: $org } }, order_by: { created_at: desc }) {
      id name created_at
      steps(order_by: { position: asc }) { id position type config }
      triggers { id type config }
      runs(order_by: { started_at: desc }, limit: 1) { id status started_at finished_at }
    }
  }
`;

// Org usage aggregation (the tracked view).
export const ORG_USAGE = `
  query OrgUsage($org: uuid!) {
    org_usage(where: { org_id: { _eq: $org } }) {
      calls_used calls_allowed runs_this_month avg_run_seconds
    }
  }
`;

// Create a workflow together with its steps and triggers in ONE mutation (nested insert).
export const CREATE_WORKFLOW_FULL = `
  mutation CreateWorkflowFull($obj: workflows_insert_input!) {
    insert_workflows_one(object: $obj) { id }
  }
`;

export const CREATE_WORKFLOW = `
  mutation CreateWorkflow($org: uuid!, $name: String!) {
    insert_workflows_one(object: { org_id: $org, name: $name }) { id }
  }
`;

export const ADD_STEP = `
  mutation AddStep($obj: workflow_steps_insert_input!) {
    insert_workflow_steps_one(object: $obj) { id }
  }
`;

export const UPDATE_STEP_POSITION = `
  mutation UpdateStepPos($id: uuid!, $position: Int!) {
    update_workflow_steps_by_pk(pk_columns: { id: $id }, _set: { position: $position }) { id }
  }
`;

export const DELETE_STEP = `
  mutation DeleteStep($id: uuid!) {
    delete_workflow_steps_by_pk(id: $id) { id }
  }
`;

export const ADD_TRIGGER = `
  mutation AddTrigger($obj: workflow_triggers_insert_input!) {
    insert_workflow_triggers_one(object: $obj) { id }
  }
`;

export const DELETE_TRIGGER = `
  mutation DeleteTrigger($id: uuid!) {
    delete_workflow_triggers_by_pk(id: $id) { id }
  }
`;

// Drop a row into the watched table -> fires the DB-event trigger -> auto-starts a run.
export const FIRE_DB_EVENT = `
  mutation FireDbEvent($org: uuid!, $workflow: uuid!) {
    insert_event_source_one(object: { org_id: $org, workflow_id: $workflow, payload: { source: "ui" } }) { id }
  }
`;

// Actions.
export const TRIGGER_RUN = `
  mutation TriggerRun($workflow_id: uuid!) {
    triggerWorkflowRun(workflow_id: $workflow_id) { run_id status message }
  }
`;

export const APPROVE_STEP = `
  mutation ApproveStep($step_run_id: uuid!) {
    approveStep(step_run_id: $step_run_id) { step_run_id status message }
  }
`;

// Live run progress: run status + every step's status (drives the whole run view).
export const RUN_PROGRESS = `
  subscription RunProgress($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id status started_at finished_at trigger_type
      step_runs(order_by: { position: asc }) {
        id position type status error output attempt approved_by approved_at
      }
    }
  }
`;

// Most recent run for a workflow (used to auto-attach the live view after a trigger).
export const LATEST_RUN = `
  query LatestRun($workflow: uuid!) {
    workflow_runs(where: { workflow_id: { _eq: $workflow } }, order_by: { started_at: desc }, limit: 1) {
      id status
    }
  }
`;
