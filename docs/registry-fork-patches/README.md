# Registry fork patches (cheap1 `/opt/mcp-gateway-registry`)

The MCP-registry stack we run is a fork of `mcp-gateway-registry`; two things
live outside this repo and must stay discoverable:

- **Deploy dir**: cheap1 `/opt/mcp-gateway-registry` (docker compose, tagged
  images, env files — see `DEPLOY.md` "registry" sections).
- **Fork checkout**: same dir is a git checkout on `main` tracking gitee, with
  local commits for our patches. `docker build` uses this tree.

Patches are committed on the checkout AND mirrored here as `.patch` files so a
rebuild from a fresh clone can replay them.

| Patch | What it fixes | Deployed |
|---|---|---|
| `2026-10-03-logto-enriched-groups-scope-remap.patch` | auth-server `/validate`: re-map scopes from `idp_user_groups` groups when the DB fallback enrichment supplied them (upstream re-map branch is PingFederate-only). Without it, a minted personal credential whose IdP groups are empty keeps empty scopes — the platform's `paas-agent-callers` caller group never grants `invoke_agent`, so A2A chat fails 403 "missing invoke scope". | `mcp-auth-server:logto` rebuilt 2026-10-03 (rollback tag `mcp-auth-server:logto-prev-20261003`) |

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