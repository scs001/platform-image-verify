# pack-marketplace Specification

## Purpose
A gateway-level registry where identity-gated creators publish versioned capability packs (skills + MCP references + agent personas) and every authenticated user can browse, inspect, and subscribe to them — the marketplace layer that makes packs shareable across users.

## Requirements

### Requirement: Publishing is identity-gated

Publishing SHALL be allowed only for authenticated users whose platform groups include the configured creator group (default `creators`), unless the deployment's access mode is `open`. The access mode SHALL be read from `PACK_ACCESS_MODE` with `closed` as the default; in `closed` mode the creator-group gate applies exactly as before (byte-identical refusals), and in `open` mode any authenticated user MAY publish — the creator group remains required for nothing on this path. Every other user SHALL receive a rejection. The gateway SHALL stamp the publishing user's identity and the publish time onto the stored version; the manifest itself SHALL NOT carry author-controlled identity claims. Both arrival surfaces — the cell-assembled flow on 壹座 and the publish-from-manifest flow on the facet surface — SHALL pass through the same gate and the same manifest validation.

#### Scenario: Creator publishes

- **WHEN** a user whose groups include `creators` submits a valid pack manifest to the publish endpoint
- **THEN** the pack is stored and the response returns its identifier and version

#### Scenario: Non-creator is rejected

- **WHEN** a user without the creator group submits a manifest to the publish endpoint in `closed` mode
- **THEN** the gateway rejects the request with an authorization error and stores nothing

#### Scenario: Manifest publish and cell-assembled publish share the gate

- **WHEN** the same creator publishes the same manifest shape via the facet console and via the 壹座 cell-assembled flow
- **THEN** both pass the identical identity gate and manifest validation, and both store versions stamped with the same author identity

#### Scenario: Open access mode admits any authenticated user

- **WHEN** `PACK_ACCESS_MODE=open` and a user without the creator group submits a valid manifest
- **THEN** the pack is stored under that user's identity — the same rate limiter, manifest validation, and tool gate apply unchanged

#### Scenario: Closed remains the default

- **WHEN** `PACK_ACCESS_MODE` is unset (or any value other than `open`) and a non-creator publishes
- **THEN** the refusal is byte-identical to the pre-change contract

### Requirement: Published versions are immutable

Each publish SHALL create a new immutable version of the pack with a monotonically increasing version number; published manifests SHALL never be modified afterward. Every stored version SHALL remain retrievable. An author MAY unpublish a pack, which unlists it (hidden from browse and detail for new fetches) but SHALL NOT alter or delete already-published versions or affect installed snapshots in subscribers' cells.

#### Scenario: Second publish bumps the version

- **WHEN** the author of an existing pack publishes a changed manifest
- **THEN** the pack gains a new version number and the previous version's manifest is unchanged and still retrievable

#### Scenario: Unpublish hides but does not destroy

- **WHEN** the author unpublishes a pack that subscribers have installed
- **THEN** the pack disappears from browse and detail for users who had not installed it
- **AND** subscribers' installed skills, MCP connections, and agents keep working unchanged

### Requirement: Browse, search, and inspect

Every authenticated user SHALL be able to list published packs (name, description, tags, author identity, latest version, last publish time), search them by name or tag, and open a detail view — excluding private packs the requester does not own (openspec: pack-visibility; admins see all). Unauthenticated visitors SHALL be able to list, search, inspect, and download the content of public packs without any account; private and unlisted packs SHALL remain invisible to them. The detail view SHALL return the full manifest of the latest version, including the complete body of every skill, so a subscriber can inspect exactly what will be installed before subscribing; a skill's auxiliary file set SHALL be represented in the detail payload as its file inventory (relative paths), with every file's content fetchable on demand under the same visibility rules as the detail view itself — nothing installed by the pack is hidden from inspection, and no auxiliary content rides the default payload. The detail view SHALL additionally render a usage-guide card when the client's guide content module contains an entry for that pack's id: the card presents the pack's three-step guide (prepare / ask / get) with the pack's own-language body content and i18n-resolved chrome labels. The card is informational only — a pack without guide content SHALL render the detail view exactly as before, with no guide card. The listing SHALL carry each pack's curation category and featured flag, and browsing SHALL offer filtering by category and a featured presentation (openspec: pack-marketplace, Packs carry a curation category and featured flag). Listing summaries SHALL additionally carry `agentCount` (the latest version's declared agent count), and browsing SHALL offer an agent-count filter (1 / 2-3 / 4+) whose state lives in the `agents` URL query parameter; summaries without an agent count pass through unfiltered. When a pack's manifest declares `cluster` metadata, the detail view SHALL render a cluster section — cluster name, description, member count, the default members, and a toggle revealing the optional members (openspec: marketplace-cluster-view); packs without cluster metadata render exactly as before.

