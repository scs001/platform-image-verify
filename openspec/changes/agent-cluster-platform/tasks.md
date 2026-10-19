# Agent Cluster Platform - Implementation Tasks

## 1. Phase 1: MVP - Pack as Cluster Template

### 1.1 Backend: Pack manifest schema extension

- [ ] 1.1 Update `lib/pack-manifest.js` to accept optional `cluster` field with validation for name, description, defaultAgents, optionalAgents, schedulingPolicy
- [ ] 1.2 Add validation tests for cluster metadata (valid cases, invalid agent refs, oversized fields, excessive concurrency)
- [ ] 1.3 Verify: Run `node scripts/test-pack-validate.mjs` on a pack with cluster metadata and confirm it passes; run on malformed cluster and confirm rejection

### 1.2 Backend: Catalog marking

- [ ] 1.4 Update `gateway/packs.js` to add `clusterId`, `clusterName`, `isDefaultAgent` fields to pack-sourced agents in catalog response
- [ ] 1.5 Add integration test: subscribe to a cluster pack, fetch `/api/catalog`, verify cluster fields present on agents
- [ ] 1.6 Verify: Call `curl http://localhost:3000/api/catalog` after subscribing to a cluster pack and inspect JSON for `clusterId` field

### 1.3 Frontend: Marketplace cluster views

- [ ] 1.7 Update `web/src/components/packs/PackDetailDialog.tsx` to show "Cluster Info" section when pack has cluster metadata (name, description, agent count, agent list)
- [ ] 1.8 Add expandable/collapsible agent list UI with "Show optional agents" toggle
- [ ] 1.9 Update marketplace listing page to add cluster size filter (`?size=3`) and category filter
- [ ] 1.10 Verify: Open a cluster pack detail, confirm cluster info section renders; apply size filter and confirm only matching packs shown

## 2. Phase 2: Core - Dynamic Cluster Composer

### 2.1 Backend: Dynamic cluster API

- [ ] 2.1 Create `server/routes/clusters.js` with endpoints: POST /api/clusters/dynamic, GET /api/clusters/:id, DELETE /api/clusters/:id, PATCH /api/clusters/:id
- [ ] 2.2 Implement cluster creation logic: validate pack references, trigger install flow if needed, return status
- [ ] 2.3 Implement cluster termination logic: deactivate agents, release session bindings, trigger cleanup
- [ ] 2.4 Add auto-termination job: cron task that checks clusters unused for 24h with <5 executions and deletes them
- [ ] 2.5 Add rate limiting: 10 cluster creations per hour per user (use existing rate limiter middleware)
- [ ] 2.6 Verify: Create a dynamic cluster via API, confirm clusterId returned; terminate it, confirm GET returns 404

### 2.2 Frontend: Cluster composer UI

- [ ] 2.7 Create `web/src/components/clusters/ClusterComposerModal.tsx` with sections: metadata input, agent selection (searchable multi-select), activation policy, session binding
- [ ] 2.8 Add "Add all from pack" shortcut for each pack in agent selection
- [ ] 2.9 Wire up form submission to POST /api/clusters/dynamic endpoint
- [ ] 2.10 Display loading state with progress indicator during bulk install
- [ ] 2.11 Verify: Open cluster composer, select 3 agents from 2 packs, create cluster; confirm modal shows progress and completes successfully

### 2.3 Frontend: Agent picker cluster grouping

- [ ] 2.12 Update `web/src/components/agent/AgentPicker.tsx` to group pack-sourced agents by `clusterId`
- [ ] 2.13 Add cluster header showing cluster name and agent count
- [ ] 2.14 Add "Load entire cluster" button that triggers bulk install + activation
- [ ] 2.15 Verify: Subscribe to a cluster pack, open agent picker, confirm agents are grouped under cluster header with "Load entire cluster" button

### 2.4 Integration: Session binding

- [ ] 2.16 Update WebSocket protocol: add `cluster_bound` event when a cluster is bound to a session
- [ ] 2.17 Update chat session header to display "Running with [Cluster Name]" when cluster-bound
- [ ] 2.18 Handle cluster termination during session: fall back to built-in agent, show notification
- [ ] 2.19 Verify: Create a cluster with "Bind to current session", send a message, confirm session header shows cluster name

## 3. Phase 3: Advanced - Scheduling & Model Binding

### 3.1 Backend: Cluster-aware scheduling tools

