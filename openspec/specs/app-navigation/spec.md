# app-navigation Specification

## Purpose
The application's left sidebar navigation shell: a canonical tab set (including the Bots entry) with exactly one visible panel per selected tab, the chat session list, the label-free drag-drop overlay, a single status-and-settings footer row, and the collapsible desktop navigation rail.

## Requirements

### Requirement: Left sidebar navigation shell with a canonical tab set

The web UI SHALL provide a persistent left sidebar navigation whose entries are rendered from the unified surface registry (per `layout-configuration`) resolved through the deployment→role→user layout chain, with platform predicates applied and arranged into the nav families of `sidebar-nav-families`. The factory `standard-snapshot` preset SHALL render, in this order, six top-level entries — four of them families and two of them standalone tabs:

1. Chat 对话 (standalone)
2. 知识 family `knowledge`: Knowledge 资料库, Resources 成果, Memory 记忆
3. 构建 family `build`: Agents 智能体市场, Tuning 调优
4. 运行 family `run`: Fleets 智能体团队, Machines 机器, Fleet 本机运行时 (desktop-only predicate)
5. Tasks 自动化 (standalone)
6. 接入 family `access`: Apps 应用, Channels 渠道, Zhiyu 智语

Within a family, render order SHALL equal registry order; family order SHALL equal `NAV_FAMILIES` order. The canonical tab set SHALL therefore contain exactly twelve visible entries on the web and thirteen on the desktop shell (which adds Fleet). No surface outside this set SHALL render as a nav tab. These are the application's *work surfaces* — views the user visits to read or produce content. Operational and configuration surfaces SHALL NOT appear as nav tabs: **MCP Servers**, **Skills**, **Models**, **System Status**, **Diagnostics**, and **Delegation** are Settings sections (see `settings-surface`; System Status is `/settings/status`, Diagnostics is a tab inside the status section, Delegation is its own section, and `/skills` resolves to the `mcp` section alias). The build family SHALL additionally carry a footer of secondary Settings shortcut rows rather than tabs (per *Build family footer carries Settings shortcut rows*). The pack marketplace SHALL NOT be a nav entry: the 智能体市场 surface at `/agents` absorbs it as one of its own tabs, and `/packs` redirects into that tab (per *Exactly one pack-market doorway in the product*). The registry SHALL also carry the 蓝图构造间 `blueprints` slug, whose nav entry is retired into the workspace redirect (per `layout-configuration`), so it renders no tab; `/blueprints` and `/studio` continue to redirect out to the facet studio. The legacy "Dashboard" and "Documents" top-level entries SHALL remain absent, and the legacy `/extensions` parent route SHALL NOT be registered.

Each nav entry SHALL correspond to exactly one main-content panel. The Resources panel is the resources page at `/resources`; the Agents panel is the 智能体市场 surface at `/agents`, whose internal tabs are governed by `agent-catalog`; the Tuning panel is the tuning surface at `/tuning` (skill-candidate review plus persona revision); the Channels panel is the channels surface at `/channels`. The routes (`/chat`, `/knowledge`, `/resources`, `/memory`, `/agents`, `/tuning`, `/fleets`, `/machines`, `/fleet`, `/tasks`, `/apps`, `/channels`, `/zhiyu`) SHALL follow the existing rule that the registry slug IS the route segment, and SHALL NOT change as a result of regrouping. On initial load the UI SHALL activate the Chat tab. The sidebar session-list region SHALL remain visible regardless of which nav entry is active, and SHALL carry a visible project switcher above the session list (per `sidebar-workspaces`).

The displayed label of each entry SHALL be resolved from the i18n bundle keyed by the registry's stable slug, so the label follows the active locale while the entry's identity, icon, and testid are stable. The zh-CN display names SHALL be user-language — Chat 对话, Knowledge 资料库, Resources 成果, Memory 记忆, Agents 智能体市场, Tuning 调优, Fleets 智能体团队, Machines 机器, Fleet 本机运行时, Tasks 自动化, Apps 应用, Channels 渠道, Zhiyu 智语 — with the family names 知识 / 构建 / 运行 / 接入. Preset resolution SHALL be able to hide or reorder entries (per `layout-configuration`), never to add surfaces absent from the registry; platform predicates are absolute, so no preset can conjure the desktop `fleet` entry in a browser. Retired and legacy routes SHALL keep resolving so no stored deep link dead-ends: `/documents` → `/knowledge`, `/bots` → `/channels`, `/settings/channels` → `/channels`, `/trace` → the Settings diagnostics tab (inside the status section), `/dashboard` → `/settings/status`, and `/models`, `/mcp`, `/skills`, `/extensions` → their corresponding Settings sections.