The detail view SHALL offer a version-history disclosure: an on-demand, lazily loaded list of the pack's published versions. The version list SHALL NOT be part of the default detail payload — it loads only when the viewer opens the disclosure. Each version row SHALL show the version number, publish time, publisher identity, the version's note when one is present, and links to that version's manifest snapshot and skill bodies. Version history SHALL follow the same visibility rules as the detail view itself: reachable anonymously for public packs, reachable to the owner (and admins) for their own private or unlisted packs, invisible otherwise. Historical versions are read-only: the disclosure offers inspection links only, never an install action for a non-latest version.

#### Scenario: Search by tag

- **WHEN** a user searches the marketplace for the tag `法律`
- **THEN** the listing contains exactly the published packs tagged `法律` visible to that user

#### Scenario: Skill bodies are inspectable before subscribe

- **WHEN** a user opens the detail view of a pack
- **THEN** every skill's full content, every MCP reference with its required group if any, and every agent entry are visible before any install happens

#### Scenario: File inventory rides the detail, contents load on demand

- **WHEN** a user opens the detail view of a pack whose skill carries five auxiliary files
- **THEN** the detail payload lists the five file paths for that skill and does not inline their contents
- **AND** each file's content is fetchable on demand with the detail view's own visibility, including anonymously for public packs

#### Scenario: Anonymous visitors see public packs only

- **WHEN** an unauthenticated visitor browses or searches the marketplace, opens a public pack's detail, or downloads a skill body
- **THEN** public packs are listed, inspectable, and downloadable without a credential
- **AND** private packs and unlisted packs are absent from every response

#### Scenario: Guide card renders for a covered pack

- **WHEN** the user opens the detail view of a pack whose id has guide content in the client content module
- **THEN** the detail view SHALL show the usage-guide card with the pack's three-step guide
- **AND** the card SHALL offer no subscribe, install, or navigation actions

#### Scenario: No card for uncovered packs

- **WHEN** the user opens the detail view of a pack without guide content
- **THEN** the detail view SHALL render exactly as before, with no guide card

#### Scenario: Filtering by curation category

- **WHEN** a visitor filters the market listing by a category
- **THEN** only packs whose curation category matches are listed, and featured packs appear in the featured rail first

#### Scenario: Version history loads on demand and stays out of the default payload

- **WHEN** a viewer opens a public pack's detail view
- **THEN** the version-history disclosure is present but its content is not yet fetched, and the default detail payload carries no version list
- **AND** opening the disclosure loads the versions, each row showing version number, publish time, publisher, note when present, and manifest/skill links for that version

#### Scenario: Version history is anonymously reachable for public packs

- **WHEN** an unauthenticated visitor opens the version-history disclosure of a public pack
- **THEN** the version list and every per-version link resolve without a credential

#### Scenario: Version history respects pack visibility

- **WHEN** a pack is private or unlisted
- **THEN** its version history is reachable only by the owner (and admins), consistent with the detail view's visibility rules

#### Scenario: History is inspect-only

- **WHEN** a viewer opens the version-history disclosure of any pack
- **THEN** the rows offer inspection links only, with no install action for a non-latest version

#### Scenario: Agent-count filter narrows the listing

- **WHEN** a visitor selects the 2-3 agents bucket
- **THEN** only packs whose latest version declares two or three agents are listed, and a refresh keeps the bucket via `?agents=`

#### Scenario: Cluster section on a cluster pack's detail

- **WHEN** a user opens the detail view of a pack whose manifest declares `cluster`
- **THEN** the view shows the cluster name, description, member count, and default members, with the optional members behind a toggle

### Requirement: Manifest validation and limits

