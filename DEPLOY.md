# Deployment — Docker, TCR, ArgoCD

Platform ships as a **single-process container**: the supervisor (`scripts/start.js` → `local-services.js`) spawns `server.js`, which in turn runs the dsh agent as its child — exactly like `npm start`. One image, one process tree, one data volume.

```
GitHub push ──► image.yml ──► build + smoke ──► push hkccr (HK, ~11.6MB/s)
                                       │
                                       └─► cheap-3 tcr-relay (≤5min, skopeo) ──► ccr (Guangzhou)
                                                  │
                                                  └─► hand-commit the sha-<7> tag into fd-infra-deploy
                                                         → ArgoCD all-services-prod ──► k3s rollout
                                                           (nodes pull from ccr with node-level auth)
```

Fallback pipeline (kept alive): Jenkins (`deploy/prod-snapshot` on Gitee) builds + pushes the
same `sha-<7>` tag to the internal Harbor (`100.64.0.8:30880/paas_private/platform`) — a GitOps
commit can point at either registry's image interchangeably.

---

## Architecture

| Piece | Where | What |
|---|---|---|
| `Dockerfile` | repo root | Multi-stage build: compiles native addons + installs the pinned dsh CLI/profile into `/opt/dsh` + builds `web/dist` + runs `npm run predist` (`build-node` → the standalone Node in `resources/node`, then `verify-bundle`), then copies into a slim runtime. Entrypoint `node scripts/start.js`. |
| `.dockerignore` | repo root | Excludes the built `resources/node` payload and any leftover `resources/**/*.tar.*` archives so a host's mac/win binaries never leak into the Linux image — the image builds its own Linux payload. Also excludes secrets (`.env*`, `mcp.json`) and dev-only trees (`electron`, `openspec`, `e2e`, the local store dirs). |
| `k8s/` | `service.yaml`, `deployment.yaml` | Plain manifests (no Helm). Deployment = 1 replica, Recreate strategy (single stateful agent). |
| `argocd/application.yaml` | ArgoCD Application CR | Watches `k8s/` in this repo, auto-sync prune+selfHeal, `CreateNamespace=true`, in-cluster destination (`https://kubernetes.default.svc`). |
| `.github/workflows/image.yml` | CI (primary pipeline, org-standard tcr-image-pipeline) | Builds on a GitHub runner, smoke-tests `/api/config`, pushes `sha-<7>` + `main` to **hkccr** (Hong Kong TCR); cheap-3's tcr-relay cron re-syncs it to **ccr** (Guangzhou) ≤5 min, digest-stable. Nodes pull from ccr with node-level registries.yaml auth — no imagePullSecret. |
| `Jenkinsfile` | CI (fallback pipeline) | Same build + smoke against the internal Harbor from the `deploy/prod-snapshot` branch on Gitee. |
| `Makefile` | repo root | `make build/run/logs/k8s-apply/k8s-deploy/argocd-sync` shortcuts. |

**Why a `harbor-pull` imagePullSecret?** The k3s containerd mirror (`/etc/rancher/k3s/registries.yaml` on the node) resolves `harbor.local` → `http://localhost:30880` (`insecure_skip_verify: true`) and *does* carry an `auth` block. **However, containerd does not honor the `auth` block for mirrored endpoints** — it keys credentials by endpoint host (`localhost:30880`), not the mirror name (`harbor.local`), so the auth is never sent and pulls return `401 Unauthorized`. Every other `harbor.local` deployment in this cluster (lawcraw, law-bench, review-agent) works around this with a per-namespace `kubernetes.io/dockerconfigjson` secret named `harbor-pull`. We follow the same pattern. CI pushes to the external `23.144.68.246:30880` address — same registry, two names.

---

## Prerequisites (one-time)

### 1. Harbor project + robot account (for the FALLBACK image push via Jenkins)

The canonical pipeline (GitHub Actions → TCR) needs no Harbor setup — its two
GitHub Secrets are documented in step 1 of "Cluster deployment" below. Everything
in this prerequisites section exists to keep the Jenkins/Harbor fallback alive.

The registry actually used in production is the **internal** Harbor
`100.64.0.8:30880` (the America Harbor `23.144.68.246:30880` this section originally
described is unreachable from GitHub runners *and* from the China-side build hosts, so it
is no longer part of any working path). The `paas_private` project exists there, and push
comes from Jenkins with the project-scoped robot `robot$paas_private+ci-push-platform`
(credential id `harbor-platform` in Jenkins — push + pull, no expiry). Nothing needs to be
created per build; to re-create the robot: Harbor UI → `paas_private` → Robot Accounts → New
(scoped to `paas_private`, push).

> The `harbor-pull` secrets already in the cluster use the Harbor `admin` account — fine for
> pulls. A project-scoped push robot (what Jenkins uses) is the least-privilege way to push.
>
> Historical note: a `robot$paas_private+github-actions` robot was created for the
> GitHub Actions leg. That workflow no longer runs (see the header of
> `.github/workflows/docker-deploy.yml`); the robot is unused.

### 2. `harbor-pull` imagePullSecret (in-cluster pulls)

The k3s containerd mirror does **not** honor the `registries.yaml` `auth` block for mirrored endpoints (see the architecture note above), so pods need a per-namespace `kubernetes.io/dockerconfigjson` secret to pull `harbor.local/*` images. Every other namespace in this cluster (lawcraw, law-bench, review-agent) uses one named `harbor-pull`. Create it in `platform-private` (or copy law-bench's):

```bash
kubectl -n platform-private create secret docker-registry harbor-pull \
  --docker-server=harbor.local \
  --docker-username=<robot-or-admin> \
  --docker-password=<secret>
# or copy an existing one: kubectl -n law-bench get secret harbor-pull -o yaml \
#   | sed 's/namespace: law-bench/namespace: platform-private/' | kubectl apply -f -
```

The Deployment already references it via `imagePullSecrets` (commit `149f449`).

### 3. GitHub Secrets — **no longer used**

This table described the GitHub Actions push leg
(`robot$paas_private+github-actions` → America Harbor). That workflow cannot work from a
GitHub runner any more and has been reduced to manual dispatch; the image is built by
Jenkins instead (see "Cluster deployment"). Nothing needs to be configured here for a
deploy — the secrets, if still present, are leftovers:

| Secret | Value (historical) |
|---|---|
| `HARBOR_HOST` | `23.144.68.246:30880` — unreachable from runners |
| `HARBOR_PROJECT` | `paas_private` |
| `HARBOR_USER` | `robot$paas_private+github-actions` |
| `HARBOR_PASS` | `<robot account secret>` |

### 4. ArgoCD app (already registered)

`fd-prod` is reconciled by the app `all-services-prod` against the **external GitOps repo**
`fd-infra-deploy` (`all-services/prod/*.yaml`) — not against this repo's `k8s/`, which is
the older pre-k3s layout. The application object already exists; to inspect or refresh it:

```bash
kubectl --context cheap -n argocd get application all-services-prod
kubectl --context cheap -n argocd annotate application all-services-prod \
  argocd.argoproj.io/refresh=normal --overwrite
```

Thereafter **never edit the live resources directly** — change the manifest in
`fd-infra-deploy` and let ArgoCD reconcile.

---

## Local testing (Docker)

> Requires Docker. The build compiles native addons, installs the pinned dsh packages from npm, and downloads the Node standalone tarball — expect **5-10 min** for a cold build, ~2 min with the GHA cache.

```bash
make build                              # docker build -t platform:dev .
make run                                # -p 3000:3000 -v platform-data-dev:/data
# cold start: server.js boot + dsh initialize handshake → ~60s
make logs                               # tail until "Platform ready"
curl http://localhost:3000/api/config   # health check
open http://localhost:3000              # the app

make stop                               # stop + rm container (keeps the volume)
make shell                              # exec a shell in the running container
make clean                              # stop + delete the data volume
```

Override the Volces key (optional — `server.js` has a fallback baked in):

```bash
make run VOLCES_API_KEY=your-key
```

**What to look for in `make logs`:**

```
[local-services] Platform ready: http://localhost:3000
```

If the container exits instead, the supervisor dumps `server.js`'s log tail right before it — read that for the failing step.

---

## Cluster deployment (k3s via ArgoCD)

The live cluster follows a **separate GitOps repo** —
`git@gitee.com:FindDataTechnology/fd-infra-deploy.git`, `all-services/prod/platform.yaml` —
through the ArgoCD app `all-services-prod` (auto-sync + selfHeal). That file's `image:`
line is the only thing that decides which build runs, so a deploy is always two steps:
build + push the image, then commit its tag there. The `k8s/` and `argocd/` directories in
*this* repo are the pre-k3s Bootstrap layout and are no longer what `fd-prod` reconciles
(section 3/4 below is kept for that older host only).

### 1. Build + push the image — GitHub Actions → TCR (canonical, org-standard)

`.github/workflows/image.yml` follows the org-standard tcr-image-pipeline
(see the org ops manual / openspec tcr-image-pipeline): GitHub runners push to
the **Hong Kong** personal registry, and cheap-3's tcr-relay cron (*/5 min,
skopeo, digest-stable) re-syncs to **Guangzhou**, where the nodes pull:

```
GH(US) ──11.6MB/s──► hkccr.ccs.tencentyun.com/yizuo/platform
                          │ cheap-3 /etc/tcr-relay/repos.conf (yizuo/platform listed)
                          └──≤5min──► ccr.ccs.tencentyun.com/yizuo/platform
                                          │ node registries.yaml auth (all 12 nodes)
                                          └─► k3s pulls, NO imagePullSecret
```

- **Trigger**: push to `main` (auto), or Actions → image → Run workflow.
  Concurrency cancels superseded runs. A cache-warm run is ~2 minutes end to
  end; a cold one can exceed an hour (the gha cache deadlock rule: the first
  success must be allowed to finish — timeout 240m).
- **Smoke gate** (kept from this repo's own pipeline; the org template lacks
  it): the image is booted and probed (`/api/config`) BEFORE any push — it
  caught the js-yaml phantom dependency on 2026-09-30.
- **Tags**: `sha-<7>` + rolling `main` on hkccr; the relay mirrors both to
  ccr with identical digests (`provenance: false`). The `sha-<7>` rule matches
  the Jenkins pipeline's, so Harbor and TCR tags are interchangeable.
- **Secrets**: `TCR_USERNAME` / `TCR_PASSWORD` (org convention; the older
  `TCR_USER`/`TCR_PASS` on this repo are unused). Personal TCR regions are
  independent stores — the `yizuo` namespace and `platform` repo exist on BOTH
  hkccr and ccr.
- **Timing rule**: a fresh hkccr tag reaches ccr within ≤5 min (relay cycle).
  Do not point the GitOps manifest at a ccr tag that has not relayed yet
  (check `https://ccr.ccs.tencentyun.com/v2/yizuo/platform/tags/list` with
  registry credentials) or the roll hits ImagePullBackOff.

**Cluster pull auth**: node-level. All k3s nodes carry TCR credentials in
`/etc/rancher/k3s/registries.yaml` (org rollout 2026-09-30) — no per-namespace
imagePullSecret is needed or used (the interim `tcr-pull` secret was removed
2026-10-01 after a no-secret probe pod pulled successfully). The manifests
keep only `harbor-finddata-pull` for the Harbor fallback channel below.

