// ── Platform memory carrier: /proc scanning + cgroup headroom (zero-dep leaf)
//
// One source for container memory truth (harden-platform-memory-carrier): the
// gateway samples every node process in the pod, groups them by owning cell,
// and reads the container's cgroup usage/limit. Two consumers share this leaf:
// the /api/monitoring/memory read face (distribution display) and the cell
// residency admission gate (headroom verdict) — both read the SAME numbers so
// an operator never sees the gate decide from data the read face contradicts.
//
// Discipline: reads /proc and cgroup files only — zero new dependencies, no
// probes injected into measured processes, nothing written. Non-Linux hosts
// (macOS dev/desktop) have no /proc and no cgroup mount: every reader degrades
// honestly to { available: false } instead of throwing, and the admission gate
// fails open (spec: 计量缺失放行并告警).

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Role buckets (D2): four classes + the honest remainder. A cell's own server
// carries the cell root only in its cwd (cmdline is `node <repo>/server.js`);
// its dsh child carries it in cmdline patch args; MCP satellites inherit the
// dsh child's cwd — so attribution checks cwd AND cmdline, never the process
// tree (re-parented satellites have no reliable ppid).
export const MEMORY_ROLES = Object.freeze([
  "cell-server",
  "dsh-runtime",
  "mcp-satellite",
  "gateway",
  "ungrouped",
]);

function defaultCellsRoot() {
  // Same default the gateway resolves (CELL_DATA_ROOT || "cell-data"), made
  // absolute here because cwd readlinks and cmdline args are absolute paths.
  return path.resolve(process.env.CELL_DATA_ROOT || "cell-data");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Cell id = the 16-hex userId directory under the cells root (spawner.userIdFor).
function cellPathRegex(cellsRoot) {
  return new RegExp(`${escapeRegExp(cellsRoot)}/([0-9a-f]{16})(/|$)`);
}

function readCmdline(procRoot, pid) {
  // NUL-separated argv; a trailing NUL yields one empty string — drop it.
  const raw = readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8");
  return raw.split("\0").filter(Boolean);
}

function readCwd(procRoot, pid) {
  try {
    return readlinkSync(path.join(procRoot, String(pid), "cwd"));
  } catch {
    return null; // EACCES/ENOENT — attribution just loses one clue
  }
}

// First non-interpreter argv ending in a script extension — for node processes
// that is the served script (server.js, delegation-mcp.js, index.js), which is
// what an operator can match against a running deployment. argv0 otherwise.
function processName(args) {
  const script = args.slice(1).find((a) => /\.(js|mjs|cjs)$/.test(a));
  return path.basename(script ?? args[0] ?? "unknown");
}

function classifyCellRole(args, cmdline) {
  const script = args.slice(1).find((a) => /\.(js|mjs|cjs)$/.test(a)) ?? args[0] ?? "";
  if (/(^|\/)server\.[mc]?js$/.test(script)) return "cell-server";
  // The dsh runtime: the dsh CLI itself, or its bundled entry under a dsh dir.
  if (/(^|\/)dsh(\/|$)/.test(cmdline) || /\/dsh\/.+\.js$/.test(script)) return "dsh-runtime";
  return "mcp-satellite";
}

// One /proc pass: every readable pid → { pid, name, rssBytes, role, cellId }.
// Processes that vanish mid-scan are skipped (a racing exit is not an error).
// Attribution: cwd + cmdline clues first; then ONE step of ppid inheritance —
// a dsh runtime's stdio MCP satellites carry neither the cell path in cmdline
// nor a cell cwd (they inherit the deployment cwd /app), but their direct
// parent IS the attributed dsh process, and stdio satellites live and die with
// that parent. One step only (D2 rejected full tree-walking for re-parenting;
// a single hop reads the kernel's live ppid, where a transient orphan keeps
// no meaningful attribution either way).
export function scanProcesses({ procRoot = "/proc", cellsRoot = defaultCellsRoot() } = {}) {
  const cellRe = cellPathRegex(cellsRoot);
  const pageSize = os.pagesize?.() ?? 4096;
  const processes = [];
  let pids;
  try {
    pids = readdirSync(procRoot).filter((d) => /^\d+$/.test(d));
  } catch (e) {
    return { available: false, reason: `proc_unavailable: ${e.code ?? e.message}` };
  }
  for (const pid of pids) {
    try {
      const pages = readFileSync(path.join(procRoot, pid, "statm"), "utf8").trim().split(/\s+/);
      const resident = Number(pages[1]);
      if (!Number.isFinite(resident)) continue;
      const args = readCmdline(procRoot, pid);
      if (args.length === 0) continue; // kernel thread / zombie — no attribution possible
      const cmdline = args.join(" ");
      const cwd = readCwd(procRoot, pid);
      // Cell clue: cwd first (covers the cell server and inherited-cwd
      // satellites), then cmdline (covers dsh patch args).
      const cellMatch = (cwd && cwd.match(cellRe)) || cmdline.match(cellRe);
      let role = "ungrouped";
      let cellId = null;
      if (cellMatch) {
        cellId = cellMatch[1];
        role = classifyCellRole(args, cmdline);
      } else if (args.some((a) => /(^|\/)gateway\/index\.[mc]?js$/.test(a))) {
        // Per-argv match: the gateway runs as `node gateway/index.js` — a
        // relative script arg that neither starts the cmdline nor follows a
        // slash in the joined string (2026-11-02 live gap: the whole pod's
        // 100MB+ gateway process landed in ungrouped).
        role = "gateway";
      }
      let ppid = null;
      try {
        const stat = readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
        // field[2] = ppid, but comm may contain spaces/parens — split after
        // the last ')'.
        ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[1]);
      } catch { /* transient process — attribution proceeds without a parent */ }
      processes.push({ pid: Number(pid), name: processName(args), rssBytes: resident * pageSize, role, cellId, ppid });
    } catch {
      // statm/cmdline unreadable (process gone, permission) — skip honestly.
    }
  }
  // One-step inheritance for the clueless whose direct parent IS attributed.
  // A cell-attributed parent's clueless child is by construction that cell's
  // MCP satellite (the cell server and its dsh runtime carry their own
  // clues); the gateway's transient children stay in the gateway bucket.
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  for (const p of processes) {
    if (p.cellId || p.role !== "ungrouped") continue;
    const parent = p.ppid != null ? byPid.get(p.ppid) : null;
    if (!parent) continue;
    if (parent.cellId) {
      p.role = "mcp-satellite";
      p.cellId = parent.cellId;
    } else if (parent.role === "gateway") {
      p.role = "gateway";
    }
  }
  processes.sort((a, b) => b.rssBytes - a.rssBytes);
  return { available: true, processes };
}