The publish endpoint SHALL validate the manifest shape and reject invalid publishes with a machine-readable reason: skill entries SHALL have well-formed unique names and bounded content; a skill entry MAY carry an auxiliary file set (relative path to text content) and a stored frontmatter object, admitted under the platform's package contract — paths that escape the skill directory, non-text file kinds, file names colliding with the rendered skill document under case-insensitive filesystems, an auxiliary file beyond the per-file bound, or an aggregate beyond the per-skill bound (file count or total size) are each rejected naming the offending entry; MCP entries SHALL be registry-name references only (any endpoint URL or command config SHALL be rejected); agent entries SHALL be persona-only (any endpoint, model, or credential reference SHALL be rejected) and their ids SHALL NOT fall under the `user.` prefix (reserved for the cell's custom presets — openspec: custom-presets); an agent entry's resource declaration SHALL name only skills and MCP references that the same manifest declares, with no duplicated names within one declaration (violations SHALL be rejected naming the role and entry); the manifest as a whole SHALL stay within per-pack size and count limits. A manifest MAY carry an optional top-level `notes` field — a string of at most 500 characters serving as the human-readable version note; a `notes` value that is not a string or exceeds the limit SHALL be rejected with a reason naming the field. Once published, the note is part of the immutable version (openspec: pack-marketplace, Published versions are immutable). The cell's install path SHALL enforce the same rules on the manifest it receives.

#### Scenario: MCP entry with an endpoint URL is rejected

- **WHEN** a publish contains an MCP entry carrying a `url` or command config
- **THEN** the publish is rejected with a reason naming the offending entry

#### Scenario: Agent entry with an endpoint is rejected

- **WHEN** a publish contains an agent entry carrying `baseUrl`, `model`, or `apiKeyEnv`
- **THEN** the publish is rejected with a reason naming the offending entry

#### Scenario: Oversized skill is rejected

- **WHEN** a publish contains a skill body exceeding the per-skill content limit
- **THEN** the publish is rejected with a reason naming the offending skill

#### Scenario: Path-escaping auxiliary file is rejected

- **WHEN** a publish contains a skill entry whose auxiliary file set carries a path with `..` segments or an absolute path
- **THEN** the publish is rejected with a reason naming the offending skill and path

#### Scenario: Oversized auxiliary file is rejected

- **WHEN** a publish contains a skill entry with an auxiliary file beyond the per-file size bound
- **THEN** the publish is rejected with a reason naming the offending skill and file

#### Scenario: Auxiliary aggregate bound is enforced

- **WHEN** a publish contains a skill entry whose auxiliary file set exceeds the per-skill file-count or total-size bound
- **THEN** the publish is rejected with a reason naming the offending skill and the exceeded bound

#### Scenario: Skill-document name collision is rejected

- **WHEN** a publish contains a skill entry whose auxiliary file set carries a file whose name is a case variant of the skill document's own name
- **THEN** the publish is rejected with a reason naming the offending skill and file

#### Scenario: Role declaration naming an undeclared resource is rejected

- **WHEN** a publish contains an agent entry whose resource declaration names a skill or MCP reference not present in the manifest's own lists
- **THEN** the publish is rejected with a reason naming the role and the unknown name

#### Scenario: Duplicated declaration entry is rejected

- **WHEN** a role's resource declaration lists the same skill or MCP name twice
- **THEN** the publish is rejected with a reason naming the role and the duplicate

#### Scenario: Reserved-prefix agent id is rejected

- **WHEN** a publish contains an agent entry whose id starts with `user.`
- **THEN** the publish is rejected with a reason naming the entry and the reserved namespace

#### Scenario: Oversized version notes are rejected

- **WHEN** a publish carries a `notes` value longer than 500 characters
- **THEN** the publish is rejected with a machine-readable reason naming the `notes` field, and nothing is stored

#### Scenario: Non-string version notes are rejected

- **WHEN** a publish carries a `notes` value that is not a string
- **THEN** the publish is rejected with a machine-readable reason naming the `notes` field, and nothing is stored

#### Scenario: Notes are optional

- **WHEN** a publish carries no `notes` field
- **THEN** the publish proceeds exactly as before, and the version renders with no note

### Requirement: Publish abuse controls

The publish endpoint SHALL apply per-author rate limiting and a request payload cap. Rejected or throttled publishes SHALL store nothing.

#### Scenario: Rapid publishes are throttled

- **WHEN** an author exceeds the per-author publish rate limit
- **THEN** further publishes are rejected with a throttling error and nothing is stored

### Requirement: Pack registry lives at the facet service

Published packs SHALL be stored in the independently deployed facet service's registry (openspec: facet-platform), separate from every cell's data and from 壹座's own state, keyed by an unguessable server-minted identifier carrying no author-identifying structure. A published pack SHALL remain listed and fetchable regardless of whether the author's cell is running and regardless of whether any 壹座 process is running. The identifier SHALL NOT be derived from the pack name or author identity.

#### Scenario: Pack outlives the author's cell

- **WHEN** a published pack's author has their cell stopped or reaped, or 壹座 itself is down, and another user browses the marketplace on the facet domain
- **THEN** the pack is listed and its manifest is fetchable exactly as before

