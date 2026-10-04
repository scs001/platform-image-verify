# facet-platform Specification

## Purpose
谦面（facet）独立服务的平台契约：功能集市场与注册处以独立部署的形态对外（ADR-0015），壹座深度嵌入但互不隶属，身份经同一 IdP 双通道到达，服务面经内部只读 API 取部署数据。

## Requirements

### Requirement: The facet service deploys independently

The facet service SHALL be a standalone deployable — own process, own data store, own public domain — whose availability does not depend on any 壹座 process: with 壹座 entirely down, the facet surface serves browsing, detail, skill downloads of public packs, and direct OIDC login. 壹座 SHALL mount its marketplace surface as a same-origin reverse proxy onto the facet service: requests arriving through the proxy carry a server-verified forwarded identity, which the facet service SHALL accept as authoritative only when the request also carries the configured internal proxy credential. Both 壹座 deployment topologies (single-process and multi-cell gateway) SHALL implement the proxy; the production single-process topology is the acceptance-tested one.

#### Scenario: Marketplace survives 壹座 being down

- **WHEN** every 壹座 process is stopped and a visitor opens the facet domain
- **THEN** browsing, detail, and skill download of public packs work, and direct OIDC login works

#### Scenario: 壹座 embedded marketplace is same-origin and unchanged

- **WHEN** a logged-in 壹座 user opens the marketplace surface through the proxy
- **THEN** the surface behaves as before with no cross-domain redirect or re-login, and the facet service resolves the user from the forwarded verified identity

#### Scenario: Forged forwarded identity is refused

- **WHEN** a request reaches the facet service on its public domain carrying a forwarded-identity header without the internal proxy credential
- **THEN** the header is ignored and the request is treated as anonymous

### Requirement: One identity provider, two arrival channels

The facet service SHALL authenticate direct visitors via OIDC authorization-code flow against the same identity tenant 壹座 uses — same users, same organizations, same creator groups — issuing its own session cookie scoped to the facet domain; and SHALL accept proxy-forwarded verified identity from 壹座 as the second channel. A user SHALL be one identity across both channels: publishing, subscriptions, and deployment ownership are recorded under one key regardless of arrival surface.

#### Scenario: Same user publishes from either surface

- **WHEN** a creator publishes a pack on the facet domain and later subscribes to another pack through 壹座's embedded surface (or vice versa)
- **THEN** both actions are recorded against the same identity, and creator gating applies identically on both surfaces

#### Scenario: Silent sign-in on the facet domain

- **WHEN** an already-authenticated 壹座 user initiates login on the facet domain
- **THEN** the OIDC flow completes via the shared tenant without a credential prompt

### Requirement: The serving plane reads deployments from the facet service

The facet service SHALL expose an internal read-only deployments API for the serving plane (萬星 facade): listing all deployments, resolving a pack's author identity, and listing a pack's deployment rows. The API SHALL be authenticated by an internal shared credential and SHALL NOT be reachable through the public surface without it. The facade SHALL resolve deployed agents through this API rather than any process-local access to the marketplace store.

#### Scenario: Facade resolves an agent after the marketplace moved out

- **WHEN** the facade resolves an agent slug, lists deployments, or checks a pack's author
- **THEN** it does so via the facet service's internal deployments API and behaves exactly as before the marketplace moved out

#### Scenario: Internal API refuses public access

- **WHEN** the deployments API is called without the internal credential
- **THEN** the call is refused and no deployment data is returned

### Requirement: MCP catalog cards on the facet surface

The facet surface SHALL present the registry's MCP servers as cards — name, description, connection endpoint reference, required group when present — aggregated read-only from the registry (openspec: registry-market-deployment), honoring the same visibility gating the registry enforces for the viewing identity. The facet surface SHALL NOT modify registry entries; the registry's software, domain, and deployment location are unchanged (ADR-0015).

#### Scenario: Visible MCP servers appear as cards

- **WHEN** a visitor opens the facet surface's MCP section
- **THEN** registry MCP servers visible to that identity are listed as cards with their endpoint reference

#### Scenario: Cards are read-only

- **WHEN** the facet surface is used by any identity
- **THEN** no registry entry is created, modified, or deleted through it

### Requirement: Marketplace data migrates without identity breaks

Published packs, versions, and subscription records SHALL migrate from the 壹座-hosted marketplace store to the facet service's store with pack ids, version numbers, and identity keys unchanged. Installed snapshots in subscribers' cells SHALL keep working throughout the cutover, and skill-body URLs minted before cutover SHALL remain resolvable during a transition window (redirect or dual-serve).

#### Scenario: Installed packs survive cutover

- **WHEN** the marketplace moves to the facet service
- **THEN** subscribers' cells keep their installed packs working, and update badges appear as before once the embedded surface is repointed

#### Scenario: Old skill URLs keep resolving

- **WHEN** a skill-body URL minted before cutover is fetched during the transition window
- **THEN** it resolves (redirect or dual-serve) to the same content

### Requirement: The facet web shell carries a product intro band

The facet web shell SHALL render a static intro band between the header and the
tab content, present on both tabs (packs market and MCP catalog), always
visible and not dismissible. The band SHALL carry the dual-layer pitch: one
value-positioning line for the facet line, and quick facts limited to
verifiable facts — browse/subscribe/publish, the MCP service catalog, and the
published CLI one-liner `npx @finddatatechonology/facet install <pack id>`
(the same fact the packs footnote used to carry; the footnote now points at
`facet help` — single source, no counts or claims not verifiable at build
time). Copy SHALL come from i18n keys authored in all five locales (en is the
source of truth; `scripts/check-locales.js` enforces key-set parity, so
"fallback" is a safety net, not the authoring mode), and the band SHALL link
the official site's facet line page following the active locale
(`/zh/products/facet` under zh, `/products/facet` otherwise). The band SHALL
stay compact so market cards remain above the fold, and SHALL add no new
view, route, or interactive state.

#### Scenario: intro band on both tabs

- **WHEN** a visitor opens the facet domain and switches between the packs and MCP tabs
- **THEN** the intro band remains rendered above the tab content, in the active locale

#### Scenario: CLI fact stays verifiable and single-sourced

- **WHEN** the band renders the install command
- **THEN** it shows the published package name and install form only, matching the footer hint's fact, with the footer duplicate removed or reduced

#### Scenario: line-page backlink follows locale

- **WHEN** the active locale is zh-CN and the visitor follows the band's official-site link
- **THEN** it targets `/zh/products/facet`; under en (or fallback locales) it targets `/products/facet`
