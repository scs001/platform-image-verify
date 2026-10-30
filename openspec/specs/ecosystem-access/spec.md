# ecosystem-access Specification

## Purpose
外部开发者进入谦面的身份面：自助注册即得 community 身份与调用键，默认可见面是只读公开数据 server，付费档 server 以组边界区分——身份、免费额度与付费墙在这里收口。

## Requirements

### Requirement: Self-service signup grants community identity and a mintable caller key

The identity provider SHALL accept open self-service registration. A registered user SHALL land in the community group and be able to mint a long-lived caller key (wgk-) for machine use, within the per-user active-key limit, through a self-service mint surface (web console, and the CLI connect flow per facet-editor-cli). The key carries the community group's scopes; revocation is self-service and immediate.

#### Scenario: Signup to working key with no operator step

- **WHEN** an external developer registers, verifies, and mints a caller key
- **THEN** the key authenticates on the registry gateway's MCP proxy paths with community scopes, with no operator involvement

#### Scenario: Key revocation is immediate

- **WHEN** the developer revokes their key
- **THEN** subsequent calls with that key are rejected and the owning user's scope set is unaffected for other keys

### Requirement: Community default visibility is read-only public data servers

A community caller key SHALL grant access to exactly the public data servers (fd-open-data-mcp, fd-cn-report) with read-class tool access. Servers assigned to paid tiers — law-bench — SHALL refuse community keys with a machine-readable upgradeable error naming the required tier, and SHALL remain absent from the community key's server listings.

#### Scenario: Community key reads public data

- **WHEN** a community key calls a read tool on fd-open-data-mcp through the gateway
- **THEN** the call is admitted and proxied

#### Scenario: Paid-tier server refuses community keys

- **WHEN** a community key attempts a call to law-bench
- **THEN** the call is refused before upstream with an upgradeable error naming the paid tier, and law-bench does not appear in that key's visible server list

### Requirement: Paid tier unlocks gated servers by group assignment

Upgrading an external user to a paid tier SHALL be expressible as assigning the user to the paid tier's group; the user's existing keys then carry the widened scopes without re-minting. Downgrade reverses visibility on the same mechanism.

#### Scenario: Upgrade widens an existing key

- **WHEN** a community user is assigned to the paid tier group
- **THEN** their existing caller key's next gateway call sees the gated servers, with no key re-mint required

### Requirement: Native OAuth discovery connection is supported

The registry gateway SHALL support MCP-spec authorization discovery for external harness clients: an unauthenticated MCP request SHALL be refused with a `WWW-Authenticate` header pointing at the protected-resource metadata; the registry SHALL serve the RFC 9728 protected-resource document and the authorization-server metadata document; and the discovery documents SHALL be served without cacheability (no-store).

The gateway SHALL accept a connection completed with a **pre-registered static client identifier** and SHALL NOT require the authorization server to expose a dynamic client registration endpoint. Dynamic client registration is a MAY in the MCP specification and is deprecated as of its 2026-07-28 revision; requiring it would make an unimplemented, deprecated capability a precondition for connecting.

The gateway SHALL accept the resource identifier it advertises in its own protected-resource document as a bearer token audience, so that a client which sends the advertised resource verbatim as an RFC 8707 resource indicator receives a token the gateway will honour.

#### Scenario: A harness connects with zero manual token entry

- **WHEN** a CC (or equivalent MCP client) user adds the gateway MCP endpoint directly and completes the native OAuth flow in the browser
- **THEN** the connection is established and the caller's visible servers match their group scopes, with no manual key copy-paste

#### Scenario: A pre-registered static client connects without dynamic registration

- **WHEN** a client presents a pre-registered static client identifier and completes the authorization-code flow with PKCE against the gateway's advertised resource
- **THEN** the issued token's audience is the advertised resource identifier, the gateway accepts it, and an `initialize` followed by `tools/list` succeeds without any dynamic registration request being made

#### Scenario: Absent dynamic registration is not a connection failure

- **WHEN** the authorization server metadata carries no registration endpoint
- **THEN** a client that has a pre-registered static client identifier still connects, and the gateway does not treat the absence as an error condition

#### Scenario: Discovery metadata is not cacheable

- **WHEN** the protected-resource or authorization-server metadata document is fetched
- **THEN** the response carries no-store cache headers so a poisoned cache cannot redirect clients to an attacker-controlled authorization server
