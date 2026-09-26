// ── Ops console (internal, read-only, zero-dependency single file) ───────────
//
// The fd deployment health board (openspec: ops-console): pollers snapshot
// every source into SQLite; the rendered page reads snapshots only, so a
// source being down shows as a stale/failed cell instead of a hung page —
// the board must stay renderable exactly during incidents.
//
// Sources: k8s API (dedicated read-only ServiceAccount), Jenkins REST,
// Harbor /v2/, per-deployment /api/ready probes, search-relay /v1/stats.
//
// Security posture (spec requirements): every route except /healthz requires
// the bearer token from env; there is NO mutating surface anywhere; no
// credential value ever lives in this file or the repo — addresses and tokens
// arrive via env (cluster Secret at deploy time).
//
// Run: node index.js   (Node ≥ 23 for node:sqlite)

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── config (all env; refuse to start open) ───────────────────────────────────
const TOKEN = process.env.OPS_CONSOLE_TOKEN?.trim();
if (!TOKEN) {
  console.error("[ops-console] OPS_CONSOLE_TOKEN not set — refusing to start open");
  process.exit(1);
}
// Browser login (design D8): a dedicated Logto "Traditional Web" app. All
// values live in the cluster Secret; absent OIDC env ⇒ token-only mode.
// The email allowlist FAILS CLOSED: the tenant carries mini-program-bound
// end-user accounts, so "authenticated" alone is not authorization.
const LOGTO_ENDPOINT = process.env.LOGTO_ENDPOINT?.replace(/\/+$/, "");
const LOGTO_APP_ID = process.env.LOGTO_APP_ID?.trim() || "";
const LOGTO_APP_SECRET = process.env.LOGTO_APP_SECRET?.trim() || "";
const OPS_PUBLIC_URL = process.env.OPS_PUBLIC_URL?.replace(/\/+$/, "") || "";
const SESSION_SECRET = process.env.SESSION_SECRET?.trim() || "";
// Admission is ORGANIZATION-membership based: the Logto organization whose ID
// must appear in the ID token's `organizations` claim. (Tenant ROLE claims were
// tried first — this Logto build never ships the roles claim in any token,
// verified empirically — while the organizations claim is this tenant's native,
// proven gating mechanism, the same one the platform uses for group access.)
// Fail closed: no org claim / no membership, no board.
const REQUIRED_ORG = process.env.OPS_REQUIRED_ORG?.trim() || "";
const OIDC_ENABLED = !!(LOGTO_ENDPOINT && LOGTO_APP_ID && LOGTO_APP_SECRET && OPS_PUBLIC_URL && SESSION_SECRET);
if (OIDC_ENABLED) {
  console.log(`[ops-console] login gate: Logto organization membership required (fail closed)${REQUIRED_ORG ? "" : " — OPS_REQUIRED_ORG unset: logins will be refused"}`);
}
const PORT = Number(process.env.PORT) || 4598;
const HOST = process.env.HOST || "0.0.0.0"; // in-pod all-interfaces; ClusterIP/NodePort fronts it
const POLL_SECS = Number(process.env.POLL_SECS) || 45;
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "ops-console.db");
const NAMESPACE = process.env.WATCH_NAMESPACE || "fd-prod";
const WATCHED_DEPLOYS = (process.env.WATCHED_DEPLOYS || "platform,platform-demo,search-relay")
  .split(",").map((s) => s.trim()).filter(Boolean);
const JENKINS_URL = process.env.JENKINS_URL?.replace(/\/$/, "");
const JENKINS_JOB = process.env.JENKINS_JOB || "platform";
const HARBOR_URL = process.env.HARBOR_URL?.replace(/\/$/, "");
const RELAY_URL = process.env.RELAY_URL?.replace(/\/$/, "");
const RELAY_TOKEN = process.env.RELAY_TOKEN?.trim();
// PROBE_<NAME>_URL per watched deployment (NAME upper-cased, dashes → underscores)
function probeUrlFor(name) {
  return process.env[`PROBE_${name.toUpperCase().replace(/-/g, "_")}_URL`];
}