#### Scenario: Pack identifier is unguessable

- **WHEN** a pack is published
- **THEN** the returned identifier is server-generated random with at least 96 bits of entropy and reveals nothing about the author or name without a registry lookup

### Requirement: Subscription records at the facet service

Subscribing and unsubscribing SHALL be recorded at the facet service keyed by the subscribing user's identity and the pack. These records power listing and count features; they are advisory for the subscriber's cell, whose own installed-pack state remains the operational truth for what is materialized there.

#### Scenario: Subscribe is recorded

- **WHEN** an authenticated user subscribes to a pack
- **THEN** a subscription record exists at the facet service for that user and pack with the subscribed version and time

#### Scenario: Author sees a subscriber count

- **WHEN** a creator opens the detail of their own published pack
- **THEN** the current subscriber count is visible

### Requirement: Preset-to-service one-click flow

壹座 SHALL offer a single user-initiated action from a cell's custom preset that composes the existing pieces — the preset-to-draft bridge, draft publish, and serving deploy — into one flow: the action presents the composed pack draft for confirmation (name, description, and an optional version note editable), publishes it as a new pack or a new version, and, when the resulting agent entry carries a serving contract, offers deploy as the final step of the same flow. Failure at any step SHALL stop the flow with the failed step named, and no later step SHALL run. The optional version note rides the publish under the same `notes` contract as the manifest field; an empty note publishes a manifest without the field.

#### Scenario: One action takes a preset to a published pack

- **WHEN** a user invokes the flow on their custom preset and confirms the composed draft
- **THEN** the pack is published and visible in the marketplace without the user visiting separate draft and publish surfaces

#### Scenario: Serving contract offers deploy in the same flow

- **WHEN** the flow publishes a pack whose agent entry carries a serving contract and the user chooses deploy
- **THEN** the deploy runs under the a2a-agent-serving deploy contract and the flow reports its result

#### Scenario: Failure stops with the failing step named

- **WHEN** any step of the flow fails (draft composition, publish, or deploy)
- **THEN** the flow stops with an error naming the failed step and no later step runs

#### Scenario: A version note rides the one-click publish

- **WHEN** the user fills the optional version note at the confirmation step and publishes
- **THEN** the published version carries the note and its version-history row shows it
- **AND** leaving the note empty publishes a manifest without a `notes` field

### Requirement: Claude marketplace manifest endpoint

The facet service SHALL serve a public, unauthenticated endpoint in the Claude Code plugin-marketplace format (`.claude-plugin/marketplace.json` semantics) that lists public curated packs as installable plugin entries. **Curated SHALL mean the pack carries a non-empty `category` or a true `featured` flag — the same curation signals the browse face consumes** — unless the operator whitelist (`FACET_MARKETPLACE_PACK_IDS`) is set, in which case the whitelist alone defines the listing (override semantics, applied instead of — not intersected with — the curation filter). Each entry SHALL expose the pack's skills as plugin skill content fetchable without an account; MCP references SHALL appear as connection guidance (endpoint and credential notice) only, and SHALL NOT be embedded as server configuration in the plugin body. Private and unlisted packs SHALL be absent. Uncurated public packs SHALL be absent from the listing while their plugin tree files remain fetchable by direct version URL (listing governs discovery, not access). The endpoint SHALL reflect the current listing state on refresh, with cache headers no longer than one hour.

#### Scenario: One command adds the marketplace

- **WHEN** a Claude Code user runs the plugin-marketplace add command against the facet endpoint
- **THEN** the marketplace is added and its curated packs are browsable and installable as plugins

#### Scenario: MCP stays guidance, never embedded server config

- **WHEN** a listed pack declares MCP server references
- **THEN** the plugin README SHALL carry connection guidance (endpoint and credential notice) only
- **AND** the plugin body SHALL NOT embed server configuration

#### Scenario: Non-public packs never appear

- **WHEN** a pack is private or unlisted
- **THEN** it SHALL be absent from the listing and its plugin tree files SHALL return not-found

#### Scenario: Uncurated public packs stay off the listing

- **WHEN** a public non-unlisted pack has an empty `category` and a false `featured` flag and no operator whitelist is set
- **THEN** the marketplace listing SHALL omit the pack
- **AND** its plugin tree files SHALL remain fetchable by direct version URL

#### Scenario: Operator whitelist overrides curation