**Every deploy** is the same two moves as always: after the relay lands the
tag on ccr, commit it into `fd-infra-deploy/all-services/prod/platform.yaml`
(and platform-demo.yaml — bump BOTH), then:

```bash
kubectl --context cheap -n argocd annotate application all-services-prod \
  argocd.argoproj.io/refresh=normal --overwrite
kubectl --context cheap -n fd-prod rollout status deploy/platform
```

**Rollback**: revert the GitOps tag commit. Older tags stay in TCR forever
(immutable), or point the manifest back at the internal Harbor image of the
same sha (the fallback pipeline below).

### 1b. Fallback: build + push via Jenkins (internal Harbor)

The Jenkins path stays fully functional as the backup pipeline — use it when GitHub
Actions or the Tencent registry is unavailable, or to ship a fix from a branch that is
not on GitHub. Same smoke gate, same tag rule.

The `platform` job on the in-cluster Jenkins (`http://103.236.89.212:31000`, NodePort
`31000` in namespace `jenkins`) runs this repo's `Jenkinsfile`:

- **Source**: Gitee `fd-craw-private`, branch **`deploy/prod-snapshot`** — that branch is
  what gets built, so fast-forward it to the revision you want before triggering.
- **Build**: cheap-3's docker daemon (the pod mounts the host socket), with
  `BASE_IMAGE=100.64.0.8:30880/library/node:25-bookworm-slim` (cheap-3 cannot reach
  Docker Hub), tagged `100.64.0.8:30880/paas_private/platform:sha-<7>` **and** `:latest`.
- **Smoke test before push**: the image is booted with `AUTH_MODE=none` and probed on
  `/api/config`; a container that dies after binding its port fails the build (that is how
  two past images were caught).
- **Push**: internal Harbor, as the project-scoped robot
  `robot$paas_private+ci-push-platform` (credential id `harbor-platform`).
- **It does not touch the GitOps manifest**, deliberately: the tag bump stays a reviewable
  commit (same rule as law-bench).

Credentials and the job's SCM live in Jenkins; nothing to set up per build. A cold build is
~40 min (no BuildKit cache export), and `disableConcurrentBuilds()` makes a second trigger
queue behind the first.

Trigger it — a push to `deploy/prod-snapshot` normally fires the Gitee webhook, and the
job's own webhook endpoint works directly (token is the literal string `platform`).
⚠️ The old entry IP `103.236.89.212` no longer routes (the cluster moved to
Tailscale-mesh node names — reach Jenkins via any node's mesh IP, e.g. cheap-6
`100.64.0.13`):

```bash
curl -X POST "http://100.64.0.13:31000/generic-webhook-trigger/invoke?token=platform"
curl -sg "http://100.64.0.13:31000/job/platform/api/json?tree=lastBuild[number,building,result]"
curl -sg "http://100.64.0.13:31000/job/platform/lastBuild/consoleText" | tail -40
```

The build log's `Pushed 100.64.0.8:30880/paas_private/platform:sha-<7>` line names the tag
to deploy next.

Two things about this host. **It is the production node** — cheap-3 also runs the single
`fd-prod` platform pod, the image registry and the proxy, so a build that exhausts its
memory takes the site down with it: builds #14 and #16 on 2026-09-21 died that way
(`SystemOOM` killed kubelet, registry and proxy; the site 502s until the node recovers).
The Dockerfile therefore caps build-time memory in its builder stage
(`NODE_OPTIONS=--max-old-space-size=1024`, `UV_THREADPOOL_SIZE=2`) — keep that cap. And the
built-in node has **one executor**, so a trigger can wait at "Waiting for next available
executor" behind other services' jobs; the build checks out the branch **tip at build
start**, so the log's `Checking out Revision …` line — not the push that triggered it —
names the commit being tagged.

### 2. Deploy it — hand commit in the GitOps repo

```bash
cd fd-infra-deploy
# all-services/prod/platform.yaml: image: 100.64.0.8:30880/paas_private/platform:sha-<7>
git commit -am "deploy(platform): roll to sha-<7>" && git push
# skip ArgoCD's ~3 min poll, then wait for the rollout
kubectl --context cheap -n argocd annotate application all-services-prod \
  argocd.argoproj.io/refresh=normal --overwrite
kubectl --context cheap -n fd-prod rollout status deploy/platform
```

Prove afterwards that the *code* — not just the tag — is what is serving: the pod's bundle
carries the new UI and its server the new routes.

```bash
kubectl --context cheap -n fd-prod get deploy platform \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
kubectl --context cheap -n fd-prod exec deploy/platform -- \
  sh -c 'grep -rl <new-testid> /app/web/dist/assets | head -3; ls /app/server/routes/'
curl -s -o /dev/null -w '%{http_code}\n' https://craw.finddatatech.cloud/api/ready
```

### Fallback: build without Jenkins

Only when Jenkins is unavailable. cheap-1 already has a buildx builder for lawcraw
(`--builder lawcraw-builder`, with `100.64.0.8:30880` declared insecure), so the same
image can be produced there — note `DOCKER_CONFIG` must be a **copy** of `/root/.docker`
(buildx keeps its builder definitions there, and the copy leaves the lawcraw robot's own
credentials untouched), and the Harbor password comes from a file, never argv:

```bash
PW_FILE=/tmp/paas-harbor-pw bash /tmp/paas-build.sh sha-<7>   # on china-cheap-1
```

It pushes the same `sha-<7>` + `latest` tags, so step 2 above is unchanged.

### Superseded: the GitHub-Actions packaging path (retired 2026-09-29)

> **2026-09-30 update**: GitHub Actions is back as the CANONICAL image pipeline —
> but over the Tencent TCR personal registry (`image.yml`, see step 1 above),
> not the unreachable America-Harbor topology described below. The notes stay
> because they are hard-won and nowhere else.

Web/image packaging belonged to Jenkins (and the fallback above). The old
`.github/workflows/docker-deploy.yml` — GitHub runner → America Harbor → chengsi
bridge → blue/green on cheap-2 — is deleted; its working notes are kept here
because they are hard-won and nowhere else:

- cheap-2 (`103.236.89.174:20400`) is reachable ONLY from Chinese IPs; GitHub
  runners cannot SSH in, and cheap-2 has no usable cross-border egress (every
  foreign registry times out), so images had to travel `docker save` over SSH
  from China.
- The chengsi box (`124.220.7.175`) was the delivery bridge: it reaches America
  at ~5.7 MB/s and can SSH into cheap-2; GitHub↔chengsi is GFW-throttled to
  ~27 KB/s, which is why the image went via America's Harbor and never across
  the GFW leg.
- That path's blue/green swap lived in cheap-2's `deploy-platform.sh` with a
  health gate (failure kept the current container); `fetch-deploy.sh` pulled
  from Harbor and piped `docker save` into `docker load`.

If that topology ever returns, resurrect the workflow from git history
(`.github/workflows/docker-deploy.yml` before this date) and re-create its
secrets — all of them were deleted with it.

### Inspect the deployment

```bash
make k8s-status        # pods, svc, rollout
make k8s-logs          # tail the platform pod
kubectl -n platform-private describe pod -l app.kubernetes.io/name=platform
```

Reach it: **https://craw.finddatatech.cloud** (canonical entry — Caddy on cheap1 →
`127.0.0.1:3000`, and the app's own `PAAS_BASE_URL`). The k3s `fd-prod` platform
also answers on its NodePort (**http://103.236.89.212:31870** when this was
written — NodePorts get reallocated: `kubectl --context cheap -n fd-prod get svc platform`).
Both entries now sit behind Logto (`/api/auth/me` → `mode: "logto"`), so anything
that drives the UI needs a session; the older `http://23.144.68.246:30950` in
notes below is dead — **no service in the cluster uses NodePort 30950 any more**.

The `fd-prod` deployment runs `100.64.0.8:30880/paas_private/platform:sha-cc148eb`
(per-user MCP market credentials, deployed 2026-09-21). The image tag lives in the
GitOps repo (`fd-infra-deploy`, `all-services/prod/platform.yaml`); ArgoCD
`all-services-prod` syncs it. `kubectl --context cheap -n fd-prod get deploy
platform -o jsonpath='{.spec.template.spec.containers[0].image}'` is the source of
truth — and if a rollout seems to ignore a new tag, force a refresh with
`kubectl --context cheap -n argocd annotate application all-services-prod
argocd.argoproj.io/refresh=normal --overwrite`.

### Override the Volces key in-cluster (optional)

```bash
kubectl -n platform-private create secret generic platform-secrets \
  --from-literal=volces-api-key=your-key
# ArgoCD self-heal keeps the secret; the Deployment reads it via optional secretKeyRef.
```

### Name the assistant (optional, per deployment)

One value renames every user-facing occurrence of the assistant — sidebar title,
turn header, composer placeholder, the built-in agent's row in the agent
picker, browser tab title — through `GET /api/config` (no rebuild; the web
resolves it before its first paint and falls back to the localized defaults
when unset):

```bash
# Local / docker: .env
ASSISTANT_NAME=Your Name Here
# In-cluster: the platform-config ConfigMap (fd-infra-deploy, e.g. ASSISTANT_NAME),
# then roll the pod.
kubectl -n fd-prod rollout restart deploy/platform
```

### Session ownership (SESSION_LEGACY_OWNER) — add-session-ownership

