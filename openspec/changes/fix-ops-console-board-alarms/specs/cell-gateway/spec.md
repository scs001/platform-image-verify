## MODIFIED Requirements

### Requirement: Gateway health and routing are observable

The gateway SHALL expose its own health endpoints — `/healthz` and `/api/ready`, both anonymous (a probe holds no session), both answering the same process-readiness payload (process liveness, uptime, live cell count) with no per-user information — so that deployment-level probes designed for the platform's `/api/ready` contract keep working unchanged behind the gateway. The gateway SHALL also report per-user cell status (running, starting, stopped) to authenticated administrative requests. A cell that fails to start or exits unexpectedly SHALL surface as an error to that user's traffic and in the administrative status, without affecting other users' cells.

#### Scenario: one user's cell failure does not affect others

- **WHEN** user A's cell crashes
- **THEN** user A sees an error or cold-start retry
- **AND** user B's cell and traffic are unaffected

#### Scenario: anonymous readiness probe at /api/ready

- **WHEN** an unauthenticated GET /api/ready arrives at the gateway
- **THEN** the gateway SHALL answer 200 with the same readiness payload as /healthz (no redirect to login, no 401, no cell involved)