#### Scenario: initial load shows the Chat tab

- **WHEN** the page loads with no layout data anywhere (factory preset) in a browser
- **THEN** the sidebar SHALL render the six top-level entries Chat, 知识〔资料库·成果·记忆〕, 构建〔智能体市场·调优〕, 运行〔智能体团队·机器〕, Tasks, 接入〔应用·渠道·智语〕 in that order
- **AND** the total number of visible nav entries SHALL be twelve
- **AND** the Chat tab SHALL be the active tab
- **AND** the Chat panel SHALL be visible and all other panels SHALL be hidden
- **AND** no Extensions, Dashboard, Documents, Bots, Trace, Blueprints, or Packs top-level entry SHALL be present

#### Scenario: canonical top-level order and family membership

- **WHEN** the sidebar renders under the factory preset
- **THEN** the render order SHALL equal the `NAV_FAMILIES` order: the standalone Chat entry, family `knowledge`, family `build`, family `run`, the standalone Tasks entry, family `access`
- **AND** family `knowledge` SHALL contain knowledge, resources, memory; family `build` SHALL contain agents, tuning; family `run` SHALL contain fleets, machines, fleet; family `access` SHALL contain apps, channels, zhiyu
- **AND** within each family the member order SHALL equal registry order
- **AND** no nav entry SHALL sit outside this set

#### Scenario: desktop shell adds 本机运行时

- **WHEN** the sidebar renders inside the desktop shell
- **THEN** family `run` SHALL contain three entries and the total visible nav entries SHALL be thirteen
- **AND** the desktop-only entry SHALL be labelled 本机运行时 (Local Runtime) at `/fleet`

#### Scenario: fleet hidden on web by platform predicate

- **WHEN** the sidebar renders in a browser (not the desktop shell)
- **THEN** the 本机运行时 entry SHALL be absent even if a preset lists it
- **AND** family `run` SHALL render its remaining members without a placeholder row

#### Scenario: canonical tab ordering and labels

- **WHEN** the sidebar renders under the factory preset
- **THEN** each entry SHALL display a label resolved from the `common` i18n bundle under a stable key, alongside a stable icon and testid
- **AND** the entry's stable identifier and ordering SHALL NOT change when the active locale changes
- **AND** the zh-CN labels SHALL read 对话, 资料库, 成果, 记忆, 智能体市场, 调优, 智能体团队, 机器, 本机运行时, 自动化, 应用, 渠道, 智语
- **AND** the zh-CN family labels SHALL read 知识, 构建, 运行, 接入
- **AND** the entry formerly labelled 机群 SHALL read 本机运行时 while keeping the slug `fleet` and its testid

#### Scenario: routes follow the registry slug

- **WHEN** the user activates any nav entry
- **THEN** the router SHALL navigate to `/<slug>` for that registry slug
- **AND** the panel for that slug SHALL render
- **AND** regrouping SHALL NOT rename any route

#### Scenario: 调优 is reachable from the nav

- **WHEN** the user opens the sidebar
- **THEN** a 调优 entry SHALL be present in family `build`
- **AND** activating it SHALL render the tuning surface at `/tuning`
- **AND** the tuning surface SHALL no longer be reachable only by typing its URL

#### Scenario: 渠道 moves from Settings into the access family

- **WHEN** the user opens the sidebar and then the Settings modal
- **THEN** a 渠道 entry SHALL be present in family `access` at `/channels` and SHALL render the channels surface
- **AND** the Settings modal SHALL NOT carry a channels section
- **AND** `/settings/channels` and `/bots` SHALL redirect to `/channels` so legacy links do not dead-end

#### Scenario: Documents tab renamed to Knowledge

- **WHEN** the user views the sidebar in any locale
- **THEN** the documents-library entry SHALL read Knowledge (zh-CN: 资料库) at `/knowledge`
- **AND** `/documents` SHALL redirect to `/knowledge` so legacy deep links do not 404