Chat sessions are private to the account that created them: each session
records an owner (stamped from the first message's authenticated user), lists
are scoped per user, open-by-id/rename/delete are owner-or-admin, and
conversation events reach only that session's viewers. Auth stays off in
dev/desktop (one user, everything visible, e2e unchanged).

One decision before a shared deployment goes multi-user: **who owns the
sessions that already exist?** Rows without an owner are admin-visible only
under auth-on. Assign them once (idempotent — setting it later and restarting
claims whatever is still ownerless):

```bash
kubectl --context cheap -n fd-prod patch configmap platform-config \
  --type merge -p '{"data":{"SESSION_LEGACY_OWNER":"3106241601@qq.com"}}'
kubectl --context cheap -n fd-prod rollout restart deploy/platform
# boot log: [db] assigned N ownerless session(s) to the legacy owner
```

Known shared-runtime ceilings that remain (by design, until per-user cells):
one turn at a time for the whole deployment (a second user prompting during
another's turn gets the standard busy error), and the agent's filesystem view
is still the shared workspace.

### Task worker slots (TASK_WORKER_MAX) — worker-pool

Persona-pinned on-demand runtimes that execute task-engine dispatches in
parallel with the interactive chat (指挥层 phase ③). `0` (the default) is
serial mode — exactly the pre-pool behavior, tasks queue on the interactive
runtime behind live turns. `N>0` allows up to N worker runtimes; while a
worker is available, tasks never touch the interactive runtime. Workers share
the cell's composed profile (same home/patches/credentials), idle-reap after
5 minutes, and pool-state changes broadcast as `worker_pool` events.

fd-prod **keeps `TASK_WORKER_MAX=0`** until node capacity allows (the node's
4GB OOM history — each worker is one more dsh child). The local/demo machine
sets `TASK_WORKER_MAX=3` in `.env` for the parallel fan-out picture.

### Mission Control console (MC bridge) — mission-control-bridge

The 指挥层 operator console: a self-hosted [Mission Control](https://github.com/builderz-labs/mission-control)
instance (alpha) that the operator's own and demo cells enroll into — **user
cells never enroll** (needs user-consent semantics first). The cell-side
bridge is outbound-only (register → poll queue → post results; no inbound
port) and off unless `MC_BRIDGE=1` + `MC_URL` + `MC_API_KEY`.

Instance placement (decision: tailnet-only, no public ingress):

```bash
# On a tailnet host (cheap-N), docker compose up Mission Control with a
# persistent data dir and MC_ALLOWED_HOSTS set to the tailnet hostname.
# Verify reachability from a cell: curl http://<tailnet-ip>:<port>/api/health
```

Console-task convention: `title` = target persona preset id, `description` =
prompt. Unknown personas are reported failed with a structured error.

**Deployed 2026-09-30** (cheap1 tailnet, `http://100.64.0.11:3333`, compose
at `/opt/mission-control/`, data under `./data`, admin `fdadmin` — credentials
with the operator). Live-verified facts the bridge is coded against:

1. Register takes the role ENUM (`"agent"` — there is no "cell") and answers
   `{ agent: { id } }`; a per-agent key cannot re-register — the bridge treats
   registration failure as non-fatal and polls as the key's agent.
2. `GET /api/tasks/queue?agent=<name>` CLAIMS one task per call and answers
   `{ task: {...} }` (docs say `{ tasks: [...] }` — the bridge accepts all
   three shapes).
3. There is no result endpoint and `"done"` is Aegis-gated: terminal outcomes
   go to `PUT /api/tasks/<id>` with `status: "quality_review"` and the
   bridge's facts in `metadata.paasBridge` (`state/output/error/usage`); an
   operator reviews and closes in the UI.
4. Queue polling needs an **operator-scoped agent key**: mint with
   `POST /api/agents/<id>/keys {"scopes":["operator","agent:self"]}` (admin
   session) — plain `viewer/agent:self` keys get "Requires operator role".
5. Console-task convention: `title` = persona preset id, `description` =
   prompt. Round trip verified live (task 1: claim → cell execution →
   quality_review with the failure gist in metadata).
6. MC rate-limits agent polling — 2s cadence trips "Agent task polling rate
   limit exceeded" (the bridge's backoff absorbs it; keep `MC_POLL_MS` at the
   5s default). Live batch 2026-10-01: five tasks round-tripped end to end on
   the worker pool (essays up to 7.2k chars returned in metadata); a
   mid-stream model drop was faithfully reported as a failed outcome.

### Agent workspace (AGENT_WORKSPACE pin) — fix-agent-workspace

The dsh runtime's `cwd` defaults to the process working directory (`/app`,
root-owned in the image). An agent booted there writes to `/tmp`, and produced
files become unservable — `/api/files` and the resource-library save both key
off the runtime cwd. The `AGENT_WORKSPACE` env pins a writable workspace at
boot; user switches persist as a preference and survive restarts, but the pin
outranks them (a stale switch can never strand the deployment). An invalid pin
logs `[workspace] AGENT_WORKSPACE '<v>' rejected: …` and falls back down the
chain — boot never fails.

fd-prod applies it once (the `/data` mount is a hostPath, so the dir is
created on the node, not by the image):

```bash
# 1. On the fd-prod node: create the workspace under the persistent volume,
#    owned by the image's node user (UID 1000).
mkdir -p /opt/platform/workspace && chown 1000:1000 /opt/platform/workspace
# 2. Pin it (plain value → ConfigMap):
kubectl --context cheap -n fd-prod patch configmap platform-config \
  --type merge -p '{"data":{"AGENT_WORKSPACE":"/data/workspace"}}'
# 3. Roll and verify:
kubectl --context cheap -n fd-prod rollout restart deploy/platform
kubectl --context cheap -n fd-prod rollout status deploy/platform
kubectl --context cheap -n fd-prod logs deploy/platform | grep '\[workspace\]'
# expect: [workspace] boot workspace: /data/workspace (source=env)
```

Post-deploy probe: ask the agent to write a small file into the workspace
root, then fetch it through an authenticated browser session —
`GET /api/files?root=workspace&path=<rel>` returns 200 and the resource-library
保存到资源库 succeeds. Sessions whose files were written to `/tmp` under the
old layout stay dead (accepted; nothing worth rescuing).

### Web search relay (operator-side service)

The agent's web search ships **inside the app** — `platform.bundle.json` mounts
`server/websearch-mcp.js` (tools `mcp__websearch__web_search` / `__web_read`)
in every deployment form with zero customer configuration. Search itself is
served by an **operator-run relay** you deploy and key: the platform holds only
`SEARCH_RELAY_URL` + `SEARCH_RELAY_TOKEN`, never a provider key.

A reference implementation ships at **`services/search-relay/`** (zero-dependency
single file; `node services/search-relay/index.js`, loopback :4597 by default,
front it with a TLS proxy in prod). Keys and caller tokens live in
`services/search-relay/keys.json` (gitignored; `keys.example.json` is the
template) — add SerpAPI keys to `serpapi[]` to widen the pool, and one entry per
customer in `tokens[]`. The GLM fallback slot is reserved but not wired; wire it
when a GLM search key arrives.

The relay must implement exactly one endpoint:

```
POST {SEARCH_RELAY_URL}/v1/search
Authorization: Bearer <the deployment's SEARCH_RELAY_TOKEN>
{"query": "...", "num": 8}          # num pre-clamped by the client to 1..10

200 {"results": [{"title": "...", "url": "https://...", "snippet": "..."}]}
4xx/5xx {"error": "..."}            # surfaced verbatim to the agent as a tool error
```

Relay-side expectations (they are the cost controls — demo/sandbox users have
full search access by product decision, and per-prompt budgets do not meter
tool calls): pool multiple provider keys and rotate on 429/quota-exhaustion,
fall back to a second provider (e.g. GLM search) when the pool is dry, cache
identical queries with a TTL, and cap each token's daily call count. Issue
**per-customer tokens** so a leaked desktop settings file costs one token's
quota, not the pool.

Wiring per form factor — no code changes in any of them:

| Form | Where the pair lives |
|---|---|
| dev `npm start` | `.env` (forwarded by the launcher's key list) |
| packaged desktop | `settings.json` in userData (injected via `SETTING_KEYS`) |
| cloud cells | env of the **gateway process** — `baseEnv` flows into every cell |

Verify from a deployment: ask the agent to search (tool block shows results),
or run `npx playwright test e2e/websearch.spec.js --project=fast` (hermetic —
stub relay, no provider spend).

#### Chat fixes: pack agents on the local runtime, folded reasoning, one name — APPLIED 2026-09-22

Live on `sha-a90c2b1` (`fd-prod`, `ASSISTANT_NAME=FD`). Four reported defects, one
cause: a chat-mode catalog agent was forked to its entry's bare OpenAI endpoint, so
the turn had no persona, no tools and no history ("the agent has no memory", "the
conversation cannot see the marketplace MCPs"). A chat agent is now served by the
**local runtime with a generated persona preset** (see `docs/vertical-packs.md` §6.1),
an entry that really is a remote service opts out with `"local": false`, and the fork
path replays the mirrored conversation. Reasoning folds when a turn completes (a
reader who expanded it keeps it open), and `ASSISTANT_NAME` reaches the sidebar,
turn header, composer placeholder, tab title and the built-in agent's picker row.

Verify a deployment after any chat change:

```bash
node scripts/verify-live-chat-fixes.mjs          # Playwright probe; creds from .env
# and pod-side: the newest sessions' preset, persona line and MCP tool count
# (an image built after this doc ships the script at /app/scripts/, so the copy
#  below is only needed for an older pod)
POD=$(kubectl -n fd-prod get pods -o name | grep platform | head -1)
kubectl -n fd-prod cp scripts/inspect-live-session.mjs "${POD#pod/}:/tmp/check.mjs"
kubectl -n fd-prod exec deploy/platform -- node /tmp/check.mjs
```

Selecting a pack agent is a **preset switch** (the dsh child restarts, ~10 s; the
composer blocks until `agent_changed`). `user_preferences.agent.preset` is what a
restart composes — the pick made before the pack is parked under
`agent.preset.own`, which a switch back to the built-in agent restores.

### Registry market token (live layout: `fd-prod` namespace)

The Store merges registry entries from `https://mcp.finddatatech.cloud`
(registry-bridge). The bridge needs `REGISTRY_URL` + `MARKET_REGISTRY_TOKEN`;
without them it logs `registry source disabled` at boot and the market serves
only the bundled catalog. The registry API requires a Bearer token (401
otherwise), so the token is mandatory for registry entries to appear.

> **Where the platform actually runs** (verified 2026-09-18): namespace
> **`fd-prod`**, image from Harbor (`…/platform:sha-<short>`), env injected via
> `envFrom` → ConfigMap `platform-config` + Secret `platform-secrets`. The
> `default`-namespace `platform` deployment in this repo's manifest is a
> scaled-to-zero leftover of the pre-Harbor layout — patching it changes
> nothing user-visible.

1. **Issue a token** — sign in to `https://mcp.finddatatech.cloud` with an
   admin account (寻数科技账号登录), then "Get JWT Token" in the sidebar.
   Token lifetime (updated 2026-09-18): the registry host now runs
   `MCP_TOKEN_DEFAULT_TTL_HOURS=168` / `MCP_TOKEN_MAX_TTL_HOURS=168`
   (`/opt/mcp-gateway-registry/.env` on china-cheap-1; backup
   `.env.bak-ttl-*` alongside), so both the UI button and the mint API
   (`POST /api/tokens/generate` with `X-CSRF-Token` from
   `GET /api/auth/csrf-token`, `expires_in_hours: 168`) yield **7-day**
   tokens. Renew weekly (current one expires 2026-09-25 13:09 CST).
   Minting from a script: an authenticated browser session is required
   (admin login); the API route is otherwise identical.
   ⚠️ The registry's IAM > M2M Accounts (long-lived clients) remains broken:
   the IAM manager factory does not support `AUTH_PROVIDER=logto` (falls
   back to a Keycloak client that cannot connect → group list 502, and the
   M2M create form requires picking from that list), and the M2M client
   list 500s on its DocumentDB config. Fixing that is registry-repo work
   (local fork: FindDataTechnology + law-ai-official mirrors on Gitee/GitHub).
2. **Store it** (secret keys become env vars verbatim via `envFrom`):

   ```bash
   kubectl --context cheap -n fd-prod patch secret platform-secrets \
     -p '{"stringData":{"MARKET_REGISTRY_TOKEN":"<token>"}}'
   ```

3. **Set the URL** in the ConfigMap (plain value, not a secret):

   ```bash
   kubectl --context cheap -n fd-prod patch configmap platform-config \
     --type merge -p '{"data":{"REGISTRY_URL":"https://mcp.finddatatech.cloud"}}'
   ```

4. **Restart and verify** (bridge is silent on success; it only logs when
   disabled or on fetch failure):

   ```bash
   kubectl --context cheap -n fd-prod rollout restart deploy/platform
   kubectl --context cheap -n fd-prod rollout status deploy/platform
   kubectl --context cheap -n fd-prod exec deploy/platform -- \
     sh -c 'echo $REGISTRY_URL; echo ${MARKET_REGISTRY_TOKEN:+token-set}'
   ```

   Then check the market over an authenticated session
   (`GET /api/extensions/market`): bundled entries stay, and registry entries
   appear — MCP `fd-cn-report`, `fd-daas-mcp`, `fd-open-data-mcp`, `law-bench`,
   `airegistry-tools`; skills `contract-review`, `financial-statement-analysis`,
   `legal-research-cn` and the rest of the registry skill catalog; agents
   `registry-chatlaw`, `registry-fingpt` in `/api/catalog`.

#### Per-user market connect (registry-sso-credentials) — APPLIED 2026-09-21

The Store's 连接 MCP 市场 button mints a **personal** registry token. The registry
window it opens is the registry's own login page — the platform's sign-in has
already established a Logto session in the same browser, so the registry's single
`Continue with Logto` button completes the sign-in with **nothing typed**; the
platform then mints **cross-origin with credentials** (the registry session
cookie is `SameSite=None; Secure`) and hands the token to the backend, which
stores it per user (`user_registry_credentials`). It never touches browser
storage, and the popup itself is closed by the platform the moment the mint
lands.

Two registry-side pieces make that cross-origin leg work. Both are now in place
on china-cheap-1, and both are ops config rather than platform code:

1. **Credentialed CORS allowlist** — `CORS_ALLOWED_ORIGINS` in
   `/opt/mcp-gateway-registry/extra_env/registry.env` (the compose `env_file`
   for the `registry` service; note the project `.env` is only used for compose
   *interpolation* and does NOT reach the container):

   ```
   CORS_ALLOWED_ORIGINS=https://craw.finddatatech.cloud,http://103.236.89.212:31870
   ```

   The registry is fail-closed — its own origin is always included, nothing else
   is. List the origins the **browser** loads the platform from; a preflight from
   an unlisted origin is refused and the Store can only fall back to paste. The
   k3s NodePort is reallocatable (the older `30950` no longer exists in the
   cluster — see the note below), so re-check this line whenever the entry URL
   changes.

2. **Preflight exemption in nginx** — `/opt/mcp-gateway-registry/nginx_rev_proxy_http_only.conf`
   (mounted read-only into the container as the registry-API template; a second
   copy at `docker/nginx_rev_proxy_http_and_https.conf`). The `location /api/`
   block authenticates every request with `auth_request /validate`, and a CORS
   preflight never carries credentials by spec — so it could only ever 401, and
   the browser then blocks the real credentialed call. The hotfix routes OPTIONS
   to a named location that skips the auth subrequest and lets FastAPI's
   CORSMiddleware apply the strict origin allowlist (OPTIONS has no body, no
   cookies and no side effects; real requests are unchanged):

   ```nginx
   if ($request_method = OPTIONS) { return 418; }
   error_page 418 = @registry_api_preflight;
   # ...server scope:
   location @registry_api_preflight { proxy_pass http://127.0.0.1:7860; ... }
   ```

   The session cookie was already `SameSite=None; Secure`, so nothing was needed
   there.

Apply a change to either file with (only the `registry` service is recreated;
dependencies and the image are left alone, and a failed nginx reload keeps the
old config running):

```bash
cd /opt/mcp-gateway-registry
cp -a extra_env/registry.env extra_env/registry.env.bak-$(date +%Y%m%d-%H%M%S)   # or the .conf
docker compose -f docker-compose.prebuilt.yml up -d --no-deps --no-build --pull never --force-recreate registry
docker inspect -f '{{.State.Health.Status}}' mcp-gateway-registry-registry-1     # → healthy in ~1-2 min
```

Verify (all three from a machine that can reach the registry):

```bash
U=https://mcp.finddatatech.cloud; O=https://craw.finddatatech.cloud
curl -D- -o /dev/null -H "Origin: $O" $U/api/auth/csrf-token | grep -i access-control        # ACAO = $O
curl -D- -o /dev/null -X OPTIONS -H "Origin: $O" -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-csrf-token' $U/api/tokens/generate      # 200 + ACAO
curl -D- -o /dev/null -X OPTIONS -H "Origin: https://evil.example" $U/api/tokens/generate    # 400, no ACAO
```

A browser check from the real origin (the anonymous case resolves the GET and
sends the POST; the anonymous POST still 401s at nginx, which is expected — the
mint needs a registry session):

```js
// devtools on https://craw.finddatatech.cloud
await fetch("https://mcp.finddatatech.cloud/api/auth/csrf-token", { credentials: "include" })
// → Response{status: 401, type: "cors"}  (a TypeError here means the allowlist is missing this origin)
```

**Verified end-to-end on fd-prod (2026-09-21, `sha-cc148eb`, account
平台管理员账号)** — `scripts/verify-live-connect-flow.mjs` (credentials
from `LOGTO_EMAIL`/`LOGTO_PASSWORD`; it resets the connection, picks a registry
entry the deployment does not already serve, and uninstalls it again, so running
it leaves the environment as it found it):

| Step | Result |
| --- | --- |
| Platform sign-in | `/login` → `Sign in with SSO` → Logto → `/chat` |
| Connect | Connect + the registry's own `Continue with Logto` — **no credential typed anywhere**; connected, `expiresAt` +168 h, `source: sso` |
| Install a registry entry | form has **no** `Authorization` field, Add enabled immediately; the stored record carries `credentialRef: "registry"` and **no** header |
| Effective profile on the pod | the entry in `mcp.patch.yml` carries `Authorization: Bearer …` whose JWT `exp` equals the connection's expiry — i.e. the user's own credential, resolved at write time |
| The credential works | `initialize` → serverInfo `AI Registry`; `tools/list` → 7 tools |
| Chat turn | answered through the deployed instance (LLM + agent path healthy) |
| Cleanup | entry uninstalled; the deployment's five managed servers untouched; the credential row left connected |

Two things that runbook should know about the registry side:

- The registry's login page is **not** an automatic redirect: the first connect
  takes one extra click (`Continue with Logto`) on the registry's own origin,
  which the platform cannot click for the user. Afterwards the registry cookie
  lives for 24 h, so repeat connects are a single click on Connect.
- That card renders **"No login methods are currently configured"** when its own
  `/api/auth/providers` call loses the race against a busy page load (observed
  while the SPA was still fetching its bundle; the endpoint itself stays 200).
  A reload fixes it, so the verification script retries the window; if a demo
  operator ever sees it, reload the window (or just click Connect again). The
  paste fallback stays available at all times.

Rollback: restore `extra_env/registry.env` / the `.conf` from its `.bak-*`
backup and recreate the container. Registry routes moved in a version bump?
Override the paths instead of patching code: `MARKET_REGISTRY_LOGIN_PATH`,
`MARKET_REGISTRY_CSRF_PATH`, `MARKET_REGISTRY_TOKENS_PATH`.

If the allowlist is missing an origin — or the registry is unreachable, or the
account cannot sign in there — the paste fallback is the supported path: the same
dialog takes a token minted via the registry UI's "Get JWT Token", stores it in
the same per-user row with `source: "paste"`, and drives exactly the same
injection (`Authorization` resolved at profile-write time, servers omitted with a
warning when the credential is missing/stale/expired — see the
`registry-credentials` and `dsh-runtime-bridge` specs for the profile side).

### Bot relay (machine callers → chat-platform bots)

Lets a cloud service on a trusted network push text through a configured bot
without a browser session (`add-bot-relay-endpoint`). The route
(`POST /api/bots/relay/send`) is identity-exempt like the bot webhooks and
carries its own bearer token. Deploy inert first, then enable:

1. **Confirm it is inert** on the running service (no token yet):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     <PLATFORM_URL>/api/bots/relay/send -d '{}'   # → 404, e.g. https://craw.finddatatech.cloud
   ```

2. **Add the token** (same rotation rhythm as `MARKET_REGISTRY_TOKEN`):

   ```bash
   TOKEN=$(openssl rand -base64 32)
   kubectl --context cheap -n fd-prod patch secret platform-secrets \
     -p "{\"stringData\":{\"BOTS_RELAY_TOKEN\":\"$TOKEN\"}}"
   kubectl --context cheap -n fd-prod rollout restart deploy/platform
   kubectl --context cheap -n fd-prod rollout status deploy/platform
   ```

3. **Verify both answers**, then keep `$TOKEN` only in the caller's server-side
   config (never in a browser, never in a repo):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     <PLATFORM_URL>/api/bots/relay/send \
     -H 'authorization: Bearer wrong' -d '{}'                    # → 401
   curl -s -X POST <PLATFORM_URL>/api/bots/relay/send \
     -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' \
     -d '{"channel":"ops-alerts","text":"hello"}'                # → {"ok":true}
   ```

4. **Bind a channel** (admin session required; the pair must be a chat the bot
   has already been messaged from, which requires inbound to work — see
   `PUBLIC_BASE_URL` below):

   ```bash
   curl -s <platform>/api/bots/chats                      # find botId + chatKey
   curl -s -X POST <platform>/api/bots/channels \
     -H 'content-type: application/json' \
     -d '{"name":"ops-alerts","botId":"<botId>","chatKey":"<chatKey>"}'
   ```

**Transport**: the token must only cross a network the operator trusts. Calling
from the same host (the registry stack) uses the loopback/node address and is
fine as-is; an off-host caller needs a TLS-terminated ingress in front of the
platform — do not send it over the plain-HTTP NodePort from the open internet.

**Inbound reminder**: webhook platforms (WeCom/Feishu/WeChat OA) can only
receive with `PUBLIC_BASE_URL` set on the deployment; without it only Telegram
works (long-poll), and no `bot_chats` row is recorded for webhook platforms, so
nothing is bindable there.

**Rollback**: unset the Secret key (`kubectl patch secret … -p
'{"stringData":{"BOTS_RELAY_TOKEN":""}}'`) and restart — the route answers 404
again. The `bot_chats` / `bot_channels` / `bot_relay_log` tables stay as inert
leftovers; dropping them is optional.

### Role-gated market entries (Logto groups)

Registry entries can be restricted to users holding a specific Logto role
(mapped into the platform's `groups` from Logto organizations/organization
roles at login). The registry API carries no group metadata, so visibility
groups come from an optional local file next to the data dir (CWD in the
container), `registry-groups.json`:

```json
{
  "servers": { "fd-cn-report": ["analysts"] },
  "skills":  { "contract-review": ["legal"] },
  "agents":  { "agents-weather": ["team-a"] }
}
```

Behavior (add-role-gated-extensions): a gated entry is hidden from the market
for users outside its groups; installing one stamps `requiredGroups` on the
MCP record and is rejected server-side for non-members; at runtime the
effective MCP profile drops stamped servers the current user's groups no
longer cover — so **revoking a Logto role takes effect on the user's next
profile application or cell restart** (in a hosted cell the owner's latest
groups are snapshotted to `PLATFORM_DATA_DIR/owner-groups.json` to survive
restarts). Bundled catalog entries never carry groups; with auth off
(desktop/dev) the requester is the machine owner and sees and installs
everything.

Operational note: renaming a group in Logto (or in `registry-groups.json`)
strands the mapping — gated servers silently disappear for affected users
until the file is updated. That is the designed failure mode: fail closed,
restore on fix.

**Ops access to the registry host** (updated 2026-09-18): china-cheap-1 is
`100.64.0.11` on the finddata Tailscale mesh (self-hosted control plane at
124.220.7.175; the paas workstation's profile `finddata` = chengs-mac
100.64.0.2). The workstation's key is in `/root/.ssh/authorized_keys`
(added 2026-09-18) and `~/.ssh/config` defines `Host cheap1` — so
`ssh cheap1` reaches it directly. The registry stack is docker compose at
`/opt/mcp-gateway-registry` (`docker-compose.prebuilt.yml`; recreate with
`--no-deps` — dependency init images reference docker.io and cannot pull
from the nodes). Fallback if mesh SSH is unavailable: privileged bridge pod
on cheap-4 (see git history of this file for the recipe).

**Registry nginx logto hotfix** (2026-09-19): the image's HTTP-only nginx
template (`/app/docker/nginx_rev_proxy_http_only.conf`) lacks the
`/oauth2/login/logto` + `/oauth2/callback/logto` proxy blocks that the
HTTP-and-HTTPS template has — with no TLS certs in the container the
entrypoint picks HTTP-only, so Logto login silently served the SPA shell
(blank "no login page" at `/oauth2/login/logto`). Fixed by patching those
blocks into a host-side copy at
`/opt/mcp-gateway-registry/nginx_rev_proxy_http_only.conf` and mounting it
read-only over the in-image template (see the `Hotfix 2026-09-19` volume in
`docker-compose.prebuilt.yml`); conf regenerations and container recreates
now keep them. Drop the mount after the upstream template gains the blocks.
Known residual after any conf regeneration: bare `/health` (use container
healthchecks; `/api/health` is also template-gated).

---

## NodePort

`30950` was free at authoring time (k3s range 30000-32767). If it collides with a future service, edit `k8s/service.yaml` `nodePort` and let ArgoCD sync. Current NodePorts in the cluster:

```
harbor 30880, argocd 30910, minio 30900, lawcraw 30500, litellm 30400, …
```

---

## Resource sizing

The container runs a single Node process (`server.js`) plus the dsh agent child it spawns. Set `resources.requests` / `resources.limits` in `k8s/deployment.yaml` to suit the node; a Node + dsh pair is comfortable around 1 CPU / 1.5Gi requested with headroom to ~2Gi.

The startup window is generous (`startupProbe` allows several minutes) because the first boot has to seed the SQLite store and complete the dsh `initialize` handshake before `/api/config` answers.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ImagePullBackOff` (401 Unauthorized) | Two root causes, both one-time: (1) the `paas_private` Harbor project doesn't exist yet — Harbor returns **401** for unknown projects, which looks like an auth failure but isn't (create it in the Harbor UI or via admin API); (2) the `harbor-pull` imagePullSecret is missing in `platform-private` — the k3s containerd mirror does NOT honor the `registries.yaml` `auth` block for mirrored endpoints (see architecture note). Run `make k8s-logs` and check the pod events; a `401 Unauthorized` from `localhost:30880` means one of these. |
| Pod restarts (OOMKilled) | Raise `limits.memory` in `k8s/deployment.yaml`. |
| `startupProbe` fails → `CrashLoopBackOff` | `make k8s-logs`; look for the supervisor's `server.js` log dump. Most common: the dsh CLI is missing from `PATH` or its profile home is unwritable, so the `initialize` handshake never completes. |
| ArgoCD shows `OutOfSync` on `Namespace` | Harmless — `CreateNamespace=true` created it; ArgoCD will self-heal. Or `make argocd-sync`. |
| Image built with mac binaries | `.dockerignore` wasn't in the build context, or you built from a dir with stale `resources/`. Rebuild from a clean checkout. |
| CI loop (workflow re-triggers itself) | The `paths:` filter excludes `k8s/**` and the commit message has `[skip ci]`. If you edit the filter, keep both guards. |

---

## Live service testing

The repo ships a Playwright suite that runs **read-only** checks against the
deployed k3s NodePort - so you can verify a deploy actually serves a working app
with one command, instead of opening the URL and clicking around.

```bash
make test-live LIVE_SERVICE_URL=https://craw.finddatatech.cloud   # read-only suite
# or, equivalently:
LIVE_SERVICE_URL=https://craw.finddatatech.cloud npm run test:e2e:live
```

The `live` Playwright project connects to an already-running external URL
(`LIVE_SERVICE_URL`; the built-in default — the old `23.144.68.246:30950` — is
dead, see the entry note above, so pass the current URL explicitly); it **never**
launches a local `node server.js` and **never** creates temp store dirs.

⚠️ The deployed instances now enforce Logto, so the SPA/WebSocket specs fail
without a session (observed against `craw.finddatatech.cloud`: 5 failed with
`websocket error` / no `/chat` redirect). Use the suite against an
unauthenticated deploy, or sign in first. Point it at a different deploy by
overriding the URL:

```bash
make test-live LIVE_SERVICE_URL=http://staging-host:30950
# or
LIVE_SERVICE_URL=http://staging-host:30950 npm run test:e2e:live
```

### What the read-only `@live` tests check

- `/api/config` responds 2xx with JSON (backend booted).
- `/` serves the SPA and routes to `/chat`.
- The chat shell renders (sidebar + composer + session list) and the **WebSocket
  connects** (`status-text` becomes `Connected`).
- A `list_models` WS round-trip returns a `models` response (the deployed agent
  session is live) - no tokens spent.
- The sidebar shows all nav entries; `/dashboard` resolves via the SPA fallback.

The read-only suite **never** writes chat history, uploads documents, switches
models, or spends LLM tokens.

### Opt-in LLM round-trip (`@live-smoke`)

To verify the full server -> Volces path with one real chat turn
(which **does** spend one LLM token and writes one chat session to the deployed
data dir), run the smoke variant - gated behind `LIVE_SMOKE=1` so it never runs by
default:

```bash
make test-live-smoke           # sets LIVE_SMOKE=1
# or
npm run test:e2e:live:smoke
```

> **Note:** live tests target a deployed entry (private IP NodePort or the
> public domain), so they are a dev-machine / self-hosted-runner concern - not
> run from `ubuntu-latest` CI, which has no route to either. The local
> `fast`/`smoke` suites (`npm run test:e2e`) are unaffected and still launch their own local
> `node server.js`.

---

### fd-prod 聚焦度量实录（add-persona-resource-sets，2026-09-29 sha-c1665d4）

Per-persona 探针（`node scripts/probe-pack-scope.mjs --db /data/data/app.db
--data-dir /data --dsh-home /opt/dsh-home [--auth <MP-JWT>]`，in-pod）：full
5 服务 / 116 工具 → 声明子集 persona 2 服务 / **72 工具（Δ−44，−38%）**；
turn-trace 单 turn token 差噪声级（schema 按需加载），硬收益在 roster 削减。
种子包已按四种声明形态重发（法律-合同未声明 / 法律-案件 MCP-only /
数据-股票空声明 / 数据-中国 mixed v3 已升级）。完整数字、M2M token 重铸与
MCP 行 credentialRef 化的运维实录见
`openspec/changes/add-persona-resource-sets/measurements.md`。

### 角色资源微调上线实录（add-focus-overlay，2026-09-29 sha-40a88aa）

订阅方对聚焦角色的 add/remove 微调（`focus.overlay.<presetId>` 偏好差异）。
**部署全局语义（v1 天花板，与 preset 选择一致）**：overlay 是共享运行时的
部署级状态——任何客户端（web）的调整对全体客户端立即可见（`overlay_changed`
广播），PUT 走 set_preset 同款串行变更路径（流式中 409、空闲时重写双 patch +
重启、下一会话生效）；per-client 隔离是文档化的升级路径而非待发现行为。
**MP 侧 fast-follow（本变更未含）**：小程序不提供微调面板，角色徽标保持
add-persona-resource-sets 的只读形态；e2e 以静态断言锁住「MP 源码不引用
/api/agent/overlay」。探针 `--overlay` 通道已验证：in-pod 对
pack-industry-analyst-macro 存演示 diff 后，`focused-derived`（基线 only）
与 `focused-overlay`（`+skills[stock-research-workflow]` → persona 组合根出
现，跨根链接 `../../../stock-research-workflow`；悬空 remove 静默忽略）双块
并排输出，演示后已清除。API：`GET/PUT /api/agent/overlay?preset=`（PUT 校验
add∩remove 冲突 400 点名字段；overlay 适用于 pack persona，shipped preset
保持可用性语义）。注：#43 构建曾因 cheap-3 上 builder 阶段镜像在构建中途被
回收（`COPY --from=builder: No such image`）失败，重试 #44 即成——冷构建慢
阶段与盘压 GC 的竞态，复发时先查节点 `docker system df`。

### 自建预设上线实录（add-custom-presets，2026-09-29 sha-f3523de/Jenkins #45）

「造」半边的用户侧决策落地：任何认证用户可在单元格内组合 persona 预设
（`user_presets` 表 db v21；id 服务端分配于保留 `user.` 前缀，作者只起名）。
**部署全局名册语义（v1 天花板，与 preset 选择、overlay 一致）**：自建预设
是共享运行时的部署级状态——每个连接的客户端看到同一份名册，任何认证用户
可增删改（`GET/POST/PUT/DELETE /api/agent/presets`，串行变更路径：流式中
409、目录刷新、空闲重启、`catalog_changed` 广播）；per-user 名册是文档化的
升级路径。**MP 侧 fast-follow（本变更未含）**：小程序保持
add-persona-resource-sets 的只读角色徽标，不提供自建预设管理页。资源引用
组合时解析（跨包技能随包生命周期进出、被禁用服务不可被引用复活、空引用
聚焦到基线）；②号 overlay 对自建预设同样生效（存储于目录 id 键下）。
**运维要点**：dsh-agent-presets 的目录名正则禁点——生成预设目录取
`user.<slug>` 的 dash 形（`rosterPresetId`），resolvePersona 双向匹配（顺带
修复点号 pack agent id 的同类潜在问题）；自建预设不可发布（共享走市场包草
稿），包清单 `user.` 前缀 agent id 发布+安装双拒，安装撞已有预设 id 跳过并
报告属主。探针已并入：自建预设作为聚焦角色逐预设输出（服务/工具数、
token delta 走 `--turn-trace`）。

### 模型名册探活刷新上线实录（refresh-llm-model-roster，2026-09-30 sha-8e235ce/Jenkins #46）

背景：`GET /v1/models` 是「认识的 id」而非「能服务的 id」——33 个 id 逐一 1-token
实测仅 13 个在服务，且当日网关把 deepseek 账户组从前缀 id
（`deepseek/deepseek-v4.1-flash`，约定默认道）切回裸 id（`deepseek-v4.1-flash`），
两个方向各复测 ×2 证实。**双轨落地**：①代码轨——VOLCES_MODELS 22→13（deepseek→
glm→免费池排序）、`getAvailableModels` 跨 provider 按 id 首现去重（下拉 React key
冲突）、e2e FROZEN/断言更新（6/6 绿），Jenkins #46 构建 + GitOps 48e0314 滚动
（镜像 sha-8e235ce + `DEFAULT_MODEL` 改裸 id 一次提交）；②数据轨（等构建期间
先行恢复服务）——pod 上备份 `/data/*.bak-2026-09-30` 后直写 13 条名册 + 裸 id
默认指针，`kubectl exec` 内跑 `node --input-type=module -e 'import("/app/dsh-profile.js")'`
调 `writeLlmProfile()` 重投影 settings.yaml（dsh Chokidar 热载，零停机）。
**验证**：settings.yaml 26 模型裸 deepseek 头、活 ConfigMap 与 pod env `DEFAULT_MODEL`
均为裸 id、32080 中继对裸 id 回 "ok"、站点 /api/ready 200；dev 隔离 boot 同代码
同数据 WS 聊天回复「收到」。**坑**：`kubectl cp` 对该 pod 持续 NotFound 而 exec
正常——用 `exec + base64 -d` 直写绕过；ArgoCD refresh 后 `rollout status` 会在旧
状态上立刻返回成功，需轮询新 pod 名出现。**遗留（add-llm-model-discovery）**：
`PUT /api/llm/providers/:id` 不接受 models 数组，后台 UI 无法改 provider 模型列表
（本次只能 /data 直写 + 手动重投影）；id 形态双向漂移（前缀↔裸）证明静态名册
必然腐烂，探针同步 + 名册可编辑是治本。

### 模型发现同步上线实录（add-llm-model-discovery，2026-09-30 sha-6048f89/Jenkins #47）

上次实录的「遗留」本次全部收口：`POST /api/llm/providers/:id/sync` 探活分类
（并发4×1-token、六桶、限流/网络单重试）、serving 追加合并（家族元数据
deepseek 32768+efforts / glm-5.3-flash 32768 / 默认 128k-8192）、死 id 只标记
不驱逐、家族 rank 排序、`PUT …/providers/:id` 接 models 数组（运行时名册
编辑，400 回滚）、Models 页同步按钮/编辑器/状态芯片（admin 门禁，五语言）。
单测 18/18 + e2e 5/5（llm-model-sync.spec.js）。

**部署管道**：走了 Jenkins #47 降级路径（TCR 主链路当日并行演进中——本
变更的 GHA run 构建的是瘦身前胖镜像 ~2GB，1.3-2Mbps 推 TCR 需数小时，Push
步 1h 后取消；其间用集群凭证 token dance 探到 `NAME_UNKNOWN`，实为**空仓
库假阴性**——`yizuo/platform` 已建，同晚 22:22 并行会话的瘦身镜像 run 已全
绿入库 sha-828a6df，勿重蹈覆辙）。Gitee `deploy/prod-snapshot` fast-forward
（Gitee `deploy/prod-snapshot` fast-forward 到 6048f89，generic-webhook
token=`platform` 触发），冒烟过推 Harbor sha-6048f89；GitOps f3cd6e3（manifest
维持 Harbor 路径未动）；ArgoCD refresh 后节点闪断（FailedScheduling + pod 重建），
镜像经 mesh 拉取约 10 分钟，最终 1/1 Running。

**生产同步（finddata-token）**：33 id 全分类，4 serving（全免费池：cohere/
dots-studio/gemma-26b/ling-sante，后者自动合并 13→14，discovery 33 条落盘）。
**deepseek 车道与 glm-5.3-flash 在 dev+prod 两把 token 上都 unauthorized**
（"not supported by any configured account in this group"）——网关侧新挂的
deepseek 账户没绑到平台 token 所在组，等绑定后一次 sync 即可回归（排序保
deepseek 头部）；「≥13 serving」验收因此未达，属网关外部状态。**真实对话**：
`PUT /api/llm/default` 只改指针不动运行中会话的活跃模型——首轮照打 dark
deepseek（平台如实透传网关 404，错误路径端到端验证）；WS `set_model` 切
cohere 车道后一轮回复「收到」；默认指针已恢复（恢复 PUT 偶发 503，重试即过）。

### 内置车道后台可配 + 默认车道守卫（add-editable-llm-route）

10-01 事故（暗默认 + 重启锚回 = 新会话全 404）之后，内置 Volces 车道不再
是镜像常量的只读投影。**Models 页（admin）现在可以直接编辑它**，全程热载、
零重启、零重打包：

- **名册 + base URL 覆盖层**：持久化在 `llm-providers.json` 的
  `volcesOverride` 键，优先级 **override > env（LLM_BASE_URL）> 镜像常量**。
  sync 对 volces 不再干跑——serving id 落盘进 override；卡片上有「已覆盖」
  徽标和**清除覆盖**按钮（一键回滚到 env/镜像态）。API key 永不出 env、
  路由不可删（key 轮换照旧走 Secret patch）。
- **每模型 contextWindow / maxTokens 均可编辑**（名册编辑器每行两个输入框，
  全部 provider 通用）。
- **默认车道守卫**：boot / sync 后 / 改默认后，对默认模型发一发 1-token
  探活。明确 `model_not_found`/未授权类 4xx → 自动把默认切到最近一次 sync
  分类里第一个 serving id，广播 `model_fallback`（客户端弹 toast）。网络
  错误/超时**不回退**（网关抖动不得悄悄挪默认）；无 serving 已知时保持
  原默认并打日志。boot 探测失败不影响启动（listen-first 窗口内完成）。

网关再漂移时，处置从「改代码 → 建镜像 → 滚动」降级为「Models 页点同步 →
必要时编辑名册」；默认车道暗了自愈，不再等人工发现。

## Multi-tenant cloud deployment (gateway + cells)

The single-process deployment above serves **one** shared runtime. The hosted
product shape is different: each user gets their own isolated runtime, and a
thin **gateway** in front authenticates them and routes to it.

```
                  ┌──────────────────────────────────────────────┐
browser ──https──►│ gateway  (gateway/index.js)                  │
                  │  Logto login · session cookie · WS upgrade    │
                  │  cell registry: spawn / health / idle reap    │
                  └───────┬───────────────────┬──────────────────┘
                          │ loopback + gateway secret
              ┌───────────▼─────────┐  ┌──────▼──────────────┐
              │ cell alice          │  │ cell bob            │
              │  server.js + dsh    │  │  server.js + dsh    │
              │  /data/<alice>/…    │  │  /data/<bob>/…      │
              └─────────────────────┘  └─────────────────────┘
```

A **cell** is exactly the single-process deployment above — one `server.js`,
one dsh child, one data root — so the desktop app and `npm start` are the
one-cell form of the same thing. Nothing inside a cell knows other users exist;
that is what makes isolation a process boundary instead of application logic.

### Running it

```bash
# One gateway, which starts cells as users arrive.
CELL_GATEWAY_SECRET=$(openssl rand -base64 32) \
CELL_DATA_ROOT=/data/cells \
GATEWAY_PORT=3080 GATEWAY_HOST=127.0.0.1 \
AUTH_MODE=logto PAAS_BASE_URL=https://paas.example.com \
LOGTO_ENDPOINT=https://auth.example.com LOGTO_APP_ID=… LOGTO_APP_SECRET=… \
SESSION_SECRET=$(openssl rand -base64 32) \
node gateway/index.js
```

`npm run gateway` is the same thing. Cells are spawned by the gateway; you
never start them by hand in production (`.env.example` documents the per-cell
env matrix for doing so while debugging).

### Environment

**Gateway:** `GATEWAY_PORT` (default 3080), `GATEWAY_HOST` (bind address — this
is the deploy's public surface), `CELL_DATA_ROOT` (per-user data root),
`CELL_GATEWAY_SECRET` (**required**; the gateway and cells share it),
`CELL_IDLE_REAP_SECS` (default `0` = never), `CELL_START_TIMEOUT_MS` (default
60000), plus the `LOGTO_*` / `SESSION_SECRET` / `PAAS_BASE_URL` set from the
Logto section above.

**Cells** are configured entirely by the spawner: `PLATFORM_DATA_DIR`,
`DSH_HOME`, `MCP_CONFIG_PATH`, `PORT`, `HOST=127.0.0.1`, `AUTH_MODE=forward_auth`,
`CLOUD_MODE=1`, `CELL_GATEWAY_SECRET`, `CELL_USER_EMAIL`. They inherit the
gateway's environment for everything else, which is how they get `LLM_API_KEY`
and friends. `DSH_SHARED_HOME` (default `~/.dsh`) is the deployment's installed
dsh tree; a fresh per-user `DSH_HOME` is scaffolded from `dsh-profile-template/`
and linked to it read-only, so every cell resolves the same bundles without a
per-user install.

Two rules are not optional:

1. **Cells bind loopback only.** Never expose a cell port. The gateway is the
   only reachable surface; the secret is defence-in-depth for the shared-host
   case, not a substitute for this.
2. **`CELL_DATA_ROOT` must be local disk.** Every store is SQLite + WAL, and
   SQLite over NFS corrupts. A network filesystem here will lose data.

### Logto app registration

The gateway is the **only** Logto client; cells never talk to the identity
provider. Register one confidential web application with redirect URI
`<PAAS_BASE_URL>/auth/callback` and post-logout `<PAAS_BASE_URL>/`, enable the
`organizations` / `organization_roles` claims as described above, and give the
gateway `LOGTO_ENDPOINT` / `LOGTO_APP_ID` / `LOGTO_APP_SECRET`. Group names
still arrive as cell identity (`X-Forwarded-Groups`), so `admin` remains the
administrative group.

### WeChat mini program client (Taro)

`miniapp/` is a Taro (React) thin client — chat + session history — that speaks
the same WS/REST contracts as the web app through the shared `packages/core`
package. It authenticates through a second identity path, WeChat login,
instead of the Logto browser redirect. The path exists on BOTH deployment
shapes: the multi-tenant gateway **and** the single-process `AUTH_MODE=logto`
server (`add-single-process-mp-auth` — same `/api/mp/*` contracts, same
shared `gateway/mp-auth.js` / `gateway/mp-bindings.js` modules, one
implementation).

**Server env** (all three required to enable the path; unset = the login
routes report "not configured" and every browser flow is unchanged):

| Variable | Meaning |
|---|---|
| `MP_APPID` | the mini program's AppID |
| `MP_SECRET` | the mini program's AppSecret (**server-side only**) |
| `MP_TOKEN_SECRET` | JWT signing key for platform tokens (`openssl rand -base64 32`) |
| `MP_TOKEN_TTL_HOURS` | token lifetime, default `12` (the client silently re-logins via `wx.login`, so a shorter value is fine) |

Login is **account binding with bind codes** (Logto offers no password
grant — OAuth 2.1 removed the flow — so credentials never enter the mini
program):

1. First launch on a device: the user signs into the WEB app in a browser
   (the normal Logto flow) and opens **`/api/mp/bindcode`** — a small page
   shows a 6-digit code (5-minute, single-use, minted from their
   authenticated session).
2. They type that code ONCE on the mini-program login page:
   `POST /api/mp/login-bindcode {code, bindCode}` pairs the fresh
   `wx.login()` code (the WeChat user) with the bind code (account
   ownership) and binds the openid to the account
   (`<CELL_DATA_ROOT>/mp-bindings.json` on the gateway;
   `data/mp-bindings.json` under the single-process deployment's
   `PLATFORM_DATA_DIR` — same file format, so a file can be carried between
   shapes).
3. Every later launch is silent: `wx.login()` → `POST /api/mp/login {code}`
   → `code2Session` → binding lookup → a platform JWT carrying the ACCOUNT
   email/groups, sent as `Authorization: Bearer` on REST and on the WS
   upgrade. Because the identity is the account email verbatim, the mini
   program and the browser resolve to the SAME dataset (the same per-user
   cell on the gateway; the one shared runtime single-process).
4. `DELETE /api/mp/bind` (logout) removes the binding.

`MP_TOKEN_SECRET` is deliberately separate from `CELL_GATEWAY_SECRET`.

**Demo mode (openspec: mp-demo-mode; gateway only)** — set on the PROD
gateway's env when enabling:

| Variable | Default | Meaning |
|---|---|---|
| `MP_DEMO_MODE` | `0` | unbound openids get a demo identity instead of `binding_required` (the WeChat-reviewer path: open, chat, zero popups) |
| `MP_DEMO_MAX_CELLS` | `3` | concurrent demo cells; beyond, a friendly busy `503 {"code":"demo_capacity"}` |
| `MP_DEMO_IDLE_SECS` | `900` | idle demo cells are stopped and their data dir deleted (account cells unaffected) |
| `MP_DEMO_MSG_LIMIT` | `20` | prompts answered per demo cell before the bind-your-account reply |

Demo identities are `demo-<hash>@demo.invalid` (reserved TLD — can never
collide with a real account), group `demo`, one isolated cell per openid.
Ignored by the single-process server on purpose (one shared runtime would
expose the owner's data). Rollback: unset `MP_DEMO_MODE` — leftover demo
cells reap themselves away. `/api/gateway/status` reports `demoCells` for
monitoring.

**Demo sandbox pod (openspec: mp-demo-sandbox)** — the fd-prod answer for
"reviewer must chat for real", since that deployment runs single-process and
cannot host cells. A dedicated accountless twin (`platform-demo`, manifest
`fd-infra-deploy/all-services/prod/platform-demo.yaml`, NodePort 31871):
`AUTH_MODE=none` + `DEMO_SANDBOX=true` (per-connection `MP_DEMO_MSG_LIMIT`
budget, uploads 403, sessions wiped every `DEMO_SANDBOX_WIPE_SECS`), emptyDir
data, anti-affinity with the account pod, LLM via the sub2api NodePort. The
mini program's unbound banner carries a 先体验 entry that switches the client
to `https://demo.finddatatech.cloud` (persisted base; 退出演示 restores).

Go-live checklist (operator, in order):
1. DNS A record `demo.finddatatech.cloud` → the entry IP (same as craw).
2. Safeline console: add site `demo.finddatatech.cloud` → `127.0.0.1:8080`
   + certificate (mirrors the craw site).
3. WeChat console → 开发管理 → 服务器域名: add
   `https://demo.finddatatech.cloud` to request **and** socket 合法域名.
4. Trigger the Jenkins `platform` image build (manual webhook as usual).
5. One GitOps commit: bump BOTH `platform` and `platform-demo` image tags to
   the new sha AND set platform-demo `replicas: 1`; ArgoCD syncs. The Caddy
   block (`demo.…:8080 → 127.0.0.1:31871`) is already in place and inert
   until this step.
6. Probe: fresh WeChat account → 先体验 → chats with zero popups; the cap
   replies after the budget; `/api/documents` 403s; sessions wipe on the
   timer. Then upload the new client version and resubmit for review.

Rollback: platform-demo `replicas: 0` (one commit) — nothing else holds
state; the client's demo entry then shows the sandbox unavailable and the
normal sign-in flow is untouched.
**Local rehearsal without the real MP AppSecret:**
`node scripts/dev-mp-gateway.mjs` — the real gateway + real Logto from
`.env`, with a mock code2Session that maps every wx.login code to one dev
openid, so the whole bind → silent-relogin flow can be rehearsed in
devtools.

**Release prerequisites (ops — start these early):**

1. **A registered mini program AppID** (个人主体 is fine for chat; web-view
   would require an enterprise entity — this client does not use web-view).
2. **HTTPS/WSS + an ICP-registered domain.** Release requires the domain in
   the WeChat admin console under 开发 → 开发管理 → 开发设置 → 服务器域名, in
   BOTH lists:
   - `request 合法域名` → `https://<PAAS_BASE_URL>`
   - `socket 合法域名` → `wss://<PAAS_BASE_URL>`
   An IP, a port-numbered host, or an unregistered domain cannot be added.
   Devtools bypasses the check (详情 → 本地设置 → 不校验合法域名), which is how
   the client is developed against a local server. The client's default base
   URL is `http://localhost:3000` — `localhost`, not `127.0.0.1`, because the
   dev server binds IPv6 localhost only; for 真机调试 (real-phone preview)
   set the base URL to the dev machine's LAN IP.

**Building the client:** `cd miniapp && npm install && npm run build:weapp`,
then open `miniapp/` in WeChat devtools (`miniprogramRoot: dist/`, test appid
— no devtools-side npm build needed). The API base URL lives in mini-program
storage (`platform.baseUrl`); the default is `http://localhost:3000`.

**Verification without devtools:** `node --test scripts/test-mp-auth.mjs`
(boots a real gateway against mocked WeChat/Logto upstreams and a stub cell —
login exchange, Bearer routing, header stripping, WS upgrade auth, identity
stability) and `node --test scripts/test-ws-reconnect.mjs` (the shared
reconnect state machine).

### Sizing and lifecycle

Each resident cell is a Node process plus a dsh child plus that user's page
cache — budget **roughly 150–300 MB per cell** and size the host for the number
of users you expect *concurrently resident*. 100 resident cells wants on the
order of 20–30 GB of RAM, so the always-on default is comfortable to low
hundreds of users on a modest pool and wants reaping or Phase 3 density work
beyond that.

Cells are **always-on by default**: the first authenticated request starts one
and it stays. Being started means the user's cron jobs fire and bots poll,
which is the point. Setting `CELL_IDLE_REAP_SECS` trades that away: after that
much idle time a cell is stopped. The reaper asks the cell for its enabled
scheduled work before stopping it, and a cell with **any enabled cron job or
bot is exempt** — so "reaped" never silently breaks a schedule that the user
set up and left enabled. A disabled job does not block reaping.

The offline contract, which must be stated to users: **a stopped cell means
that user's chat is briefly unavailable on their next visit and their scheduled
jobs do not fire while it is stopped.** Coming back is a cold start — the
server boots and completes its dsh handshake before the agent can answer, which
is seconds, once per idle cycle. Nothing is lost; the data root persists.

### Observability and operation

```bash
curl http://127.0.0.1:3080/healthz                 # liveness (+ resident cell count)
curl -H "Cookie: paas_session=…" http://127.0.0.1:3080/api/gateway/status
```

`/api/gateway/status` is admin-gated and lists every cell as
`{user, userId, state, pid, port, lastTraffic, uptimeMs, error}`. `state` is
`starting` → `running` → `stopping`, or `error` when a cell exits unexpectedly
(its user's next request cold-starts a fresh one). A crash is scoped: one cell's
failure never touches another user's.

`SIGTERM` on the gateway stops every cell before exiting, so a redeploy does not
leak one process per user on the host.

### Phase 3 outlook (explicitly out of scope today)

Cells here are child processes on one host, and `gateway/spawner.js` is the only
file that knows that. The intended next step replaces `spawn()` with a k8s
client and PVC-per-user, at which point:

- **Density and isolation** come from pods and namespaces rather than process
  cgroups; the gateway↔cell contract (HTTP + WS to a loopback-reachable cell,
  identity via headers + shared secret) is unchanged.
- **Durability**: cell data roots move to per-user PVCs, and backup/restore
  becomes a per-directory operation — the layout was chosen so it would be.
  Until then, **losing the host loses that host's users' data**; there is no
  replication or backup in this cut.
- **Scaling**: the gateway is single-instance and in-memory, so cells are not
  HA either. That is a deliberate first-cut trade, not an oversight.

---

## fd-prod 多租户网关布局（migrate-fd-prod-cells）

fd-prod 从单进程 platform 迁到网关+cells（ADR 0008：多租户隔离是 cell，不是进程内 ACL）。
对外 origin 不变（craw ingress 原样；Logto 回调、MP 客户端、已注册 Agent Service、分享链接
全部不动）。单进程模式（dev/桌面/demo pod）不受影响。

### 启动命令与 env

Deployment 的启动命令改为 `node gateway/index.js`（镜像不变；`GATEWAY_PORT` 默认 3080，
ingress 指向它即可，或设 `GATEWAY_PORT=3000` 沿用旧探针）。env 分三层：

```yaml
# platform-config（ConfigMap）——网关本体 + baseEnv 继承进每个 cell
GATEWAY_PORT: "3000"            # 沿用现有探针端口，或改 ingress 指 3080
CELL_DATA_ROOT: /data/cells     # hostPath，节点预建并 chown 1000:1000
CELL_GATEWAY_SECRET: <secret>   # 见 platform-secrets，随机 ≥32 字节
CELL_IDLE_REAP_SECS: "3600"     # 账号 cell 闲时回收（有启用的 cron/bot 的 cell 豁免）
AGENT_WORKSPACE: /data/workspace  # 保留：单进程回滚模式仍需要；网关路径下被
                                  # spawner 的 per-cell 值权威覆盖，无害
AGENT_SERVING_RUNNER_URL / AGENT_SERVING_PACKS_URL / AGENT_SERVING_BACKEND_TOKEN
  # 不变——deploy 路由挂在网关进程上（gateway/packs.js），env 必须在网关层可见
# LLM_BASE_URL / REGISTRY_URL / MARKET_REGISTRY_TOKEN 等经 baseEnv 流入每个 cell
```

**不要**把 `AGENT_WORKSPACE` 从 config 删掉：GitOps 回滚到单进程时它就是 workspace pin
（fix-agent-workspace 的原始语义）。spawner 在 `...baseEnv` 之后注入
`<CELL_DATA_ROOT>/<userId>/workspace`，网关级残留值永远不生效（有单测钉死）。

### 节点预备（一次性）

```bash
# fd-prod 节点（cheap-5）：cells 根 + 属主（镜像 node 用户 uid 1000）
mkdir -p /opt/platform/cells && chown 1000:1000 /opt/platform/cells
df -h /opt    # 迁移是拷贝语义，磁盘要能容纳旧 /data 的一倍（当前 ~786M，宽裕）
```

### 资源包络

网关 pod request 1Gi / limit 2Gi（实测：单进程 328Mi、网关空载 230Mi、活跃 cell ≈
300–400Mi；≈4–5 并发活跃 cell + 网关本体）。burn-in 一周后按观测调整（见检查单第 8 步）。

### 存量数据迁移（停机窗口内）

```bash
kubectl --context cheap -n fd-prod exec deploy/platform -- node scripts/migrate-single-to-cell.mjs \
  --email 3106241601@qq.com \
  --data-dir /data --dsh-home /opt/dsh-home --cell-root /data/cells --stamp-unowned
```

拷贝语义（旧 `/data` 原地保留 = 回滚路径）；`--stamp-unowned` 把无主会话盖给 owner
（session-ownership 的范围列表按 owner 严格匹配，不盖章旧会话会从列表消失）；
`--dry-run` 先看计划。已知遗留：`aloadtree@gmail.com` 名下 4 个会话会随全量落进 owner
cell（对其 owner 不可见的孤儿行）——cutover 前决定：接受（4 条，无害）/ 拆分到第二 cell /
让该账号自弃（见检查单第 1 步）。

### Cutover 检查单

1. **准入冻结（D7/Q11）**：Logto 控制台核对用户列表并处置第二账号（3106241601@qq.com =
   owner；aloadtree@gmail.com 的 4 个会话去留在此定）；注册开关置关，burn-in 后再开。
2. **取证**：registry 侧记下当前 Agent Service 注册 URL（cutover 后探活对照）。
3. **停机**：`kubectl scale deploy/platform --replicas=0`（Recreate 语义下等 pod 退净）。
4. **迁移**：跑上面的 migrate 命令；输出核对「landed N files」与计划一致。
5. **换入口**：GitOps 提交（command 改 `node gateway/index.js`、env 增补如上、资源包络
   1Gi/2Gi）→ ArgoCD sync → `kubectl logs | grep '\[gateway\]'` 确认 listening + 首个 cell。
6. **回归（web）**：登录（旧会话失效一次，预期）；会话列表/文档库/资源库逐项可见；让
   agent 写一个文件 → `/api/files?root=workspace` 200。
7. **回归（a2a + MP）**：演示服务 `vtdpsNmtW6OQ9I99mBhbDw` 原址 message/send 一次；
   MP 真机走查（含 401 静默重登分支）。
8. **隔离冒烟**：Logto 手建第二个测试账号登录 → 断言看不到 owner 的文档/资源/workspace
   文件；完成后删测试账号。
9. **burn-in（一周）**：ops-console 内存灯 + `kubectl top pod` 记录 cell 形态，决定
   `CELL_IDLE_REAP_SECS` 是否收紧；期满删旧 `/data` 原件（workspace 大文件先归档），
   并在此记录清理日期——**清理后回滚条款作废**。

### 回滚

revert GitOps commit → 单进程以原 `/data` 起回（`AGENT_WORKSPACE` pin 仍在 config）。
cutover 后 cell 侧新产生的数据不回流（公告口径）。旧 `/data` 删除前，回滚永远可用。

---

## File map

```
Dockerfile                          # multi-stage single-process image build
.dockerignore                       # excludes built resource payloads + secrets
Makefile                            # build/run/k8s/argocd shortcuts
k8s/
  service.yaml                      # NodePort 30950 → :3000
  deployment.yaml                   # 1 replica, Recreate, image tag set by CI
argocd/
  application.yaml                  # ArgoCD app (apply once)
.github/workflows/
  docker-deploy.yml                 # build + push + GitOps commit-back
  release.yml                       # (unchanged) Electron .dmg/.exe installers

gateway/                            # multi-tenant front door (not used by the single-process deploy)
  index.js                          # Logto auth, routing, WS upgrade, /healthz + /api/gateway/status
  mp-auth.js                        # mini-program identity: code2Session + platform JWT (Bearer)
  spawner.js                        # cell lifecycle: spawn, health, idle reap, shutdown
  proxy.js                          # HTTP + WebSocket forwarding; injects the verified identity
packages/core/                      # shared protocol core (WS client + chat store + REST clients)
                                    #   consumed by web/ and miniapp/ via file: — no build step
miniapp/                            # WeChat mini-program client (Taro + React)
  config/index.ts                   # webpack chain: @platform/core + zustand aliases
  src/lib/                          # runtime (auth/http/socket), markdown parser, canvas charts
  src/pages/chat|sessions/          # chat + read-only session history
scripts/
  test-cell-containment.mjs         # a cell writes only under its data roots
  test-cell-isolation.mjs           # two cells: no cross-cell state, events, or errors
  test-cell-gateway.mjs             # gateway auth, routing, sticky WS, restart, idle reap
  test-cell-bindings.mjs            # saved bindings are what a cell boots on
  test-mp-auth.mjs                  # mini-program login/Bearer/WS auth against a real gateway
  mp-stub-cell.mjs                  # stub cell used by test-mp-auth (not a test)
  test-ws-reconnect.mjs             # shared WsClient reconnect state machine
```

### Ops console (internal read-only board)

`ops-console` (fd-infra-deploy `all-services/prod/ops-console.yaml`) is the
internal operations board (spec: `openspec/specs/ops-console` in the paas
repo). NodePort **31890** on any node, e.g.
`http://<node-ip>:31890/` — every route except `/healthz` needs
`Authorization: Bearer <OPS_CONSOLE_TOKEN>` — or, better, just log in via
Logto: access is gated on membership in the Logto organization `ops-console`
(ID `tvs6wkjtn8ic`, carried by the ID token's organizations claim; fail-closed
when absent). To grant someone the board: Logto console → Organizations →
ops-console → Members → Add member. No redeploy needed. The tenant-roles
approach was tried and withdrawn — this Logto build never issues the roles
claim (see design D10). Secrets live only in the cluster Secret
`ops-console-secrets` (same rule as platform-secrets:

```bash
kubectl -n fd-prod get secret ops-console-secrets \
  -o jsonpath='{.data.OPS_CONSOLE_TOKEN}' | base64 -d; echo
```

The board's canonical URL is **https://paas-admin.finddatatech.cloud/** (SafeLine → Caddy on cheap-1 → NodePort 31890 over tailscale; the raw `http://<node-ip>:31890` still works VPN-side, and both redirect URIs are registered in Logto). Login is Logto SSO against the allowlist — visiting the board URL logged out auto-redirects to the sign-in page (API callers without a session keep a flat 401; send `Authorization: Bearer <token>`).

What it shows: cluster banner (per-node memory, 24h Evicted/OOM count,
Jenkins queue depth, ArgoCD sync), one vertical chain card per watched
deployment (replicas, image tag, `/api/ready` probe), Jenkins/Harbor blocks,
search-relay quota/cache stats, and a per-card **version-drift light**
comparing the running tag, the GitOps sync state, and the latest successful
Jenkins build's pushed tag — `newer-build-not-rolled` means a build exists
that was never rolled; `cluster-out-of-sync` means the cluster diverges from
the GitOps repo.

Updating the board's code: edit `services/ops-console/index.js` in the paas
repo, re-embed into the ConfigMap, push, then
`kubectl -n fd-prod rollout restart deploy/ops-console` — **subPath ConfigMap
mounts do not hot-update running pods** (same for search-relay's code).
Rollback is deleting the deployment; nothing else depends on the console.

### 实录续 2：6.2 全链路 ALL GREEN（2026-09-30 深夜）

`scripts/probe-agent-serving.mjs`（经 cheap1 `probe-wrapper.sh`：前置/后置扫删 probe 残留）对
staging 全链路七步全绿：deploy v1 → runner 拾取 → 健康复检出块 → 三层鉴权（匿名 401 /
仅网关凭证被 runner 401 / 双凭证 200 卡片）→ **真实 dsh 回合**（finddata/deepseek-v4.1-flash，
9.4s 含冷启，技能指令被遵守）→ SSE 流式 → v2 原地升级（排水、条目不增殖）→ 下线（监听器停）。
最终修形：**registry 技能按 name 全局键控**——部署库先按名查实际存储路径再 PUT（升级路径），
`skill_md_url` 指向 pack 网关的公开 md 路由（`AGENT_SERVING_PACKS_URL`），注册后安全扫描会
禁用 agent（库自动 toggle 回启用）。staging 栈：cheap1 容器 `agent-runner-dsh`
（node:22-slim + 挂载代码 + npmmirror 钉版 dsh 运行时，端口段 8790-8850 只绑尾网；
生产形态仍按 runbook 用平台镜像）。演练模型遵守用户规则 deepseek-v4.1-flash。

### 实录：agent-serving 全量上线 fd-prod（2026-10-01，sha-30edadc / GitOps 1108c15）

- **流程**（现行 canonical）：push main → `image.yml` 自动构建（3m18s，smoke 过）→ hkccr
  `sha-30edadc` → cheap-3 tcr-relay ≤5min 同步 ccr（**确认 RELAYED 后才 bump**，防
  ImagePullBackOff）→ `fd-infra-deploy` platform.yaml + platform-demo.yaml 双 bump →
  ArgoCD refresh → 新 pod Running，Synced/Healthy。
- **env 接线**（platform-config / platform-secrets，随本次 rollout 生效）：
  `AGENT_SERVING_RUNNER_URL=http://100.64.0.11`（staging runner 起步；正式迁移改新宿主
  origin 即可，端口由 `agentPortFor` 派生）、`AGENT_SERVING_PACKS_URL=https://craw.finddatatech.cloud`
  （技能 md 公开路由所在）、`AGENT_SERVING_BACKEND_TOKEN`（= runner 的
  AGENT_RUNNER_BACKEND_TOKEN，cheap1 `/opt/agent-runner-stage/.backend-token`；**轮换需两侧同步**）。
- **三验证**：`/api/ready` 200；`POST /api/packs/:id/versions/:v/deploy` 挂载（匿名 401）；
  registry 桥 agents 拉取 200（a2a: 0 —— 尚无带契约 pack，预期）。
- 注意：`kubectl rollout status` 在 pod 启动窗口可能超时报错——以 `get pods` +
  ArgoCD health 为准（本例即虚惊）。

### 实录：首个 Agent 服务上线（2026-10-01，§6.1 收口 — 21/21 全勾）

- **首部署**：pack「部署演示 · FingPt 分析师」v1（`vtdpsNmtW6OQ9I99mBhbDw`，一个技能 +
  一个 serving 契约角色）在 fd-prod 容器内经真实部署库发布+部署（`kubectl exec` +
  `createPackRegistry` + `deployToRegistry`，作者 ops-seed@finddatatech.cloud；
  bookkeeping 已记，详情页显示已部署 v1 在线）。**首对话**：经生产网关
  `/agent/packs/<id>/pack-demo-fingpt/` 一轮 message/send，runner（cheap1 staging）→
  专用 dsh 子进程 → deepseek-v4.1-flash，人设与技能指令严格生效（复述→结论→不编数）。
- **首部署三弹修复**（全部实弹暴露）：① registry 匿名抓取 skill_md_url 被 craw 会话门 401
  → `/api/packs/**.md` GET 进两个公开谓词（`isPublicRequest` + `isLogtoPublicRequest`，
  双谓词漏改一发）；② path-to-regexp 部分版本把 `.md` 留在路由参数 → 参数归一化；③
  dsh preset 插件 id 正则仅小写，base64url pack id 大小写混合 → runner preset id 小写化。
  伴生：staging runner 误写 `$PDD/packs.db`（正确是 `$PDD/data/packs.db`，已清）；
  matrix 启动门在 staging 用 `DSH_MATRIX_OVERRIDE=1`（手装树 vs 冻结锁差一包，报告照记）。
- **创作侧入口**：pack 编辑器新增「部署为 Agent 服务（A2A）」开关（sha-16cd264 起），
  市场 · 详情页「部署为服务」按钮即用。