- **WHEN** `FACET_MARKETPLACE_PACK_IDS` is set to a comma-separated list of pack ids
- **THEN** the listing SHALL contain exactly those packs that are public and non-unlisted
- **AND** packs on the whitelist SHALL be listed even without a category or featured flag
- **AND** the curation filter SHALL NOT further narrow the whitelist

### Requirement: The detail view renders the pack's guide with a manifest-first chain

The detail view's usage-guide card SHALL resolve its content in order: the pack's own `manifest.guide` when present, else the client guide content module for that pack id, else no card. The card's chrome labels SHALL resolve from the i18n bundle while step text renders as the creator's own-language content. When the client content module holds example prompts for the pack, the card SHALL additionally list up to four example questions (read-only text) beneath the steps; packs without example content show steps only. Neither the guide card nor the examples add any subscribe, install, or navigation action.

#### Scenario: manifest guide wins over client content

- **WHEN** a pack's manifest carries a guide and the client module also has content for its id
- **THEN** the detail view renders the manifest's three steps

#### Scenario: client module still covers launch packs

- **WHEN** a pack without a manifest guide has client-module content
- **THEN** the detail view renders the client module's steps as before

#### Scenario: example questions render when available

- **WHEN** the rendered pack has example prompts in the client content module
- **THEN** up to four example questions appear beneath the guide steps as read-only text

### Requirement: Subscribing ends with a next-steps wizard

The subscribe success report panel SHALL append a next-steps footer that takes the user straight into a conversation with what they just installed — no manual re-selection step:

- 单角色功能集：footer 的按钮 SHALL 携带该功能集默认角色的 agent 标识导航到
  `/chat?preset=<agentId>`（openspec: web-chat-ui, 非 embed 导航的预设深链），
  对话页在连接就绪后自动选中该角色；hint 文案 SHALL 不再指示用户手动去
  「上方选择框」选人。
- 多角色且声明集群元数据的功能集：footer SHALL 以「去对话并载入整组」为
  主按钮，导航携带该集群的 lead 角色标识与整组载入意图，落地后按既有动态
  集群路径绑定会话并切到 lead（openspec: agent-preset-selection, 统一的
  「与谁对话」选人面）；无可用 lead（如全部角色安装失败）时按钮退化为普通
  「打开对话」。
- 无角色条目的功能集（纯技能/工具包）：footer 保持普通「打开对话」按钮
  （裸导航），hint 说明能力已就绪。

footer 保留与报告一致的关闭（dismiss）语义；报告本身的逐部件状态、脱敏与
关闭行为（openspec: pack-installation）不变。On the facet shell — where no
conversation view exists — the next-steps footer SHALL not render, and the
report panel itself SHALL be unchanged.

#### Scenario: the report offers the next step

- **WHEN** a subscription succeeds for a single-role pack and the report panel renders on 壹座
- **THEN** the panel shows the next-steps footer with an open-chat button carrying `preset=<default agentId>`
- **AND** activating the button navigates to `/chat?preset=<agentId>`, dismisses the report, and the chat auto-selects that role once connected

#### Scenario: cluster pack offers load-the-group

- **WHEN** a subscription succeeds for a pack declaring cluster metadata with a lead role
- **THEN** the footer's primary button is 「去对话并载入整组」 and lands the chat with the cluster bound to the session and the lead role active

#### Scenario: skill-only pack keeps plain navigation

- **WHEN** a subscription succeeds for a pack with no agent entries
- **THEN** the footer shows a plain open-chat button with no `preset` parameter

#### Scenario: the facet report ends without the wizard footer

- **WHEN** a subscription is recorded on the facet shell and the report panel renders
- **THEN** the report panel shows its per-part statuses and close affordance
- **AND** no next-steps footer or open-chat button renders

### Requirement: Packs carry a curation category and featured flag

Each pack SHALL carry a curation category (a short slug, empty when uncategorized) and a featured flag (default not featured). The author MAY declare the category at publish time or from the creator console; admins MAY change both at any time through the curation endpoint. The category and featured flag SHALL be carried by the listing, the latest-version detail, and the Claude plugin marketplace face. Curation state SHALL be presentation-level only: it SHALL NOT affect visibility, immutability of published versions, or installability.

#### Scenario: Admin sets category and feature

- **WHEN** an admin sets a pack's category and features it via the curation endpoint
- **THEN** the listing and detail carry the new category and featured state, and the pack's visibility and versions are unchanged

#### Scenario: Author-declared category rides the publish

- **WHEN** a creator publishes a manifest that declares a category
- **THEN** the stored pack carries that category without any admin action

#### Scenario: Curation never hides or exposes

