# agent-runner Specification

## Purpose
Defines the multi-tenant runtime that hosts deployed Agent Services: per-role dsh children composed from the deployment descriptor, the A2A adapter surface, session mapping, child lifecycle policy, and inbound authentication against the registry gateway.

## Requirements

### Requirement: One dedicated runtime child per deployed role

The runner SHALL host each deployed Agent Service as a dedicated runtime child with its own private runtime home, composed from the deployment descriptor: the role's persona, its declared skills (fetched from the registry's skill entries), and its declared MCP references. The child SHALL use the runner's deployment-level default model, and its inference SHALL consume the runner's service quota — never a user's. The child's MCP outbound calls SHALL authenticate with the runner's service credential.

#### Scenario: Composition from the descriptor

- **WHEN** the runner materializes a deployed role whose descriptor declares a persona, two skills, and one MCP reference
- **THEN** the child boots with that persona and exactly those skills and MCP servers available

#### Scenario: Model is a runner concern

- **WHEN** a deployed role serves a turn
- **THEN** the turn runs on the runner's configured default model, regardless of any cell's model selection


### Requirement: A2A adapter surface

Each hosted Agent Service SHALL serve its AgentCard at `/.well-known/agent-card.json` and accept JSON-RPC `message/send` (synchronous) and `message/stream` (SSE streaming) at its route. Responses SHALL carry text parts only in v1; file or chart outputs SHALL NOT be emitted as A2A artifacts. The served card SHALL match the card registered for the agent in the registry. Unsupported A2A methods SHALL return the protocol's method-not-found error, not crash the child.

#### Scenario: Card is discoverable

- **WHEN** a caller fetches the well-known card path of a hosted agent
- **THEN** the response is a valid AgentCard matching the registry-registered card

#### Scenario: Send returns a completed message

- **WHEN** a caller invokes `message/send` with a text part
- **THEN** the response contains the agent's reply as text parts once the turn completes

#### Scenario: Stream delivers deltas

- **WHEN** a caller invokes `message/stream` with a text part
- **THEN** SSE events deliver the reply incrementally and terminate when the turn completes

#### Scenario: Unsupported method

- **WHEN** a caller invokes an A2A method the adapter does not implement
- **THEN** a JSON-RPC method-not-found error is returned and the child keeps serving


### Requirement: Context maps one-to-one to a runtime session

Each A2A `contextId` SHALL map to exactly one runtime session on the role's child, so a conversation continues across messages within the same context. When a child is reaped or drained, its sessions end; a caller continuing afterwards SHALL get a fresh session (or an error during drain), never a session that silently mixes histories.

#### Scenario: Continuity within a context

- **WHEN** a caller sends two messages with the same `contextId`
- **THEN** the second turn sees the first turn's history

#### Scenario: Fresh context after reap

- **WHEN** a child is idle-reaped and the caller sends a message with a new `contextId`
- **THEN** the runner cold-starts a child and the conversation starts fresh



### Requirement: Child lifecycle is bounded and queued

The runner SHALL keep a deployed role's child resident by default — idle reaping is no longer a standalone timer and applies only as warm-zone demotion under the host memory budget (openspec: agent-residency). The runner SHALL enforce a configurable maximum of concurrent children; a message arriving while at capacity SHALL queue until a slot frees, not fail and not evict a busy child. Self-turns fired by the rhythm scheduler SHALL enter the same bounded queue as messages — one queueing discipline for every turn source. The runner SHALL expose a health endpoint reporting hosted agents and child states (resident, warm, starting, paused, serving), which the registry's health checks use.

#### Scenario: Idle reap and cold start

- **WHEN** a child has been idle past the former reap interval and the host memory budget is not under pressure
- **THEN** the child stays resident and the next message is served with no cold start; the reap-and-cold-start path exists only for warm-zone re-warm after a budget demotion

#### Scenario: Capacity queues instead of failing

- **WHEN** all child slots are busy and a message arrives for a role with no child
- **THEN** the message is queued and served when a slot frees, without evicting a busy child

#### Scenario: Health reflects reality

- **WHEN** the registry health-checks a deployed agent whose child is cold-starting, warm, or paused
- **THEN** the health endpoint reports each state distinctly from serving

#### Scenario: Self-turns ride the same queue

- **WHEN** a rhythm due fires while all child slots are busy
- **THEN** the self-turn queues behind messages under the same discipline and never preempts a serving turn

### Requirement: Inbound traffic is gateway-authenticated and bypass-proof

