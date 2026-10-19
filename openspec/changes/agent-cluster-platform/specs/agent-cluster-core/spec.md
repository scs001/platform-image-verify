# agent-cluster-core Specification

## Purpose

Defines the cluster abstraction that unifies packs, agents, and their relationships — enabling shareable agent clusters as first-class citizens in the platform.

## ADDED Requirements

### Requirement: Pack manifest supports cluster metadata

Each pack MAY declare a top-level `cluster` object with the following structure:

```yaml
cluster:
  name: string           # Human-readable cluster name (required)
  description: string    # Cluster description (required)
  defaultAgents: string[] # Agent ids to activate by default (non-empty)
  optionalAgents?: string[] # Additional agents available but not auto-activated
  schedulingPolicy?: {   # Optional cluster-level scheduling config
    maxConcurrentRuns?: number  # Max parallel task executions (default: 1)
    preferredRunner?: string    # Preferred runner fleet id (optional)
  }
```

The `cluster` field is OPTIONAL; packs without it are treated as single-agent or non-cluster packs. When present, all fields MUST follow these rules:
- `name` and `description` are required, non-empty strings of at most 500 characters each
- `defaultAgents` MUST be non-empty and contain only agent ids declared in the pack's `agents` array
- `optionalAgents` MUST contain only agent ids from the same `agents` array, no duplicates across `defaultAgents` + `optionalAgents`
- `schedulingPolicy.maxConcurrentRuns` MUST be a positive integer ≤ 10 when present
- `schedulingPolicy.preferredRunner` MUST match an existing runner id in the fleet registry when present

#### Scenario: Valid cluster metadata accepted

- **WHEN** a pack manifest includes a well-formed `cluster` object
- **THEN** the publish endpoint accepts it and stores the metadata alongside the manifest

#### Scenario: Missing required fields rejected

- **WHEN** a pack manifest declares `cluster.name` but omits `cluster.description`
- **THEN** the publish is rejected with a validation error naming the missing field

#### Scenario: Invalid agent reference rejected

- **WHEN** a pack manifest declares `cluster.defaultAgents` containing an agent id not in the pack's `agents` array
- **THEN** the publish is rejected with a validation error naming the offending agent id

#### Scenario: Oversized metadata rejected

- **WHEN** a pack manifest declares `cluster.name` exceeding 500 characters
- **THEN** the publish is rejected with a validation error naming the field

#### Scenario: Excessive concurrency limit rejected

- **WHEN** a pack manifest declares `cluster.schedulingPolicy.maxConcurrentRuns` > 10
- **THEN** the publish is rejected with a validation error naming the field

### Requirement: Agent catalog marks pack-sourced agents with clusterId

Every `agent-remote` entry sourced from a pack with `cluster` metadata SHALL carry an additional `clusterId` field in the catalog response:

```json
{
  "id": "finance-bot",
  "type": "agent-remote",
  "mode": "chat",
  "clusterId": "_abc123",  // pack id of the source pack
  "clusterName": "Finance Analyst Cluster",
  "isDefaultAgent": true,
  ...
}
```

The `clusterId` field SHALL be present for all pack-sourced entries; absent for built-in (`agent-local`) or registry-sourced (`agent-remote` from mcp-gateway-registry) entries. The `clusterName` field SHALL be derived from the pack's `cluster.name` when available, else fallback to the pack's display name. The `isDefaultAgent` flag SHALL be `true` if the agent id appears in `cluster.defaultAgents`, else `false`.

#### Scenario: Pack-sourced agent carries clusterId

- **WHEN** a user fetches `GET /api/catalog` after subscribing to a pack with cluster metadata
- **THEN** the pack's agents appear with `clusterId`, `clusterName`, and `isDefaultAgent` fields

#### Scenario: Built-in agent has no clusterId

- **WHEN** a user fetches `GET /api/catalog`
- **THEN** the built-in `agent-local` entry does NOT carry a `clusterId` field

#### Scenario: Cluster name fallback to pack name

- **WHEN** a pack has cluster metadata but `cluster.name` is empty
- **THEN** the catalog entry uses the pack's display name as `clusterName`

### Requirement: Cluster-aware agent picker

The agent picker UI SHALL group pack-sourced agents by their `clusterId`, displaying:
- A cluster header showing the cluster name and agent count
- Default agents listed first, followed by optional agents
- An action button "Load entire cluster" that activates all `defaultAgents` simultaneously

When a user selects "Load entire cluster", the system SHALL:
1. Install any missing packs from the cluster (triggering install flow if not already installed)
2. Activate all default agents in a single session restart
3. Show a progress indicator during bulk installation

#### Scenario: Cluster grouping in picker