#### Scenario: Agents tab opens the builder hub

- **WHEN** the user activates the 智能体市场 entry, or navigates directly to `/agents`
- **THEN** the 智能体市场 surface SHALL render at `/agents`, keeping the slug `agents`, its icon, and its testid unchanged
- **AND** the four-zone builder hub this entry used to open SHALL NOT render — authoring lives in the facet studio, reached through this surface's explicit outbound entry

#### Scenario: Extensions parent is absent

- **WHEN** the user navigates to `/extensions`, `/extensions/mcp`, or `/extensions/skills`
- **THEN** the router SHALL redirect to the corresponding Settings section
- **AND** no Extensions parent page SHALL be rendered

#### Scenario: configuration surfaces are absent from the nav

- **WHEN** the sidebar renders
- **THEN** no nav tab SHALL be present for MCP Servers, Skills, Models, System Status, Diagnostics, or Delegation
- **AND** those surfaces SHALL be reachable only as Settings sections (per `settings-surface`) or, for MCP Servers, Skills, and Models, as the build-family shortcut rows (per *Build family footer carries Settings shortcut rows*)

#### Scenario: legacy routes still resolve

- **WHEN** the user opens `/documents`, `/bots`, `/settings/channels`, `/trace`, `/dashboard`, `/models`, `/mcp`, `/skills`, `/extensions`, `/packs`, `/blueprints`, or `/studio`
- **THEN** `/documents` SHALL land on `/knowledge`; `/bots` and `/settings/channels` on `/channels`
- **AND** `/trace` SHALL open the Settings diagnostics tab inside the status section, and `/dashboard` SHALL open `/settings/status`
- **AND** `/models`, `/mcp`, `/skills`, and `/extensions` SHALL open their corresponding Settings sections
- **AND** `/packs` SHALL land on the corresponding tab of the `/agents` surface
- **AND** `/blueprints` and `/studio` SHALL redirect out to the facet studio
- **AND** no such legacy link SHALL 404 or dead-end

#### Scenario: Resources tab opens the resources page

- **WHEN** the user clicks the Resources entry, or navigates directly to `/resources`
- **THEN** the resources page SHALL render as the active panel

#### Scenario: 智能体市场 opens the market surface

- **WHEN** the user clicks the 智能体市场 entry, or navigates directly to `/agents`
- **THEN** the 智能体市场 surface SHALL render as the active panel
- **AND** the entry's slug, icon, and testid SHALL be unchanged from the previous 智能体 entry

#### Scenario: resolved layout hides a tab

- **WHEN** the resolved layout for a user omits the Apps entry
- **THEN** the sidebar renders family `access` without the Apps entry and `/apps` deep links still resolve (hidden surfaces keep their routes; only the entry disappears)

#### Scenario: preset cannot defeat a platform predicate

- **WHEN** a preset orders or lists the `fleet` slug while the app runs in a browser
- **THEN** no 本机运行时 entry SHALL render

### Requirement: Selecting a tab shows its panel and hides the others
The UI SHALL switch the main content area to the selected tab's panel when the user clicks a sidebar tab. The previously active panel SHALL be hidden. The active tab SHALL be visually distinguished from inactive tabs.

#### Scenario: user switches tabs
- **WHEN** the user clicks the "Documents" tab while the Chat tab is active
- **THEN** the Documents panel SHALL become visible
- **AND** the Chat panel SHALL be hidden
- **AND** the "Documents" tab SHALL be marked active and the "Chat" tab SHALL be marked inactive

#### Scenario: only one panel visible at a time
- **WHEN** any tab is active
- **THEN** exactly one main-content panel SHALL be visible
- **AND** no two panels SHALL be visible simultaneously

### Requirement: Chat session list in the sidebar
The sidebar SHALL render a Workspaces session region containing a "+ New
chat" action, a Workspaces header (per the `sidebar-workspaces` capability),
and the persisted chat sessions grouped by their recorded workspace, each
row showing its title and last-updated time. The currently active session
SHALL be visually distinguished. Clicking a session row SHALL switch the
active chat to that session (governed by the `chat-history` capability). The
session list SHALL be refreshed when sessions are created, switched, or
updated. The "+ New chat" action SHALL navigate the main content area to the
chat view (the `/chat` route in the SPA) regardless of which view is
currently active, so the user lands on the fresh chat immediately; creating a
new chat from a non-chat view SHALL switch the user to the chat view rather
than leaving them on the current view.

