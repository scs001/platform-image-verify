# browser-use Specification（delta）

## MODIFIED Requirements

### Requirement: Each cell owns one shared browser state

Where the lane is local, browser state (tabs, cookies, login state) SHALL be shared by every session of the owning cell or installation, and SHALL NOT cross cells: two users' cells SHALL hold independent browser state. Isolation between cells SHALL be carried by a per-cell browser context, not necessarily by a separate browser process — a pod may serve several cells from one shared browser runtime and one shared driver process, provided each cell's context stays invisible to the others. `BROWSER_LANE=off`, the local/remote/absent supply gate, and the no-silent-redispatch rule for a failed remote endpoint SHALL be unchanged.

#### Scenario: login persists across sessions in one cell

- **WHEN** an agent in session A logs into a site and a later prompt in session B (same cell) revisits that site
- **THEN** the site SHALL present as logged in, without extra configuration

#### Scenario: no cross-cell leakage

- **WHEN** two hosted cells use the browser lane in the same pod
- **THEN** each cell's browser state SHALL remain invisible to the other (cookie, login state, tabs, artifacts), regardless of whether the two cells share one browser process

#### Scenario: supply gate unchanged

- **WHEN** a deployment supplies a local runtime but sets `BROWSER_LANE=off`, or supplies nothing at all
- **THEN** the lane's entry SHALL be omitted from the generated patch exactly as before
