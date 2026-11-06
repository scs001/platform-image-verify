# registry-market-deployment Specification

## Purpose
生产部署接线 registry 市场数据源：manifest 与 Secret 提供启用 `extension-marketplace` registry 合并所需的连接配置，使线上 Store 与 Agents 目录呈现 mcp-gateway-registry 上注册的业务内容，并给出可复核的部署后验证口径。

## Requirements

### Requirement: Deployment wires the registry market source
The platform production deployment SHALL provide the unified supply catalog read path: `FACET_CATALOG_URL` (facet catalog base URL) and `FACET_CATALOG_TOKEN` (facet internal credential for the global read), plus the legacy direct-registry wiring `REGISTRY_URL` / `MARKET_REGISTRY_TOKEN` as the documented rollback. When both are configured the facet catalog SHALL win; the direct feed stays available only during the deprecation window and SHALL announce itself with a loud warning (`registry-bridge.js` `getCatalogSource`). In the live layout (namespace `fd-prod`, env injected via `envFrom`) the URLs live in the `platform-config` ConfigMap and the tokens as Secret keys; token values SHALL NOT be committed to the repository in plaintext. With no catalog source configured the market SHALL serve the bundled catalog (honest offline floor).

#### Scenario: deployment carries registry URL and token
- **WHEN** the production deployment is running with the wired configuration
- **THEN** the platform process SHALL run with a non-empty `FACET_CATALOG_URL` and `FACET_CATALOG_TOKEN`
- **AND** the legacy `REGISTRY_URL` / `MARKET_REGISTRY_TOKEN` SHALL remain configured as the rollback (unsetting `FACET_CATALOG_URL` falls back to the direct feed)

#### Scenario: missing token does not block startup
- **WHEN** the facet catalog token key is absent or expired
- **THEN** the platform SHALL still start and serve the catalog's public projection subset (or the bundled market catalog when no source is reachable)
- **AND** registry-sourced entries requiring the credential SHALL be absent until a valid token is provided

### Requirement: Deployed market reflects registry content
With the wired configuration and a valid token, after the first registry refresh the production deployment's `GET /api/extensions/market` SHALL include the registry's enabled MCP servers and skills merged with (and name-colliding entries dropped in favor of) the bundled catalog, per the `extension-marketplace` specification. The Agents page SHALL list registry-sourced agents per the `agent-catalog` specification: `supported_protocol: "a2a"` entries as `a2a`-mode Agent Services (gateway route URL), others as link-mode agents.

#### Scenario: market API includes registry entries
- **WHEN** the deployed platform has refreshed from the registry at least once
- **THEN** `GET /api/extensions/market` SHALL return registry entries alongside bundled ones
- **AND** registry MCP entries SHALL carry a `configTemplate` pointing at the gateway endpoint `https://mcp.finddatatech.cloud/<name>/mcp`

#### Scenario: a2a agents surface as Agent Services
- **WHEN** the registry lists an enabled agent with `supported_protocol: "a2a"`
- **THEN** `GET /api/catalog` SHALL include it as an `a2a`-mode entry with the gateway route `https://mcp.finddatatech.cloud/agent/{path}/` as its `url`

#### Scenario: registry outage keeps the store usable
- **WHEN** the registry becomes unreachable after a successful refresh
- **THEN** the deployed market SHALL keep serving the last-good registry entries with the bundled catalog, per the existing degradation requirement

### Requirement: Operator runbook documents token provisioning
`DEPLOY.md` SHALL document how to obtain a registry service token (registry admin UI's token issuance), store it in the `platform-secrets` Secret as `market-registry-token`, restart the platform deployment, and verify the wiring by checking `GET /api/extensions/market` for registry entries and the boot log for the absence of the "registry source disabled" notice.

#### Scenario: operator follows the runbook end to end
- **WHEN** an operator creates the token, updates the Secret, and restarts the deployment following `DEPLOY.md`
- **THEN** the restarted platform SHALL fetch registry content on boot
- **AND** the market API and Store SHALL show registry MCP servers, skills, and agents within one refresh cycle
