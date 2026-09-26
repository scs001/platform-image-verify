# ops-console Specification (delta)

## Purpose

An internal, read-only web console that assembles the fd deployment health chain — build, image, GitOps, pod, app probe, search-relay quota — into one always-fresh board, replacing the kubectl/ssh/curl workflow that made the 2026-09-26 deploy-day incidents invisible until a human went looking.

## ADDED Requirements

### Requirement: The board shows the deployment health chain per service

The console SHALL render one vertical chain card per watched deployment: source revision → build status → image presence → GitOps sync → pod readiness → app-level readiness probe, with each link's live state and the timestamp of its last successful poll. A link whose poll fails or times out SHALL be shown as failed (not omitted), and the card SHALL stay renderable when any subset of links is unavailable.

#### Scenario: Healthy chain renders green

- **WHEN** every link of a deployment polls successfully
- **THEN** the card SHALL show each link as healthy with its current value (running tag, build number, sync state, pod count, probe result)

#### Scenario: A failed link is visible, not hidden

- **WHEN** one link's poll fails (e.g. Jenkins unreachable)
- **THEN** that link SHALL render as failed with the error's gist and age
- **AND** the remaining links SHALL still render their last-known state with the stale timestamp

### Requirement: Version drift is detected and surfaced

Each deployment card SHALL compare the running pod image tag, the latest successful build's image tag, and the GitOps manifest's image tag. When the three disagree, the card SHALL show a drift indicator naming the lagging element (a built image that was never rolled, or a manifest that lags the latest build); when all agree, it SHALL show the single version.

#### Scenario: New build never rolled

- **WHEN** the latest successful Jenkins build produced tag T2, the GitOps manifest references T2, but the running pod still runs T1
- **THEN** the card SHALL flag drift identifying the running pod as stale

#### Scenario: Manifest lags the latest build

- **WHEN** the latest successful build produced T2 but the GitOps manifest still references T1 and the pod runs T1
- **THEN** the card SHALL flag drift identifying the manifest as lagging behind the newest build

#### Scenario: All in agreement

- **WHEN** running tag, manifest tag, and latest successful build tag are identical
- **THEN** the card SHALL show that version with no drift indicator

### Requirement: The search relay exposes stats for the board

The search relay SHALL expose a stats endpoint (`GET /v1/stats`, same bearer-token authentication as `/v1/search`) returning at least: per-token call counts against the daily cap for the current UTC day, cache hit and miss totals since process start, upstream key failure counts, and response error counts by status class. The endpoint SHALL be read-only and SHALL NOT include key material or token values in its response.

#### Scenario: Stats reflect a day's traffic

- **WHEN** the relay has served cached and fresh searches and one upstream key has failed
- **THEN** the stats response SHALL report those counts such that quota usage, cache hit rate, and key failure are each derivable

#### Scenario: Stats leak no secrets

- **WHEN** the stats response is inspected
- **THEN** it SHALL NOT contain provider API keys or caller token values

### Requirement: Polling snapshots persist for recent history

The console SHALL poll each data source on a fixed cadence (30–60s), store each poll's parsed result as a snapshot in a local SQLite database with at least 7 days of retention, and prune older snapshots. The rendered board SHALL be derived from the latest snapshot set; history SHALL be queryable for the card sparklines (node memory, relay quota usage, Jenkins queue depth).

#### Scenario: Board renders from snapshots, not live calls

- **WHEN** the board page is requested repeatedly
- **THEN** rendering SHALL read the snapshot store without issuing new source polls

#### Scenario: Old snapshots are pruned

- **WHEN** a snapshot ages past the retention window
- **THEN** it SHALL be deleted from the store

### Requirement: Access is token-gated and strictly read-only

The console SHALL require a bearer token (from its deployment environment, never stored in the repository) on every request, rejecting unauthenticated requests. It SHALL NOT expose any mutating operation: no pod exec, no restart, no build trigger, no Kubernetes write of any kind. Its Kubernetes access SHALL use a dedicated service account limited to read-only verbs on the watched namespaces.

#### Scenario: Unauthenticated request is rejected

- **WHEN** a request arrives without the console's token
- **THEN** the console SHALL respond with an authentication error and no board content

#### Scenario: No mutation surface exists

- **WHEN** the console's HTTP surface is enumerated
- **THEN** every route SHALL be a read (board render, snapshot query, or stats/probe passthrough of the pollers' own reads)

### Requirement: No secrets live in the repository

All endpoint addresses, tokens, and credentials the console uses SHALL arrive via its environment (mounted from cluster Secrets at deploy time). The repository SHALL contain no real credential values; manifests and examples SHALL carry placeholders only.

#### Scenario: Repository contains no live credentials

- **WHEN** the change's committed files are inspected
- **THEN** no bearer token, provider key, or registry password SHALL appear — only env-var names, Secret references, and placeholder examples