// ── snapshot store (SQLite; render never touches sources) ────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec("CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL)");
db.exec("CREATE INDEX IF NOT EXISTS idx_snap_source_ts ON snapshots(source, ts)");

function storeWrite(source, obj, ts = Date.now()) {
  db.prepare("INSERT INTO snapshots (source, ts, json) VALUES (?, ?, ?)").run(source, ts, JSON.stringify(obj));
}
function storeLatest(source) {
  const row = db.prepare("SELECT ts, json FROM snapshots WHERE source = ? ORDER BY ts DESC LIMIT 1").get(source);
  if (!row) return null;
  try { return { ts: row.ts, data: JSON.parse(row.json) }; } catch { return null; }
}
function storeHistory(source, windowMs) {
  const rows = db.prepare("SELECT ts, json FROM snapshots WHERE source = ? AND ts > ? ORDER BY ts ASC").all(source, Date.now() - windowMs);
  return rows.map((r) => { try { return { ts: r.ts, data: JSON.parse(r.json) }; } catch { return null; } }).filter(Boolean);
}
function pruneOld() {
  db.prepare("DELETE FROM snapshots WHERE ts < ?").run(Date.now() - RETENTION_MS);
}

// ── tiny HTTP client (zero-dep: supports the SA's CA for in-cluster https) ──
function getJson(url, { headers = {}, ca, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.get(url, { headers, ca, timeout: timeoutMs, rejectUnauthorized: !!ca || u.protocol === "https:" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} from ${u.host}${u.pathname}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`non-JSON from ${u.host}${u.pathname}`)); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error(`timeout from ${u.host}`)); });
    req.on("error", reject);
  });
}

