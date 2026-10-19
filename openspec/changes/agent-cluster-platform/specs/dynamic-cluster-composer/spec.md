# dynamic-cluster-composer Specification

## Purpose

Enables users to assemble custom agent clusters at runtime from multiple pack agents, with full lifecycle management and session binding.

## ADDED Requirements

### Requirement: Cluster composer UI

The Agents page SHALL include a "Create Cluster" button that opens a composer modal with the following sections:

**Section 1: Cluster metadata**
- Cluster name input (required, max 100 characters)
- Description textarea (optional, max 500 characters)
- Tags input (optional, comma-separated, max 5 tags)

**Section 2: Agent selection**
- Searchable list of all available agents across installed packs
- Each agent row shows: agent name, pack source, version, and brief description
- Multi-select checkboxes to choose which agents to include
- "Add all from pack" shortcut for each pack (adds all agents from that pack at once)

**Section 3: Activation policy**
- Toggle: "Activate all selected agents on creation" (default: true)
- If false, agents are added to the cluster but not auto-activated (user must manually activate later)

**Section 4: Session binding**
- Optional: "Bind to current session" checkbox
- If checked, the cluster is immediately available in the active chat session

The modal SHALL validate before submission:
- Cluster name is required and unique within the user's namespace
- At least one agent must be selected
- If session binding is enabled, a session must be active

#### Scenario: Composer modal opens

- **WHEN** a user clicks "Create Cluster" on the Agents page
- **THEN** a modal appears with empty metadata fields and an unfiltered agent list

#### Scenario: Pack-wide agent addition

- **WHEN** a user clicks "Add all from pack" for the Finance Pack
- **THEN** all agents from that pack are added to the selection with their checkboxes checked

#### Scenario: Duplicate agent prevention

- **WHEN** a user tries to add the same agent twice (e.g., from different packs with same id)
- **THEN** the system prevents duplication and shows a warning message

### Requirement: Dynamic cluster API endpoints

The platform SHALL expose the following endpoints:

**POST /api/clusters/dynamic**
- Creates a new dynamic cluster
- Request body: `name`, `description?`, `tags?`, `agents[]` (each with `packId`, `agentId`, `version?`), `activateAll?` (default true), `bindToSession?`
- Response: `clusterId`, `status` ("creating" | "ready"), `agents[]` with individual statuses
- Rate limit: 10 cluster creations per hour per user

**GET /api/clusters/:clusterId**
- Returns cluster metadata, status, and member agents
- Response: `clusterId`, `name`, `description`, `tags`, `status`, `createdAt`, `lastUsedAt`, `agents[]`

**DELETE /api/clusters/:clusterId**
- Terminates the cluster
- Response: `success: true`, `message: "Cluster terminated"`
- Side effects: Deactivates all agents, releases session bindings, triggers cleanup

**PATCH /api/clusters/:clusterId**
- Updates cluster metadata (name, description, tags)
- Does NOT change agent composition (use separate endpoint for that)
- Response: Updated cluster object

**POST /api/clusters/:clusterId/agents**
- Adds agents to an existing cluster
- Request body: `agents[]` (same format as creation)
- Response: Updated cluster object with new agents

**DELETE /api/clusters/:clusterId/agents/:agentId**
- Removes an agent from the cluster
- Response: Updated cluster object

#### Scenario: Cluster creation succeeds

- **WHEN** a user creates a cluster with 3 agents from 2 packs
- **THEN** the endpoint returns `clusterId` and `status: "ready"` if all packs are installed, or `status: "creating"` if any pack needs installation

#### Scenario: Cluster update allowed

- **WHEN** a user patches a cluster's description
- **THEN** the cluster is updated and `lastModifiedAt` is refreshed

#### Scenario: Agent removal succeeds

- **WHEN** a user removes an agent from a cluster
- **THEN** the agent is no longer part of the cluster's agent list and cannot be activated via this cluster

### Requirement: Cluster session binding

When a dynamic cluster is created with `bindToSession: true`:
- The cluster's agents SHALL be pre-selected in the active chat session
- Switching between these agents SHALL preserve session history
- The session header SHALL display "Running with [Cluster Name]" instead of a single agent name

If the cluster is terminated while bound to a session:
- The session SHALL fall back to the built-in agent
- A notification SHALL be shown: "Cluster '[name]' was terminated; switched to built-in agent"

#### Scenario: Cluster-bound session

- **WHEN** a user creates a cluster with "Bind to current session" enabled
- **THEN** the next message in the chat is routed through the cluster's default agent

#### Scenario: Cluster termination during session

- **WHEN** a cluster is terminated while actively used in a session
- **THEN** the session falls back to the built-in agent and notifies the user

### Requirement: Cluster usage tracking

Every dynamic cluster SHALL track:
- `createdAt`: Timestamp of cluster creation
- `lastUsedAt`: Timestamp of last task execution or chat interaction
- `totalExecutions`: Counter of total tasks executed by this cluster
- `totalTokensUsed`: Sum of tokens consumed by all agents in the cluster

These metrics SHALL be exposed via `GET /api/clusters/:clusterId` and visible in the cluster management UI.

Clusters SHALL be eligible for auto-termination when:
- `lastUsedAt` is ≥ 24 hours ago AND `totalExecutions` < 5 (low-usage threshold)
- OR `lastUsedAt` is ≥ 7 days ago (absolute timeout)

Auto-termination SHALL send a WebSocket event to connected clients before deleting the cluster.

#### Scenario: Usage metrics tracked

- **WHEN** a user executes a task using a dynamic cluster
- **THEN** the cluster's `totalExecutions` counter is incremented and `lastUsedAt` is updated

#### Scenario: Low-usage cluster auto-terminated

- **WHEN** a cluster has been unused for 24 hours with fewer than 5 total executions
- **THEN** the system sends a warning event and deletes the cluster after a 1-hour grace period

---

## MODIFIED Requirements