#### Scenario: session list renders in the sidebar
- **WHEN** the page loads with one or more persisted sessions
- **THEN** the sidebar SHALL list each session's title and last-updated
  time, grouped under its recorded workspace
- **AND** the active session SHALL be highlighted

#### Scenario: new chat from the sidebar while on the chat view
- **WHEN** the user clicks "+ New chat" while the chat view is active
- **THEN** a new chat session SHALL be created and become the active session
- **AND** the session list SHALL refresh with the new session highlighted
- **AND** the main content area SHALL remain on the chat view

#### Scenario: new chat from a non-chat page
- **WHEN** the user clicks "+ New chat" while a non-chat view (e.g. Documents, Dashboard, History) is active
- **THEN** a new chat session SHALL be created and become the active session
- **AND** the main content area SHALL navigate to the chat view
- **AND** the session list SHALL refresh with the new session highlighted

#### Scenario: selecting a session switches chats
- **WHEN** the user clicks a session row
- **THEN** that session SHALL become the active chat
- **AND** its messages SHALL be rendered in the chat view

### Requirement: Drag-drop overlay is subtle and label-free
The drag-drop overlay SHALL NOT display a prominent text label such as "Drop files to add to documents". Drop feedback SHALL be conveyed by a transient toast and the chat-view document banner; the overlay, if shown during a drag, SHALL be a subtle visual affordance without prominent text.

#### Scenario: dragging a file shows no prominent label
- **WHEN** the user drags a file over the page
- **THEN** the overlay SHALL NOT display a prominent text label
- **AND** drop feedback SHALL be conveyed by the toast and/or the chat-view document banner

### Requirement: Sidebar footer is a single status-and-settings row
The sidebar footer SHALL contain exactly one row holding two elements: a connection-status indicator (a coloured dot plus a label reflecting the `connecting` / `connected` / `disconnected` states) and a settings button bearing a gear icon. Activating the settings button SHALL open the Settings modal (see `settings-surface`). The footer SHALL NOT contain an agent selector, a model chip, a "Clear chat" button, or a locale selector. The footer SHALL be present on every page, independent of the active view tab, because it is part of the persistent sidebar shell.

#### Scenario: footer renders only the status indicator and the gear
- **WHEN** the sidebar renders on any route
- **THEN** the footer SHALL display a connection-status indicator and a settings gear button
- **AND** the footer SHALL NOT render an agent selector, a model chip, a "Clear chat" button, or a locale selector

#### Scenario: gear opens the Settings modal
- **WHEN** the user activates the settings gear button in the footer
- **THEN** the Settings modal SHALL open (per `settings-surface`)
- **AND** the view the user was on SHALL remain rendered beneath the modal

#### Scenario: status indicator tracks the connection
- **WHEN** the WebSocket connection state changes between `connecting`, `connected`, and `disconnected`
- **THEN** the footer status indicator SHALL update its dot colour and its localized label to match the new state

### Requirement: The desktop navigation rail is collapsible
On md+ viewports the sidebar rail SHALL be collapsible: a toggle in the
sidebar header collapses the rail, a re-expand affordance SHALL remain
reachable while collapsed (pinned at the top of the content area), and
Ctrl/Cmd+B SHALL toggle the rail in both directions. The collapsed state
SHALL persist across reloads per browser. Navigation content (tab set,
session region, footer) is unchanged, and the below-md off-canvas drawer
SHALL behave exactly as before.

#### Scenario: collapse from the header toggle
- **WHEN** the user clicks the collapse toggle on a desktop viewport
- **THEN** the rail collapses and the content column takes the full width

#### Scenario: restore while collapsed
- **WHEN** the rail is collapsed and the user clicks the pinned re-expand
  affordance
- **THEN** the rail is restored with the same nav content

#### Scenario: keyboard toggle
- **WHEN** the user presses Ctrl/Cmd+B on a desktop viewport
- **THEN** the rail toggles between collapsed and expanded

#### Scenario: collapse persists across reloads
- **WHEN** the user collapses the rail and reloads the page on the same
  browser
- **THEN** the rail loads collapsed

#### Scenario: narrow viewport keeps the drawer
- **WHEN** the viewport is below md
- **THEN** the collapse toggle is not shown and the off-canvas drawer works
  as before