- **WHEN** a pack is featured or recategorized
- **THEN** its public/private/unlisted visibility semantics are exactly as before curation

### Requirement: The pack detail dialog carries an always-visible action bar

The pack detail dialog SHALL render its primary actions in a bar flush to the dialog's bottom edge — always visible regardless of the content scroll position, opaque, with the scrolling content ending above it (no see-through gap at any scroll position) — carrying the subscribe-and-install primary button and a visible close affordance. The former in-content action placement (the subscribe button at the end of the scrolling flow) SHALL be replaced by this bar. The bar's optional "go to my packs" affordance is host-selected: hosts pass it only where an installed-packs management surface exists (壹座); hosts without one (the facet shell) omit it. An explicit close control SHALL be present in the bar in addition to the existing overlay/Escape dismissal.

#### Scenario: the bar is visible without scrolling

- **WHEN** a visitor opens a pack whose detail content exceeds the dialog's scroll height
- **THEN** the action bar with the subscribe button and the close control is visible immediately, without scrolling

#### Scenario: the close control dismisses the dialog

- **WHEN** the visitor activates the bar's close control
- **THEN** the dialog closes exactly as the overlay or Escape dismissal does

#### Scenario: the facet dialog carries no goto-mine affordance

- **WHEN** the facet shell opens the pack detail dialog
- **THEN** the action bar shows the subscribe button and the close control and no "go to my packs" button

#### Scenario: the close control sits at the dialog's top-right

- **WHEN** the dialog renders
- **THEN** the close control is positioned at the dialog's top-right corner — the conventional spot — and dismisses in one step

#### Scenario: scrim click dismisses in one step

- **WHEN** the visitor clicks the overlay while the dialog is open
- **THEN** the dialog closes (a two-step scrim confirm was tried and reverted — the plain dismissal is the product call)

#### Scenario: the signed-out viewer's goto-mine flips the guidance row

- **WHEN** a host wires both the signed-out signal and the goto-mine affordance and a signed-out visitor activates goto-mine
- **THEN** the login guidance row appears (no silent no-op, no navigation)

#### Scenario: a signed-in viewer's gated buttons fire for real

- **WHEN** the host reports a signed-in viewer
- **THEN** the signed-out path is not wired, and subscribe and goto-mine execute their normal behavior (no login redirect)

### Requirement: Anonymous subscribe attempts get a login guidance bar

When the host reports a signed-out viewer, activating the subscribe-and-install button SHALL NOT emit a raw error: the action bar SHALL surface an inline guidance row — a localized line stating that subscribing and installing require signing in, plus a sign-in action that navigates to the host's login entry (the facet shell: `/auth/login` with a same-origin return path back to the packs market, per the service's existing safe-return handling). Hosts that do not wire the signed-out signal keep the existing authenticated-error fallback unchanged (壹座 users always hold a session; that path is an edge state there, and its error text SHALL be localized rather than raw English).

#### Scenario: anonymous click surfaces the guidance row

- **WHEN** a signed-out visitor activates the subscribe-and-install button on the facet shell
- **THEN** the action bar shows the localized guidance row with a sign-in action, and no raw English error text renders

#### Scenario: sign-in returns to the packs market

- **WHEN** the visitor follows the guidance row's sign-in action and completes login
- **THEN** they land back on the packs market view (`#/packs`)

#### Scenario: hosts without the signal keep their fallback

- **WHEN** the dialog renders on a host that does not pass the signed-out signal and a subscribe call fails with an authentication error
- **THEN** the dialog shows a localized authentication guidance message in its error surface, unchanged in behavior otherwise

### Requirement: The deploy section explains itself in plain language

