# Registry fork patches (cheap1 `/opt/mcp-gateway-registry`)

The MCP-registry stack we run is a fork of `mcp-gateway-registry`; two things
live outside this repo and must stay discoverable:

- **Deploy dir**: cheap1 `/opt/mcp-gateway-registry` (docker compose, tagged
  images, env files — see the ops runbook's "registry" sections).
- **Fork checkout**: same dir is a git checkout on `main` tracking gitee, with
  local commits for our patches. `docker build` uses this tree.

Patches are committed on the checkout AND mirrored here as `.patch` files so a
rebuild from a fresh clone can replay them.

| Patch | What it fixes | Deployed |
|---|---|---|
| `2026-10-03-logto-enriched-groups-scope-remap.patch` | auth-server `/validate`: re-map scopes from `idp_user_groups` groups when the DB fallback enrichment supplied them (upstream re-map branch is PingFederate-only). Without it, a minted personal credential whose IdP groups are empty keeps empty scopes — the platform's `paas-agent-callers` caller group never grants `invoke_agent`, so A2A chat fails 403 "missing invoke scope". | `mcp-auth-server:logto` rebuilt 2026-10-03 (rollback tag `mcp-auth-server:logto-prev-20261003`) |
| `2026-10-04-per-user-longlived-keys.patch` | Per-user long-lived API keys ("patch keys", OpenSpec `wire-platform-v1` task 2.1): console users mint non-expiring `wgk-` Bearer keys (SHA-256-hash stored in the `patch_keys` Mongo collection; plaintext shown once) via `POST /api/patch-keys`, list (`GET`), and revoke (`DELETE /api/patch-keys/{id}`, immediate + irreversible). auth-server `/validate` accepts `Authorization: Bearer wgk-…` on MCP proxy AND registry `/api/` paths and continues through the standard authorization chain as the owning user (their mint-time groups → scopes re-resolved per request; per-server scope checks still apply). `wgk-` prefix gates the branch, so JWT / self-signed / `REGISTRY_API_KEYS` static-token behavior is unchanged; flag `PATCH_KEY_AUTH_ENABLED` (default true) + `PATCH_KEY_MAX_ACTIVE_PER_USER` (default 20) in `.env`. Full unit suite green (8614 passed). | not yet deployed |
| `2026-10-04-preflight-quota-probe.patch` | Pre-forward sub2api quota preflight (OpenSpec `wire-platform-v1` task 2.2, spec `wire-facade-metering`): new module `auth_server/preflight_quota.py` + a single hook call in `mcp_proxy` right AFTER `_authorize_forwarded_mcp_body` (a genuine 403 can never be masked by a billing verdict) and BEFORE any egress-vend/upstream work. Zero-cost probe of the caller's sub2api account: map value `sk-…`/`key:` → `GET {SUB2API_BASE}/v1/models` with the key as Bearer (model list is local but the full balance/group/quota gate runs — probed live by the wanxing line); `user:`/plain id → admin `GET /api/v1/admin/users/{id}` (`x-api-key`). Three states: sufficient → forward; insufficient (402 / INSUFFICIENT_BALANCE code / zero balance / banned status / gate-refused key) → HTTP 402 `INSUFFICIENT_BALANCE` with Chinese body, upstream never called; billing plane unreachable (network/timeout/5xx/rejected admin cred) → `PREFLIGHT_MODE=strict` (default) refuses HTTP 503 `BILLING_UNAVAILABLE` fail-closed, `postpaid` allows + logs + audits (design.md 后置结算 fallback). Caller mapping via `SUB2API_CALLER_MAP` JSON `{"<username or key_id>": "<sub2api user id or sk- key>"}` looked up on the verified token claims (`sub`, then `egress_user`); UNMAPPED callers skip the preflight entirely (internal users unaffected). Per-caller verdict cache `PREFLIGHT_CACHE_TTL` (default 30s; refusals negative-cached 5s only). Rejections + degraded passes audited as JSONL (`PREFLIGHT_AUDIT_PATH`, default `logs/audit/preflight_quota.jsonl`; fields ts/caller/server/result/reason/mode — no key material) and mirrored to `docker logs`. Flags in `.env`: `PREFLIGHT_ENABLED` (default **false** — gray-release switch for 2.3's A/B), `SUB2API_BASE`, `SUB2API_ADMIN_KEY`, `SUB2API_CALLER_MAP`, `PREFLIGHT_MODE`, `PREFLIGHT_CACHE_TTL`. 36 new unit tests (sub2api fully mocked); applies cleanly on HEAD with or without the 2.1 patch. | not yet deployed |

Rebuild + redeploy recipe (relay: fork checkout on cheap1):

```sh
cd /opt/mcp-gateway-registry
docker tag mcp-auth-server:logto mcp-auth-server:logto-prev-$(date +%Y%m%d)   # rollback
git apply /path/to/paas/docs/registry-fork-patches/<patch>.patch              # when replaying
docker build -f docker/Dockerfile.auth -t mcp-auth-server:logto .
COMPOSE_FILE=docker-compose.prebuilt.yml docker compose up -d --no-deps auth-server
```

Notes:

- `docker build` resolves `python:3.14.7-slim` from Docker Hub, which cheap1
  cannot reach — pull the base via the Xuanyuan mirror first and tag it
  (`0nwz19exd5uanr18ev.xuanyuan.run/library/python:3.14.7-slim` → `python:3.14.7-slim`).
- Smoke test before swapping: run the built image as a throwaway container on
  `mcp-gateway-registry_default` with the live container's env, mint a
  self-signed `lawbenchtestadmin` token inside it and hit `/validate` on both
  containers with the A2A headers (`X-Original-URL`, `X-Body`,
  `X-Validate-Source-Secret` from the generated nginx conf). Live-verified
  matrix 2026-10-03: live 403 → patched 200 for the DB-grouped user; admin
  (token group `mcp-registry-admin`) 200 both; ungrouped user 403 both.
- Upstream issue candidate: the PingFederate-only gate is upstream's #1127
  fix; the same enrichment path applies to any `IDP_USER_GROUP_FALLBACK`
  provider (we enable it for `logto`), so upstream likely wants the generic
  branch (same shape as our PR #1791 era contact, fork `scs001`).
> 维护总览见 `../registry-maintenance.md`（2026-10-05 起）：容器分工、fork 谱系、wire 双 patch 状态、追平 1.32.0 计划与运维速查。