// Container cgroup水位: v2 first (memory.current/memory.max), v1 fallback.
// "max"/-1 mean no limit — reported as limitBytes: null, headroom undefined
// (the gate then has nothing to enforce and fails open).
export function readContainerMemory({ cgroupRoot = "/sys/fs/cgroup" } = {}) {
  const readNum = (file) => {
    const raw = readFileSync(path.join(cgroupRoot, file), "utf8").trim();
    if (raw === "max") return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`malformed cgroup value: ${file}=${raw}`);
    return n;
  };
  try {
    const used = readNum("memory.current");
    const limit = readNum("memory.max");
    return { available: true, usedBytes: used, limitBytes: limit };
  } catch (v2Err) {
    try {
      const used = readNum("memory/memory.usage_in_bytes");
      const limit = readNum("memory/memory.limit_in_bytes");
      return { available: true, usedBytes: used, limitBytes: limit === -1 ? null : limit };
    } catch {
      return { available: false, reason: `cgroup_unavailable: ${v2Err.code ?? v2Err.message}` };
    }
  }
}

export function headroomPct({ usedBytes, limitBytes }) {
  if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return null;
  return (limitBytes - usedBytes) / limitBytes;
}

// Group a scan into the three-layer response shape (D4): cells[] (RSS 降序 by
// total), the gateway bucket, and the ungrouped remainder — the remainder is
// the drift detector: a future spawn shape that escapes attribution shows up
// here instead of silently inflating the gateway bucket.
export function groupScan(scan) {
  if (!scan.available) return scan;
  const cells = new Map();
  const gateway = [];
  const ungrouped = [];
  for (const p of scan.processes) {
    if (p.cellId) {
      if (!cells.has(p.cellId)) cells.set(p.cellId, []);
      cells.get(p.cellId).push(p);
    } else if (p.role === "gateway") {
      gateway.push(p);
    } else {
      ungrouped.push(p);
    }
  }
  const withTotal = (list) => ({
    totalBytes: list.reduce((s, p) => s + p.rssBytes, 0),
    processes: list,
  });
  const cellRows = [...cells.entries()]
    .map(([cellId, list]) => ({ cellId, ...withTotal(list) }))
    .sort((a, b) => b.totalBytes - a.totalBytes);
  return {
    available: true,
    sampledAt: Date.now(),
    cells: cellRows,
    gateway: withTotal(gateway),
    ungrouped: withTotal(ungrouped),
    buckets: Object.fromEntries(MEMORY_ROLES.map((r) => [r, scan.processes.filter((p) => p.role === r).length])),
  };
}

// The admission verdict (D3): pure, so the spawner's gate and the read face
// can never disagree. threshold <= 0 means the operator disabled the gate.
// Unreadable/malformed metrics fail OPEN with a reason (告警不阻断).
export function evaluateAdmission({ container, threshold }) {
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { decision: "allow", reason: "gate_disabled" };
  }
  if (!container?.available) {
    return { decision: "fail_open", reason: container?.reason ?? "metrics_unavailable" };
  }
  const pct = headroomPct(container);
  if (pct === null) {
    return { decision: "fail_open", reason: "container_metrics_malformed" };
  }
  const base = {
    usedBytes: container.usedBytes,
    limitBytes: container.limitBytes,
    headroomPct: pct,
    threshold,
  };
  if (pct < threshold) return { decision: "refuse", ...base };
  return { decision: "allow", ...base };
}

// Stateful sampler: one /proc+cgroup pass per TTL window, shared by every
// reader in the process (the monitoring route and the admission gate both
// call through here, so高频请求 never放大扫描开销 — spec: 缓存窗口单次扫描).
export function createProcMemorySampler({
  ttlMs = 2000,
  procRoot = "/proc",
  cellsRoot = defaultCellsRoot(),
  cgroupRoot = "/sys/fs/cgroup",
  now = Date.now,
} = {}) {
  let cached = null;
  let sampledAt = 0;
  function sample() {
    const t = now();
    if (cached && t - sampledAt < ttlMs) return cached;
    const scan = groupScan(scanProcesses({ procRoot, cellsRoot }));
    const snapshot = scan.available
      ? { ...scan, container: readContainerMemory({ cgroupRoot }) }
      : scan; // { available: false, reason }
    cached = snapshot;
    sampledAt = t;
    return snapshot;
  }
  return {
    sample,
    // Convenience for the gate: verdict + the evidence four-tuple in one call.
    admission(threshold) {
      return evaluateAdmission({ container: sample().container, threshold });
    },
    clearCache() {
      cached = null;
      sampledAt = 0;
    },
  };
}