- **WHEN** a user opens the agent picker after subscribing to a cluster pack
- **THEN** the pack's agents are grouped under a cluster header with "Load entire cluster" button

#### Scenario: Bulk install on cluster load

- **WHEN** a user clicks "Load entire cluster" for a cluster containing an unsubscribed pack
- **THEN** the system triggers the install flow for that pack before activating the agents

### Requirement: Dynamic cluster assembly API

The platform SHALL expose a `POST /api/clusters/dynamic` endpoint that allows authenticated users to create ad-hoc clusters from multiple pack agents:

Request body:
```json
{
  "name": "My Analysis Team",
  "agents": [
    { "packId": "_abc123", "agentId": "finance-bot", "version": "1.2" },
    { "packId": "_def456", "agentId": "data-analyst", "version": "2.0" }
  ],
  "sessionId": "session_789"  // optional: bind to existing session
}
```

Response:
```json
{
  "clusterId": "dyn_xyz789",
  "status": "loading",
  "agents": [
    { "id": "finance-bot", "status": "active", "packId": "_abc123" },
    { "id": "data-analyst", "status": "installing", "packId": "_def456" }
  ]
}
```

The endpoint SHALL:
- Validate that all referenced packs exist and are accessible to the requester
- For each agent: if its pack is not installed, trigger install flow and return `status: "loading"`; if already installed, mark as `status: "active"`
- Bind the cluster to the optional `sessionId` if provided, making these agents available in that session
- Return immediately with cluster status; actual activation happens asynchronously

Access control:
- Creating dynamic clusters is allowed for all authenticated users
- If a referenced pack is private and the requester is not the owner, the request is rejected with 403

#### Scenario: Dynamic cluster creation succeeds

- **WHEN** an authenticated user creates a dynamic cluster from two already-installed packs
- **THEN** the endpoint returns `status: "ready"` with all agents marked active

#### Scenario: Dynamic cluster creation triggers install

- **WHEN** an authenticated user creates a dynamic cluster containing an unsubscribed pack
- **THEN** the endpoint returns `status: "loading"` with that agent marked installing

#### Scenario: Private pack access denied

- **WHEN** a user tries to create a dynamic cluster including a private pack they don't own
- **THEN** the endpoint rejects with 403 Forbidden

### Requirement: Cluster lifecycle management

Dynamic clusters SHALL have the following lifecycle states:
- `creating`: Cluster is being assembled (packs installing)
- `ready`: All agents are active and ready for use
- `terminated`: Cluster has been explicitly terminated by the user

The platform SHALL expose:
- `GET /api/clusters/:clusterId` — get current cluster status and member agents
- `DELETE /api/clusters/:clusterId` — terminate the cluster (deactivate all agents, release resources)

Clusters SHALL automatically transition to `terminated` when:
- The user ends their session
- All constituent packs are uninstalled
- The cluster has been idle for ≥ 24 hours (no task execution or chat interaction)

#### Scenario: Cluster status retrieval

- **WHEN** a user calls `GET /api/clusters/dyn_xyz789`
- **THEN** the response includes cluster name, status, list of agents with their individual statuses, and creation timestamp

#### Scenario: Idle cluster auto-termination

- **WHEN** a dynamic cluster has not been used for 24 hours
- **THEN** the system automatically terminates it and cleans up associated resources

#### Scenario: Manual cluster termination

- **WHEN** a user calls `DELETE /api/clusters/dyn_xyz789`
- **THEN** the cluster transitions to `terminated` state and all agents are deactivated

---

## MODIFIED Requirements

### Requirement: pack-marketplace (modified)

**MODIFIED**: The pack marketplace detail view SHALL display cluster metadata when present. The view SHALL add a "Cluster Info" section showing cluster name, description, and agent count. The view SHALL list all agents in the pack with their roles (default vs optional). The view SHALL show a "Subscribe & Install" button that installs all agents at once.

**Reason**: Unify pack subscription experience with cluster mental model.

**Migration**: No breaking changes; existing packs without cluster metadata render unchanged.

#### Scenario: Cluster info displayed on pack detail

- **WHEN** a user opens the detail view of a pack with cluster metadata
- **THEN** the page shows a dedicated "Cluster Info" section with agent list and counts

### Requirement: agent-catalog (modified)

**MODIFIED**: The merged catalog merge order SHALL include pack-sourced agents BEFORE custom-preset entries, with custom presets able to shadow pack agents by id (existing behavior preserved).

**Reason**: Clarify precedence when both pack agents and custom presets define the same agent id.

**Migration**: No breaking changes; existing shadowing semantics preserved.

#### Scenario: Pack agents appear before custom presets in merge

- **WHEN** a pack and a custom preset define an agent with the same id
- **THEN** the pack-sourced agent appears first in the merge order but can be shadowed by the custom preset