- [ ] 3.1 Update `lib/scheduling-tools.js` to accept `clusterId`, `executionPolicy`, `targetAgents` fields in create tool
- [ ] 3.2 Implement parallel vs sequential execution: add flag to control whether agents run concurrently or sequentially
- [ ] 3.3 Implement result aggregation: support "first", "all", "summary" policies
- [ ] 3.4 Extend list tool response to include `clusterName`, `agentCount` for cluster tasks
- [ ] 3.5 Add cluster-level task management endpoints: POST /api/clusters/:id/tasks/:taskId/pause, resume, delete
- [ ] 3.6 Verify: Create a cluster task with 3 agents and parallel=true; execute it, confirm all 3 agents ran concurrently and results aggregated

### 3.2 Frontend: Task history with cluster view

- [ ] 3.7 Update `web/src/pages/TasksPage.tsx` to display cluster tasks with cluster badge and agent avatars
- [ ] 3.8 Add expandable timeline view for cluster task details (show per-agent output)
- [ ] 3.9 Visualize parallel execution: use CSS grid to show agents running simultaneously
- [ ] 3.10 Verify: View a completed cluster task, confirm cluster badge shows, click to expand and see per-agent outputs

### 3.3 Backend: Per-agent model binding

- [ ] 3.11 Update deploy action in `gateway/packs.js` to accept `model` field per agent in deploy request
- [ ] 3.12 Implement three-gate validation: whitelist check, lane check, roster check (degrade open if roster unavailable)
- [ ] 3.13 Add serving config PATCH endpoint to update model binding on live deployments
- [ ] 3.14 Implement provider routing layer: map model IDs to provider endpoints with fallback
- [ ] 3.15 Log `providerUsed` in usage metrics for every turn
- [ ] 3.16 Verify: Deploy a pack with model="volces-max"; execute a task, confirm logs show provider used; fail volces intentionally, confirm fallback to tencent works

### 3.4 Frontend: Model binding UI

- [ ] 3.17 Update pack detail dialog deploy form to show model input per agent (autocomplete from manifest's modelWhitelist)
- [ ] 3.18 Add session-level model override: POST /api/sessions/:sessionId/switch-agent with modelOverride field
- [ ] 3.19 Show model override in session header: "finance-bot (using deepseek-coder)"
- [ ] 3.20 Verify: Open pack detail, deploy with model override; start a session, switch agent with model override, confirm header shows overridden model

## 4. Testing & Validation

### 4.1 Unit tests

- [ ] 4.1 Write unit tests for cluster metadata validation (all edge cases)
- [ ] 4.2 Write unit tests for dynamic cluster API (creation, termination, auto-termination)
- [ ] 4.3 Write unit tests for scheduling tools with cluster context (parallel, sequential, aggregation)
- [ ] 4.4 Write unit tests for provider routing (fallback logic, error handling)

### 4.2 Integration tests

- [ ] 4.5 End-to-end test: subscribe to cluster pack → create dynamic cluster → execute task → verify results
- [ ] 4.6 End-to-end test: deploy pack with model binding → execute task → verify provider used logged correctly
- [ ] 4.7 Load test: create 100 dynamic clusters, verify auto-termination cleans them up after 24h

### 4.3 Manual testing

- [ ] 4.8 Manually test cluster composer UI: create clusters with various configurations
- [ ] 4.9 Manually test marketplace cluster views: browse, filter, search cluster packs
- [ ] 4.10 Manually test task history: view cluster tasks, expand timelines, verify visualization

## 5. Documentation & Release

### 5.1 User documentation

- [ ] 5.1 Write user guide: "How to use agent clusters" (marketplace discovery, dynamic assembly, task execution)
- [ ] 5.2 Write creator guide: "How to publish cluster packs" (cluster metadata in manifest, examples)
- [ ] 5.3 Add tooltips to UI elements: cluster composer, model binding, execution policy

### 5.2 API documentation

- [ ] 5.4 Update OpenAPI spec with new cluster endpoints
- [ ] 5.5 Document cluster task schema and execution policies

### 5.3 Release

- [ ] 5.6 Add feature flags: `CLUSTER_VIEWS_ENABLED`, `DYNAMIC_CLUSTERS_ENABLED`, `CLUSTER_SCHEDULING_ENABLED`
- [ ] 5.7 Roll out Phase 1 with feature flag enabled for 10% of users, monitor errors
- [ ] 5.8 Roll out Phase 2 with feature flag enabled for 50% of users, monitor errors
- [ ] 5.9 Roll out Phase 3 with feature flag enabled for 100% of users
- [ ] 5.10 Remove feature flags after successful rollout

## Verification Summary

- [ ] **Verification**: Full end-to-end test: subscribe to Finance Cluster pack → create dynamic cluster with Data Analyst pack → schedule a daily task → verify task executes both agents → check task history shows cluster view → verify billing logs show correct provider used