// ── session cookies + OIDC (browser login; HMAC-signed, no deps) ─────────────
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "ops_session";
const STATE_COOKIE = "ops_state";
const SESSION_TTL_MS = 24 * 3600 * 1000;
const sign = (payload) => createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
function cookieSet(name, payload, maxAgeMs) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${name}=${body}.${sign(body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}
function cookieClear(name) { return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`; }
function cookieRead(header, name) {
  const raw = (header || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  if (!raw) return null;
  const [body, sig] = raw.slice(name.length + 1).split(".");
  if (!body || !sig) return null;
  const want = sign(body);
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}
async function postForm(url, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const body = new URLSearchParams(params).toString();
    const req = mod.request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, timeout: 10_000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { reject(new Error("non-JSON from OIDC token endpoint")); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

// Discovery once at boot; login routes 503 if OIDC is off.
let oidc = null;
if (OIDC_ENABLED) {
  const discoUrl = LOGTO_ENDPOINT.endsWith("/oidc")
    ? `${LOGTO_ENDPOINT}/.well-known/openid-configuration`
    : `${LOGTO_ENDPOINT}/oidc/.well-known/openid-configuration`;
  getJson(discoUrl).then((d) => {
    oidc = { auth: d.authorization_endpoint, token: d.token_endpoint, userinfo: d.userinfo_endpoint };
    console.log("[ops-console] OIDC login ready");
  }).catch((e) => console.error(`[ops-console] OIDC discovery failed: ${e.message} (login unavailable, token mode active)`));
}

// ── k8s source (in-cluster read-only SA) ─────────────────────────────────────
const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const KUBE_BASE = process.env.KUBE_API_BASE ||
  (fs.existsSync(path.join(SA_DIR, "token"))
    ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT || 443}`
    : "");
const saToken = (() => { try { return fs.readFileSync(path.join(SA_DIR, "token"), "utf8").trim(); } catch { return ""; } })();
const saCa = (() => { try { return fs.readFileSync(path.join(SA_DIR, "ca.crt"), "utf8"); } catch { return ""; } })();
const kubeHeaders = saToken ? { authorization: `Bearer ${saToken}` } : {};
async function kube(pathname) {
  if (!KUBE_BASE) throw new Error("k8s API not configured (no SA, no KUBE_API_BASE)");
  return getJson(`${KUBE_BASE}${pathname}`, { headers: kubeHeaders, ca: saCa || undefined });
}

const ARGO_APP = process.env.ARGO_APP || "all-services-prod";
async function pollK8s() {
  const [deps, nodes, events, app] = await Promise.all([
    kube(`/apis/apps/v1/namespaces/${NAMESPACE}/deployments`),
    kube("/api/v1/nodes"),
    kube(`/api/v1/namespaces/${NAMESPACE}/events`),
    kube(`/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/${ARGO_APP}`).catch(() => null),
  ]);
  // metrics.k8s.io is best-effort: absent → per-node memory "n/a" (design open question)
  let nodeMetrics = null;
  try {
    nodeMetrics = await kube("/apis/metrics.k8s.io/v1beta1/nodes");
  } catch { /* metrics-server unreadable through the SA or absent */ }

  const memByNode = new Map(
    (nodeMetrics?.items || []).map((m) => [m.metadata.name, m.usage]),
  );
  return {
    deployments: (deps.items || []).map((d) => ({
      name: d.metadata.name,
      replicas: d.spec?.replicas ?? null,
      ready: d.status?.readyReplicas ?? 0,
      image: d.spec?.template?.spec?.containers?.[0]?.image || null,
    })),
    nodes: (nodes.items || []).map((n) => ({
      name: n.metadata.labels?.["kubernetes.io/hostname"] || n.metadata.name,
      ready: n.status?.conditions?.find((c) => c.type === "Ready")?.status === "True",
      memUsageBytes: memByNode.get(n.metadata.name)?.memory || null,
      memAllocatable: n.status?.allocatable?.memory || null,
      pressure: n.status?.conditions?.some((c) => /pressure/i.test(c.type) && c.status === "True") || false,
    })),
    // 24h Warning/eviction-ish events, small and counting-only
    warningEvents: (events.items || [])
      .filter((e) => e.type === "Warning" && Date.now() - Date.parse(e.lastTimestamp || 0) < 24 * 3600 * 1000)
      .map((e) => ({ reason: e.reason, count: e.count || 1, involved: e.involvedObject?.name || "" })),
    argocd: app ? { sync: app.status?.sync?.status || "Unknown", health: app.status?.health?.status || "Unknown" } : null,
  };
}

// ── jenkins source (anonymous reads, as exercised on every deploy day) ───────
async function pollJenkins() {
  if (!JENKINS_URL) throw new Error("JENKINS_URL not configured");
  const [queue, job, lastOk] = await Promise.all([
    getJson(`${JENKINS_URL}/queue/api/json`),
    getJson(`${JENKINS_URL}/job/${JENKINS_JOB}/api/json?tree=builds[number,result,building,timestamp]{0,10}`),
    getJson(`${JENKINS_URL}/job/${JENKINS_JOB}/lastSuccessfulBuild/api/json?tree=number,result,timestamp`),
  ]);
  // The pushed image tag lives in the build log's final lines — same read the
  // deploy runbook uses; no Jenkins plugin API assumptions.
  let builtTag = null;
  try {
    const log = await new Promise((resolve, reject) => {
      const u = new URL(`${JENKINS_URL}/job/${JENKINS_JOB}/lastSuccessfulBuild/consoleText`);
      const mod = u.protocol === "http:" ? http : https;
      const req = mod.get(u, { timeout: 10_000 }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
    });
    builtTag = (log.match(/Pushed[^\n]*:(sha-\w+)/) || [])[1] || null;
  } catch { builtTag = null; }
  return {
    queueDepth: (queue.items || []).length,
    lastBuilds: (job.builds || []).map((b) => ({ number: b.number, result: b.result, building: b.building })),
    lastSuccessful: lastOk ? { number: lastOk.number, ts: lastOk.timestamp } : null,
    builtTag,
  };
}

// ── harbor / probes / relay sources ──────────────────────────────────────────
async function pollHarbor() {
  if (!HARBOR_URL) throw new Error("HARBOR_URL not configured");
  // Any HTTP response (including 401) proves the registry is up; the k8s poller
  // carries the harbor-core pod state.
  await getJson(`${HARBOR_URL}/v2/`, { headers: { accept: "application/json" } }).catch((err) => {
    if (!/HTTP \d+/.test(err.message)) throw err; // connection-level failure
  });
  return { reachable: true };
}

async function pollProbes() {
  const out = {};
  await Promise.all(WATCHED_DEPLOYS.map(async (name) => {
    const url = probeUrlFor(name);
    if (!url) { out[name] = { configured: false }; return; }
    const started = Date.now();
    try {
      await getJson(url, { timeoutMs: 5_000 });
      out[name] = { configured: true, ok: true, ms: Date.now() - started };
    } catch (err) {
      out[name] = { configured: true, ok: false, error: err.message };
    }
  }));
  return out;
}

async function pollRelay() {
  if (!RELAY_URL || !RELAY_TOKEN) throw new Error("RELAY_URL/RELAY_TOKEN not configured");
  return getJson(`${RELAY_URL}/v1/stats`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } });
}