The pack detail dialog's deploy-as-a-service section SHALL open with a plain-language summary stating what deploying yields (the pack's agents go live as a conversation service: a shareable public chat page, per-round metering, deployer revenue share), and each of its subsections SHALL carry a one-line plain-language subtitle — the metering-key area (whose quota pays for visitor rounds), the rhythm area (whether the platform wakes the agent to act on its own schedule; no entries means it only answers when addressed), the model area (which model the agent thinks with; empty keeps the standing setting — an existing override, else the pack's declared default), and the budget area (the longest a single round may run; empty keeps the standing setting — an existing override, else the declared ceiling or the platform default). The deploy button's outcome expectation (deploying produces a shareable conversation page) SHALL be stated at the button. These explanations are presentation-level: the section's data behavior, permissions, and deploy semantics are exactly as before (openspec: pack-marketplace, deploy requirements; the section stays fully previewable to signed-out visitors).

#### Scenario: the section summary names the outcome

- **WHEN** the deploy section renders
- **THEN** it opens with the plain-language summary of what deploying yields before any control

#### Scenario: subsections carry their subtitles

- **WHEN** the deploy section renders with its metering-key, rhythm, model, and budget areas
- **THEN** each area carries its one-line plain-language subtitle

#### Scenario: the deploy button states its result

- **WHEN** the deploy section renders its deploy button
- **THEN** the expected outcome (a shareable conversation page) is stated adjacent to the button

### Requirement: The deploy form offers deploy-time model and budget choices

The pack detail dialog's deploy-as-a-service section SHALL offer, for each serving-contract agent, a model input and a turn-budget input alongside the existing rhythm override — the deployer composes the deployment's initial service configuration (openspec: a2a-agent-serving, deploy requirements; agent-service-config) in one place instead of deploying first and editing on the serving config surface afterwards. Empty inputs SHALL mean "change nothing on this dimension": a deploy request omits the agent from its model and budget maps entirely, and the deployment's effective values then follow the standing precedence — an existing override preserved from the prior deployment when redeploying (openspec: agent-service-config, upgrade overlay semantics), else the manifest's declaration, else the platform default — byte-identical to the behavior before this form existed. There is no clear-back semantics at deploy time: the form never sends a null (clearing an existing override is the serving config surface's act, not the deploy form's). A filled model input SHALL ride the deploy request as the agent's deploy-time model choice, passing the same write-time validation gates (declared whitelist, billing lanes, runner roster) the deploy action already enforces; a filled budget input SHALL ride as the agent's per-turn budget override under the platform's budget rule (positive whole minutes within the platform cap).

The form SHALL validate the budget input client-side under the platform's budget rule and refuse to submit while it is invalid, naming the rule — a server round-trip must not be the first place a typo meets its error. Model inputs SHALL NOT be client-side lane-validated (lanes are a property of the bound billing key, unknowable in the form before deployment); a declared `modelWhitelist` in the serving contract SHALL surface as autocomplete options with the whitelist named in a hint, and the absence of a whitelist SHALL surface a hint that the choice is validated against the billing key's lanes at submit. A declared serving model or budget ceiling SHALL be visible as the input's placeholder so the deployer sees what an empty input yields. Deploy failures from the model gates SHALL surface as a localized guidance message, never raw transport English.

#### Scenario: The form renders model and budget inputs per serving agent

- **WHEN** the deploy section renders for a pack with a serving-contract agent
- **THEN** the agent's row offers a model input and a turn-budget input next to its rhythm override, each with a plain-language label

#### Scenario: Empty inputs ride no maps and change nothing

- **WHEN** the deployer submits with the model and budget inputs empty — on a first deploy or a redeploy of a pack whose deployment already carries overrides
- **THEN** the deploy request carries no model or budget maps for the agent, and the effective values follow the standing precedence (preserved override when one exists, else the declaration, else the platform default) exactly as before this form existed

#### Scenario: A filled model rides the deploy request and the gate error is localized

- **WHEN** the deployer fills a model and submits, and the choice is refused by a model gate (whitelist, billing lanes, or runner roster)
- **THEN** the deploy section surfaces a localized message naming the refusal, and no deployment is created

#### Scenario: The declared whitelist narrows and explains the input

- **WHEN** the serving contract declares a `modelWhitelist`
- **THEN** the model input offers the whitelist's entries as autocomplete options and names them in its hint

#### Scenario: An invalid budget never leaves the form

- **WHEN** the budget input holds a value that is not a positive whole number of minutes within the platform cap
- **THEN** the deploy button's submission is refused in the form with a message naming the rule, and no deploy request is sent

#### Scenario: The declared default is visible without filling anything

- **WHEN** the serving contract declares a model (or a budget ceiling) and the deploy section renders
- **THEN** the corresponding input's placeholder shows the declared value, so an empty input's effect is visible before submit

### Requirement: Files-bearing publishes are operator-gated

The facet service SHALL gate publishes whose manifests carry auxiliary file sets behind an explicit operator switch (`PACK_FILES_ENABLED`, default off). While the switch is off, such a publish SHALL be rejected with a clear reason; publishes without auxiliary files are unaffected in either switch state. The switch exists to protect cells running pre-package validators, which accept unknown manifest keys silently — the gate turns a rolling-deploy window of silently degraded installs into an explicit enable decision.

#### Scenario: Gate off rejects files-bearing publish

- **WHEN** `PACK_FILES_ENABLED` is unset or false and a publish carries a skill entry with auxiliary files
- **THEN** the publish is rejected with a reason naming the gate, and nothing is stored

#### Scenario: Gate on admits files-bearing publish

- **WHEN** `PACK_FILES_ENABLED` is true and a publish carries a skill entry with a valid auxiliary file set
- **THEN** the publish proceeds under the manifest validation rules

#### Scenario: Files-free publishes are never gated

- **WHEN** `PACK_FILES_ENABLED` is off and a publish carries no auxiliary file sets
- **THEN** the publish proceeds exactly as before

### Requirement: Tree skills are never served as a degraded single document

The facet's public single-document skill endpoint (the anonymous per-skill raw markdown route that registry skill registration validates against) SHALL refuse a skill whose entry carries auxiliary files, with an explicit error stating that the skill contains auxiliary files and is not registrable as a single document. Per-file reads under the detail view's visibility rules remain the inspection path for tree skills. A silently degraded, files-dropped twin SHALL never be produced by any marketplace read surface.

#### Scenario: Raw-md endpoint refuses a tree skill

- **WHEN** an anonymous caller fetches the raw markdown route of a skill whose entry carries auxiliary files
- **THEN** the endpoint returns an explicit error naming the auxiliary-files cause, not a body-only document

#### Scenario: Single-file skill keeps serving raw markdown

- **WHEN** an anonymous caller fetches the raw markdown route of a skill without auxiliary files
- **THEN** the endpoint serves the body with synthesized frontmatter exactly as before

### Requirement: Manifests can be validated without publishing

The facet service SHALL expose a manifest validation endpoint that accepts the same request body as publishing a pack and returns the verdict publishing would return, without performing the publish. Validation SHALL be available to any authenticated caller regardless of creator-group membership; lack of publish eligibility SHALL be reported as a caller finding, not as a rejection. A validation call SHALL NOT mint a pack id or version, SHALL NOT persist any record, and SHALL NOT consume any publish-rate budget.

#### Scenario: Non-creator validates a sound manifest

- **WHEN** an authenticated caller outside the creators group submits a manifest that passes every publish gate
- **THEN** the endpoint returns success with `valid: true`, no manifest errors, and a caller finding stating that the caller cannot publish yet

#### Scenario: Invalid manifest gets publish-identical errors

- **WHEN** a submitted manifest fails structural limits, the files gate, or the tool-declaration gate
- **THEN** the endpoint reports `valid: false` with error wording identical to the corresponding publish rejection

#### Scenario: Registry unreachable during tool verification

- **WHEN** the manifest declares tool names and the registry index cannot be reached to verify them
- **THEN** the endpoint reports `valid: false` with the same fail-closed message publishing would return, and no verdict of validity is implied

#### Scenario: Continuation to an existing pack is checked read-only

- **WHEN** the request carries a pack id for a new version and the caller is not the pack's author, or the pack does not exist
- **THEN** the endpoint reports the same outcome publishing would report, without creating or modifying any version

#### Scenario: Validation is side-effect free

- **WHEN** the same manifest is validated repeatedly
- **THEN** no pack record or version is created and the author's publish budget is unchanged

#### Scenario: Anonymous callers are rejected

- **WHEN** an unauthenticated request hits the validation endpoint
- **THEN** it is rejected with the same authentication failure as the other pack write endpoints

### Requirement: The detail view discloses each MCP reference's tool face

The pack detail view SHALL render, for every MCP reference of the published version, the tool face the pack actually mounts: for an allowlisted reference, the declared tool count against the server's catalog-served total (for example "6 / 161 工具"); for a `fullSurface` reference, the server's full tool count together with the author's stated reason. A version published before the explicit-declaration gate — carrying neither — SHALL render as the full surface, marked as undeclared.

The disclosure SHALL be derived from the immutable version manifest plus the catalog's `tool_list`; it SHALL NOT require a live call to the server.

#### Scenario: Allowlisted reference shows declared versus total

- **WHEN** a user opens the detail view of a pack whose `fd-daas-mcp` reference declares 5 tools
- **THEN** the view shows 5 against the catalog's total for that server, and no reason line

#### Scenario: Full-surface reference shows its reason

- **WHEN** a pack marks `law-bench` full-surface with a reason
- **THEN** the detail view shows the server's full tool count and the reason text

#### Scenario: Legacy version renders as undeclared full surface

- **WHEN** a published version predates the gate and its reference carries no declaration
- **THEN** the view shows the full tool count marked as undeclared, and the page still renders normally