### Requirement: Workbench customization entry

The sidebar footer area SHALL offer a workbench customization entry (工作面定制) that opens the user's layout adjustment surface (per `layout-configuration`): toggling visibility and reordering of the surfaces visible to that user, plus a restore control returning the inherited layout. The entry SHALL be present for every user regardless of preset, operating only within the user-adjustment bounds defined by `layout-configuration`.

#### Scenario: entry visible for every user

- **WHEN** the sidebar renders for any authenticated user
- **THEN** the workbench customization entry SHALL be present and open the adjustment surface on activation

#### Scenario: adjustment bounded by inherited layout

- **WHEN** a surface is hidden by the user's role or deployment layer
- **THEN** the adjustment surface does not list it, and no control exists to re-reveal it

### Requirement: Build family footer carries Settings shortcut rows

The 构建 family SHALL render, beneath its member entries, a footer of secondary shortcut rows that open Settings sections: 工具 / MCP → `/settings/mcp`, 插件 → `/settings/plugins`, 模型 → `/settings/models`, with labels resolved from the i18n bundle. These rows are navigation shortcuts, not surfaces: they SHALL NOT be nav tabs, SHALL NOT be registry nav surfaces, SHALL NOT count toward the canonical tab set, and SHALL NOT participate in preset hide/reorder of surfaces. Activating a row SHALL open the Settings modal at that section while the currently active nav entry stays active and its panel stays rendered beneath the modal. A row SHALL be rendered only when its target Settings section is visible in the resolved layout, so a row never opens a section the deployment hides.

#### Scenario: footer rows render under the build family

- **WHEN** the sidebar renders under the factory preset in any locale
- **THEN** family `build` SHALL show its member entries followed by the shortcut rows 工具 / MCP, 插件, 模型
- **AND** the rows SHALL be visually secondary to the family's member entries

#### Scenario: shortcut opens the Settings section

- **WHEN** the user activates the 模型 row while on the Chat panel
- **THEN** the Settings modal SHALL open at the models section
- **AND** the Chat entry SHALL remain the active nav entry with the Chat panel rendered beneath the modal
- **AND** the router SHALL NOT leave the current work route

#### Scenario: shortcut rows are not nav entries

- **WHEN** the canonical tab set is counted or enumerated
- **THEN** the three shortcut rows SHALL be excluded
- **AND** no shortcut row SHALL be selectable as an active tab

#### Scenario: shortcut follows Settings visibility

- **WHEN** the resolved layout hides the `plugins` Settings section from the user
- **THEN** the 插件 row SHALL be absent and no other row SHALL substitute for it

### Requirement: Exactly one pack-market doorway in the product

The `/packs` route SHALL NOT be a nav tab and SHALL NOT carry a nav entry of its own. The pack marketplace (market, 我的包, 创作草稿与发布) SHALL be a tab of the 智能体市场 surface at `/agents`, and `/packs` together with its former sub-routes SHALL redirect into the corresponding tab of that surface so no pack link dead-ends. The product SHALL expose exactly one in-product pack-market doorway — that tab — plus the explicit external facet-market link; no second in-product market entry (a duplicate nav entry, a duplicate market panel, or a duplicated 我的包 area) SHALL exist. The external facet-market link SHALL be presented as an explicit outbound link and SHALL be the only door leaving the product for the marketplace.

#### Scenario: /packs deep link lands inside the market surface

- **WHEN** the user opens `/packs`, or a stored link to a former packs sub-route such as the 我的包 or 创作草稿 area
- **THEN** the router SHALL land on the `/agents` surface with the matching tab active
- **AND** the link SHALL NOT 404 and SHALL NOT render a standalone packs page

#### Scenario: one in-product market doorway

- **WHEN** the user looks for the pack marketplace from the nav
- **THEN** the sidebar SHALL expose no packs entry
- **AND** the only in-product market doorway SHALL be the market tab of the `/agents` surface
- **AND** the external facet-market link SHALL be the sole outbound doorway to the marketplace

#### Scenario: no duplicated market panel

- **WHEN** the resolved layout includes the `agents` entry
- **THEN** the market content SHALL render in exactly one place inside the product
- **AND** no other nav entry or Settings section SHALL render a second market or 我的包 listing