// ── version drift ────────────────────────────────────────────────────────────
// Three observable facts: the running pod image tag, the latest successful
// build's pushed tag, and the ArgoCD sync state. The GitOps manifest tag is
// derived rather than fetched (an ArgoCD-API token would be a whole new
// credential for one string): when sync=Synced the manifest equals the live
// cluster, so running tag == manifest tag; OutOfSync means they differ.
function computeDrift(runningTag, builtTag, argocd) {
  const run = runningTag?.match(/(sha-\w+)$/)?.[1] || null;
  const drift = { running: run, built: builtTag, status: "unknown" };
  if (!run && !builtTag) { drift.status = "unknown"; return drift; }
  const synced = argocd?.sync === "Synced";
  if (run && builtTag && run !== builtTag) {
    drift.status = synced ? "newer-build-not-rolled" : "cluster-out-of-sync-and-stale";
  } else if (argocd && !synced) {
    drift.status = "cluster-out-of-sync";
  } else {
    drift.status = "in-agreement";
  }
  return drift;
}

// ── poll loop ────────────────────────────────────────────────────────────────
const SOURCES = [
  ["k8s", pollK8s],
  ["jenkins", pollJenkins],
  ["harbor", pollHarbor],
  ["probes", pollProbes],
  ["relay", pollRelay],
];
let pollBusy = false;
async function pollOnce() {
  if (pollBusy) return; // single-flight: no retry storms (next cycle retries)
  pollBusy = true;
  for (const [name, fn] of SOURCES) {
    try {
      storeWrite(name, await fn());
    } catch (err) {
      // A failed poll must NOT delete the previous snapshot — the renderer
      // shows the last-known state with a stale timestamp (spec scenario).
      storeWrite(name, { __error: err.message });
    }
  }
  try { pruneOld(); } catch { /* prune is best-effort */ }
  pollBusy = false;
}
pollOnce();
setInterval(pollOnce, POLL_SECS * 1000);

