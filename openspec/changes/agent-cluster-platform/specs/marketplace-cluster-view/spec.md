# marketplace-cluster-view Specification

## Purpose

Enhances the pack marketplace with cluster-level visibility, browsing, and installation experiences.

## ADDED Requirements

### Requirement: Marketplace browse supports cluster filtering

The marketplace listing page SHALL offer filter controls for:
- **Cluster size**: Show only packs with N agents (e.g., "1 agent", "2-3 agents", "4+ agents")
- **Default activation**: Toggle "Show clusters with auto-activated agents"
- **Category**: Filter by curation category (existing) + new "Cluster type" filter (e.g., "Analysis", "Automation", "Creative")

The filters SHALL be stateful in the URL query parameters (e.g., `?size=3&auto=true&type=analysis`) and persist across page refreshes.

#### Scenario: Cluster size filter applied

- **WHEN** a user selects "2-3 agents" filter in the marketplace
- **THEN** only packs with 2 or 3 agents are displayed; packs with 1 or 4+ agents are hidden

#### Scenario: Filter state in URL

- **WHEN** a user applies multiple filters and refreshes the page
- **THEN** the same filters are re-applied automatically via URL query parameters

### Requirement: Pack detail shows cluster composition

When a pack has cluster metadata, its detail view SHALL include:
- **Cluster header**: Display cluster name, description, and total agent count prominently at the top
- **Agent list**: Table showing each agent's id, role (default/optional), and brief description
- **Install preview**: Summary of what will be installed ("Installing 3 agents from Finance Cluster v1.2")
- **Example prompts**: If the cluster declares `card.examples`, show them as one-click starters

The agent list SHALL be expandable/collapsible; by default, only default agents are shown, with an "Show optional agents" toggle.

#### Scenario: Cluster header on pack detail

- **WHEN** a user opens the detail view of a pack with cluster metadata
- **THEN** the page displays a prominent cluster header with name, description, and agent count

#### Scenario: Optional agents toggle

- **WHEN** a user clicks "Show optional agents" on a pack detail page
- **THEN** the table expands to reveal all optional agents with their descriptions

### Requirement: Bulk install progress indicator

When subscribing to a cluster pack, the install flow SHALL:
- Show a progress modal listing all agents being installed
- Display individual status for each agent: "Installing...", "✓ Installed", "✗ Failed"
- Provide an estimated time remaining based on current network speed
- Allow the user to cancel the install (which rolls back all partially-installed agents)

The modal SHALL update in real-time via WebSocket events; upon completion, show a success report with links to:
- "Start using this cluster" → navigate to chat with cluster agents pre-selected
- "View my packs" → navigate to installed packs management page

#### Scenario: Install progress modal shown

- **WHEN** a user subscribes to a cluster pack with 3 agents
- **THEN** a progress modal appears showing all 3 agents with individual status indicators

#### Scenario: Install cancellation rolls back

- **WHEN** a user cancels an ongoing cluster install after 2 agents have been installed
- **THEN** the system uninstalls the 2 partially-installed agents and returns to the pre-install state

### Requirement: Marketplace search supports cluster queries

The marketplace search SHALL support natural language queries that match against:
- Pack name and description (existing)
- Agent names and descriptions (new)
- Cluster descriptions and tags (new)

Examples:
- `"finance agents"` → matches packs with "finance" in cluster name or any agent description
- `"data analysis team"` → matches clusters with these keywords in description
- `"3-agent pack for reporting"` → matches packs with 3 agents and "reporting" in description

Search results SHALL rank cluster packs higher when the query matches cluster-level fields vs. only pack-level fields.

#### Scenario: Search matches agent descriptions

- **WHEN** a user searches for "SEC data extraction" in the marketplace
- **THEN** packs containing an agent with "SEC extraction" in its description are ranked highly

#### Scenario: Cluster keyword boost

- **WHEN** a user searches for "finance team"
- **THEN** packs with "finance team" in their cluster description are ranked higher than those with only matching pack names

---

## MODIFIED Requirements

### Requirement: pack-marketplace (modified)

**MODIFIED**: The detail view action bar SHALL include cluster-specific affordances. For cluster packs, the action bar SHALL add a "Load in chat" button alongside "Subscribe & Install". The "Load in chat" button SHALL be disabled until the pack is subscribed; clicking it while unsubscribed SHALL trigger subscribe first, then navigate to chat.

**Reason**: Streamline the path from discovery to usage for cluster packs.

**Migration**: Non-cluster packs render unchanged; only cluster packs get the new button.

#### Scenario: Load in chat button enabled after subscribe

- **WHEN** a user subscribes to a cluster pack and the install completes
- **THEN** the "Load in chat" button becomes enabled on the pack detail dialog

#### Scenario: Load in chat triggers subscribe if needed

- **WHEN** an unsubscribed user clicks "Load in chat" on a cluster pack detail
- **THEN** the system first subscribes and installs the pack, then navigates to chat with agents pre-selected