The runner SHALL accept A2A traffic only through the registry's reverse proxy: caller authentication and per-agent authorization (`invoke_agent`) are the gateway's `/validate` (the caller's gateway credential rides `X-Authorization`, which the gateway strips at egress), and the deployment's out-of-band A2A credential rides the standard `Authorization` header end-to-end (upstream 1.30.0's egress trust model — the gateway is not a credential broker). The runner SHALL require that credential on every request (card included), so calls lacking it — gateway-proxied or direct — are rejected; the runner SHALL NOT maintain its own caller accounts. Each agent SHALL be served at its own origin (the registry proxy maps `/agent/{path}/**` onto the registered URL's origin — upstream #1734), on a port derived deterministically from the registry path.

#### Scenario: Call without the agent credential is rejected

- **WHEN** a request reaches the agent's origin without the deployment credential in `Authorization` — whether direct or proxied through the gateway
- **THEN** the runner rejects it

#### Scenario: Proxied call with both credentials passes through

- **WHEN** a caller authorized by the gateway (`X-Authorization` validated at `/validate`) presents the deployment credential in `Authorization`
- **THEN** the runner serves the request, with no caller account existing on the runner


### Requirement: Delegation depth and concurrency are bounded

The runner SHALL refuse, with an explicit JSON-RPC error naming the bound, any A2A request whose `X-Delegation-Depth` is 3 or greater — a delegation chain is cut at three hops, which breaks every cross-request cycle without global tracking. The runner SHALL additionally bound concurrent delegation-originated turns (depth ≥ 1) per hosted agent to a configurable cap (default 2): over-cap requests queue under the existing bounded-queue discipline, never fail, and never preempt a serving turn.

#### Scenario: Deep chains are refused explicitly

- **WHEN** an A2A request arrives with X-Delegation-Depth: 3
- **THEN** the caller receives an explicit error naming the delegation depth bound, no turn runs, and no child is spawned

#### Scenario: Depth-two chains pass

- **WHEN** an A2A request arrives with X-Delegation-Depth: 2
- **THEN** the request is served normally

#### Scenario: Over-cap delegations queue instead of failing

- **WHEN** delegation-originated turns already fill an agent's concurrency cap and another arrives
- **THEN** the new request queues under the existing queueing discipline and is served when a slot frees

### Requirement: Facade-originated external contexts are idle-reaped

The runner SHALL reclaim runtime sessions under external contexts — the context namespace the facade derives for external callers — after a configurable idle period (default 24 hours), freeing session storage. Rhythm day-sessions and registry-path (internal) contexts SHALL NOT be subject to this reap. A message arriving on a reaped external context SHALL continue as a fresh conversation on that context — never an error, never a silently mixed history. Durable state across external requests belongs in the agent's own files, not session history.

#### Scenario: An idle external context is reaped silently

- **WHEN** an external context has been idle past the configured window and a message later arrives on it
- **THEN** the turn runs on a fresh session for that context, without error

#### Scenario: Internal and rhythm sessions are untouched

- **WHEN** the reap pass runs
- **THEN** rhythm day-sessions and internal (registry-path) contexts remain resident and unaffected

### Requirement: Turn budgets are enforced with a hard stop

The runner SHALL run every turn of a deployed role — messages, rhythm self-turns, and rollover digests alike — under that role's effective turn budget: the deployment descriptor's budget when present, else the runner's configurable deployment default. When a turn exceeds its budget, the runner SHALL stop the turn by a hard stop: the child process is stopped and re-spawns on the role's next touch (dsh has no interrupt RPC — ADR-0014 ④; the private home's file state and durable agent state survive), the caller receives a structured error naming the budget bound, and the meter records the turn as a budget kill. A role whose descriptor carries no budget SHALL behave exactly as before this change under the deployment default.

#### Scenario: An over-budget turn is hard-stopped with a named bound

- **WHEN** a role with an effective budget of N minutes runs a turn that exceeds it
- **THEN** the turn fails with a structured error naming the N-minute bound, the child process is stopped, and the next message on that role cold-starts a fresh child

#### Scenario: Durable state survives the stop

- **WHEN** a budget kill stops a child mid-turn
- **THEN** the role's private home, session storage, and any files the agent wrote remain on disk, and the next conversation continues from them

#### Scenario: Every turn source shares the budget

- **WHEN** a rhythm self-turn or rollover digest exceeds the role's effective budget
- **THEN** it is stopped under the same discipline as a message turn, and the meter records the kill

#### Scenario: No budget means the deployment default

- **WHEN** a deployed role's descriptor carries no budget field
- **THEN** its turns run under the runner's configurable deployment default, unchanged in behavior from before this change