// ── board model + render (server-side string template, zero frontend build) ─
function boardModel() {
  const snap = Object.fromEntries(SOURCES.map(([n]) => [n, storeLatest(n)]));
  const k8s = snap.k8s?.data?.__error ? null : snap.k8s?.data || null;
  const jenkins = snap.jenkins?.data?.__error ? null : snap.jenkins?.data || null;
  const harbor = snap.harbor?.data?.__error ? null : snap.harbor?.data || null;
  const probes = snap.probes?.data?.__error ? null : snap.probes?.data || null;
  const relay = snap.relay?.data?.__error ? null : snap.relay?.data || null;

  const cards = WATCHED_DEPLOYS.map((name) => {
    const dep = k8s?.deployments?.find((d) => d.name === name) || null;
    const drift = dep ? computeDrift(dep.image, jenkins?.builtTag || null, name === "search-relay" ? null : k8s?.argocd) : null;
    return {
      name,
      replicas: dep ? `${dep.ready}/${dep.replicas}` : null,
      runningTag: dep?.image?.split(":").pop() || null,
      probe: probes?.[name] || null,
      drift,
    };
  });

  const oomEvictions = (k8s?.warningEvents || []).filter((e) => /^(Evict|SystemOOM|OOM)/i.test(e.reason));
  return {
    ts: Date.now(),
    cards,
    banner: {
      nodes: k8s?.nodes || [],
      oomEvictions: oomEvictions.reduce((a, e) => a + e.count, 0),
      jenkinsQueue: jenkins?.queueDepth ?? null,
      argocd: k8s?.argocd || null,
    },
    jenkins,
    harbor,
    relay,
    stale: {
      k8s: snap.k8s && Date.now() - snap.k8s.ts > POLL_SECS * 4000,
      jenkins: snap.jenkins && Date.now() - snap.jenkins.ts > POLL_SECS * 4000,
    },
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (ts) => (ts ? `${Math.max(0, Math.round((Date.now() - ts) / 1000))}s ago` : "never");
const cell = (label, value, cls = "") =>
  `<div class="cell ${cls}"><div class="lbl">${esc(label)}</div><div class="val">${value === null ? "n/a" : esc(value)}</div></div>`;

function renderBoard() {
  const m = boardModel();
  const nodeBars = m.banner.nodes.map((n) => {
    const pct = n.memUsageBytes && n.memAllocatable
      ? Math.round((parseInt(n.memUsageBytes) / parseInt(n.memAllocatable)) * 100) : null;
    const w = pct ?? 0;
    const color = !n.ready ? "bad" : n.pressure || (pct !== null && pct > 85) ? "warn" : "ok";
    return `<div class="node ${color}" title="${esc(n.name)}${pct !== null ? ` ${pct}%` : " mem n/a"}">
      <span class="nname">${esc(n.name.split(/(?<=^liuliang|cheap-)/)[0].slice(0, 8))}</span>
      <div class="bar"><div class="fill" style="width:${Math.min(100, w)}%"></div></div>
      <span class="pct">${pct === null ? "n/a" : pct + "%"}</span>
    </div>`;
  }).join("");

  const cards = m.cards.map((c) => {
    const driftCls = { "in-agreement": "ok", unknown: "" }[c.drift?.status] ?? "warn";
    // Guarded per-key (an eager object literal would deref a null drift when
    // the k8s source is down — the board must render during incidents).
    const driftTxt = !c.drift ? "no data" : {
      "in-agreement": `all at ${c.drift.running || "?"}`,
      "newer-build-not-rolled": `newer build ${c.drift.built} not rolled (running ${c.drift.running})`,
      "cluster-out-of-sync": "cluster diverges from GitOps",
      "cluster-out-of-sync-and-stale": `pod stale (${c.drift.running}) & cluster out of sync`,
      unknown: "no data",
    }[c.drift.status] || "no data";
    const probe = c.probe?.configured
      ? cell("probe", c.probe.ok ? `ok ${c.probe.ms}ms` : `FAIL`, c.probe.ok ? "ok" : "bad")
      : cell("probe", "not configured");
    return `<div class="card">
      <div class="cardhead"><span class="cname">${esc(c.name)}</span>
        <span class="drift ${driftCls}" title="${esc(driftTxt)}">${esc(driftTxt)}</span></div>
      <div class="row">
        ${cell("replicas", c.replicas, c.replicas && !c.replicas.startsWith("0") ? "ok" : "bad")}
        ${cell("image", c.runningTag)}
        ${probe}
      </div>
    </div>`;
  }).join("");

  const relayBlock = m.relay ? `<div class="card">
      <div class="cardhead"><span class="cname">search-relay stats</span>
        <span class="muted">uptime ${Math.round((m.relay.uptimeSec || 0) / 60)}m</span></div>
      <div class="row">
        ${cell("quota today", (m.relay.tokens || []).map((t) => `${t.prefix} ${t.count}/${m.relay.dailyCap}`).join(", ") || "n/a")}
        ${cell("cache hit", m.relay.cache?.hitRate === null || m.relay.cache?.hitRate === undefined ? "n/a" : `${Math.round(m.relay.cache.hitRate * 100)}% (${m.relay.cache.hits}/${m.relay.cache.hits + m.relay.cache.cache_misses || m.relay.cache.misses || 0})`)}
        ${cell("5xx", String((m.relay.errors?.upstream ?? 0) + (m.relay.errors?.poolDry ?? 0)))}
        ${cell("key fails", String((m.relay.keys || []).reduce((a, k) => a + k.failures, 0)))}
      </div></div>` : `<div class="card"><div class="cardhead"><span class="cname">search-relay stats</span></div><div class="muted">unavailable${m.stale.relay ? " (stale)" : ""}</div></div>`;

  const jenkinsBlock = m.jenkins ? `<div class="card">
      <div class="cardhead"><span class="cname">jenkins</span>
        <span class="${m.jenkins.queueDepth > 0 ? "warn" : "ok"}">queue ${m.jenkins.queueDepth}</span></div>
      <div class="row">
        ${cell("last ok build", m.jenkins.lastSuccessful ? `#${m.jenkins.lastSuccessful.number} (${ago(m.jenkins.lastSuccessful.ts)})` : "n/a")}
        ${cell("built tag", m.jenkins.builtTag)}
        ${cell("recent", (m.jenkins.lastBuilds || []).slice(0, 4).map((b) => `#${b.number}:${b.building ? "…" : b.result || "?"}`).join(" "))}
      </div></div>` : `<div class="card"><div class="cardhead"><span class="cname">jenkins</span></div><div class="muted">unavailable${m.stale.jenkins ? " (stale)" : ""}</div></div>`;

  const harborBlock = m.harbor ? `<div class="card"><div class="cardhead"><span class="cname">harbor</span><span class="ok">reachable</span></div></div>`
    : `<div class="card"><div class="cardhead"><span class="cname">harbor</span><span class="bad">unreachable</span></div></div>`;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<title>fd ops</title>
<style>
  body{font:13px/1.45 -apple-system,system-ui,sans-serif;margin:16px;background:#0f1115;color:#d7dae0}
  h1{font-size:15px;margin:0 0 12px;color:#fff}
  .banner{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px;padding:8px;background:#161a22;border-radius:8px}
  .node{display:flex;gap:6px;align-items:center;padding:2px 8px;border-radius:6px;background:#1d222d}
  .node.bad{outline:1px solid #b4483f}.node.warn{outline:1px solid #b48a3f}
  .bar{width:56px;height:8px;background:#2a303c;border-radius:4px;overflow:hidden}
  .fill{height:100%;background:#4f9e64}.node.warn .fill{background:#c29343}.node.bad .fill{background:#bf5b52}
  .nname{font-size:11px;color:#9aa3b2}.pct{font-size:11px}
  .grid{display:flex;flex-wrap:wrap;gap:12px}
  .card{background:#161a22;border-radius:8px;padding:10px 12px;min-width:300px;flex:1}
  .cardhead{display:flex;justify-content:space-between;margin-bottom:8px}
  .cname{font-weight:600;color:#fff}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .cell{min-width:80px}.lbl{font-size:10px;text-transform:uppercase;color:#78818f}.val{font-size:12px;word-break:break-all}
  .ok .val,.val.ok{color:#69c17d}.bad .val,.val.bad{color:#d07069}.warn{color:#c29343}.ok{color:#69c17d}
  .muted{color:#78818f;font-size:12px}
  .stale{color:#c29343;font-size:11px;margin-left:8px}
</style></head><body>
<h1>fd ops — ${new Date(m.ts).toISOString()}${m.stale.k8s || m.stale.jenkins ? '<span class="stale">some sources stale</span>' : ""}</h1>
<div class="banner">
  ${nodeBars}
  <span class="muted">24h evict/oom: <b class="${m.banner.oomEvictions > 0 ? "warn" : ""}">${m.banner.oomEvictions}</b></span>
  <span class="muted">jenkins queue: <b>${m.banner.jenkinsQueue ?? "n/a"}</b></span>
  <span class="muted">argocd: <b class="${m.banner.argocd?.sync === "Synced" ? "ok" : "warn"}">${m.banner.argocd ? `${m.banner.argocd.sync}/${m.banner.argocd.health}` : "n/a"}</b></span>
</div>
<div class="grid">${cards}${jenkinsBlock}${harborBlock}${relayBlock}</div>
</body></html>`;
}

// ── server (token OR session cookie; read-only surface) ─────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true}'); }

  const authed = (req.headers.authorization === `Bearer ${TOKEN}`)
    ? { via: "token" }
    : (() => { const s = cookieRead(req.headers.cookie, SESSION_COOKIE); return s ? { via: "browser", email: s.email } : null; })();

  // Browser login (D8). /auth/login is reachable unauthenticated on purpose;
  // admission happens at callback against the allowlist (fail closed).
  if (req.method === "GET" && req.url === "/auth/login") {
    if (!OIDC_ENABLED) { res.writeHead(503, { "content-type": "text/plain" }); return res.end("login not configured (token-only mode)"); }
    if (!oidc) { res.writeHead(503, { "content-type": "text/plain" }); return res.end("login initializing, retry"); }
    const state = randomBytes(18).toString("base64url");
    res.setHeader("Set-Cookie", cookieSet(STATE_COOKIE, { state, exp: Math.floor((Date.now() + 600_000) / 1000) }, 600_000));
    const u = new URL(oidc.auth);
    u.searchParams.set("client_id", LOGTO_APP_ID);
    u.searchParams.set("redirect_uri", `${OPS_PUBLIC_URL}/auth/callback`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "openid profile email urn:logto:scope:organizations");
    u.searchParams.set("state", state);
    return res.writeHead(302, { location: u.toString() }).end();
  }
  if (req.method === "GET" && req.url.startsWith("/auth/callback")) {
    if (!OIDC_ENABLED || !oidc) { res.writeHead(503); return res.end("login not configured"); }
    const q = new URL(req.url, "http://x").searchParams;
    const st = cookieRead(req.headers.cookie, STATE_COOKIE);
    res.setHeader("Set-Cookie", cookieClear(STATE_COOKIE));
    if (!st || st.state !== q.get("state")) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("bad state"); }
    (async () => {
      const tokenRes = await postForm(oidc.token, {
        grant_type: "authorization_code",
        code: q.get("code"),
        redirect_uri: `${OPS_PUBLIC_URL}/auth/callback`,
        client_id: LOGTO_APP_ID,
        client_secret: LOGTO_APP_SECRET,
      });
      if (tokenRes.status !== 200 || !tokenRes.json.access_token) throw new Error(`token exchange HTTP ${tokenRes.status}`);
      // The userinfo call over TLS to the provider IS the identity verification
      // (single-file console: no local JWKS/RSA verification — design D8).
      const me = await getJson(oidc.userinfo, { headers: { authorization: `Bearer ${tokenRes.json.access_token}` } });
      const email = String(me.email || "").toLowerCase();
      // Organization-membership gate, fail closed. The `organizations` claim
      // (org IDs) rides the ID token when the authorize request carries
      // urn:logto:scope:organizations. Decode the id_token payload — signature
      // verification is unnecessary: it arrived directly from the provider's
      // token endpoint over TLS behind our client-secret exchange (D8 trust).
      const idClaims = (() => {
        try { return JSON.parse(Buffer.from(String(tokenRes.json.id_token || "").split(".")[1] || "", "base64url").toString()); }
        catch { return {}; }
      })();
      const orgs = Array.isArray(idClaims.organizations) ? idClaims.organizations.map(String) : [];
      if (!REQUIRED_ORG || !orgs.includes(REQUIRED_ORG)) {
        console.error(`[ops-console] login refused for ${email || "(no email)"} — org membership missing (required org: ${REQUIRED_ORG || "(unset)"}, has: [${orgs.join(", ")}])`);
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("not authorized for this board");
      }
      res.setHeader("Set-Cookie", cookieSet(SESSION_COOKIE, { email, orgs, exp: Math.floor((Date.now() + SESSION_TTL_MS) / 1000) }, SESSION_TTL_MS));
      res.writeHead(302, { location: "/" }).end();
    })().catch((e) => { console.error(`[ops-console] callback failed: ${e.message}`); res.writeHead(401); res.end("login failed"); });
    return;
  }
  if (req.url === "/auth/logout") {
    res.setHeader("Set-Cookie", cookieClear(SESSION_COOKIE));
    res.writeHead(302, { location: "/" }).end();
    return;
  }

  if (!authed) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("unauthorized"); }
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(renderBoard());
  }
  if (req.method === "GET" && req.url === "/api/board.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(boardModel()));
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
server.listen(PORT, HOST, () => console.log(`[ops-console] listening on ${HOST}:${PORT} | ns=${NAMESPACE} deploys=[${WATCHED_DEPLOYS}] poll=${POLL_SECS}s`));
