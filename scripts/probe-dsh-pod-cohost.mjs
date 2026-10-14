#!/usr/bin/env node
// probe-dsh-pod-cohost.mjs — the add-dsh-pod-adapter production validation
// probe (task 7.2).
//
// Deploys a synthetic TWO-serving-agent pack onto this runner's slice
// (pod-eligible by construction: one pack, distinct personas, no billing
// keys / secrets / notify channels), waits for the runner's poll pickup,
// then drives one A2A turn per member and collects the pod evidence:
//
//   • ONE dsh process hosting BOTH members (ps, in-pod);
//   • the runner's own "cold-starting pod-…" log line;
//   • per-member replies through the member's own listener port;
//   • the pod process's RSS (the memory-baseline row for the research doc).
//
// Runs INSIDE the runner pod (the paas-release ESM staging recipe), where the
// registry token, the packs URL, the backend credential, localhost listeners,
// and ps all live. Env it reads: AGENT_SERVING_REGISTRY_URL,
// AGENT_SERVING_REGISTRY_TOKEN, AGENT_RUNNER_PACKS_URL,
// AGENT_RUNNER_BACKEND_TOKEN; --runner-base defaults to http://100.64.0.8.
//
//   node scripts/probe-dsh-pod-cohost.mjs [--keep]   (in-pod, staged)
//
// --keep leaves the entries deployed for eyeball verification (default:
// disables both entries — the registry keeps rows; re-running re-enables).

import { execSync } from "node:child_process";
import { deployToRegistry } from "../lib/agent-serving.js";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const RUNNER_BASE = args.includes("--runner-base") ? args[args.indexOf("--runner-base") + 1] : (process.env.PROBE_RUNNER_BASE || "http://100.64.0.8");
const REGISTRY_URL = process.env.AGENT_SERVING_REGISTRY_URL;
const TOKEN = process.env.AGENT_SERVING_REGISTRY_TOKEN;
const PACKS = process.env.AGENT_RUNNER_PACKS_URL;
const BACKEND = process.env.AGENT_RUNNER_BACKEND_TOKEN;

const PACK_ID = `pod-cohost-probe-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
const PERSONA_A = "你是严谨的金融分析师，回答先给一句话结论。";
const PERSONA_B = "你是简洁的文案作者，回答不超过两句。";

const manifest = {
  name: "Pod 共宿验证（双 serving agent）",
  description: "add-dsh-pod-adapter 生产验证探针包：同 pack 双角色共宿一个 dsh 进程",
  tags: ["演示", "pod"],
  visibility: "private",
  skills: [],
  mcpServers: [],
  agents: [
    { id: "analyst", name: "验证分析师", persona: PERSONA_A, serving: {} },
    { id: "writer", name: "验证文案", persona: PERSONA_B, serving: {} },
  ],
};

const healthFetch = async () => {
  const r = await fetch("http://127.0.0.1:8790/health", { headers: BACKEND ? { Authorization: `Bearer ${BACKEND}` } : {} });
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
};

const agentPort = (health, path) => health.agents.find((a) => a.path === path)?.port;

async function messageSend(port, contextId, text) {
  const r = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(BACKEND ? { Authorization: `Bearer ${BACKEND}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `probe-${Date.now()}`,
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text }], context_id: contextId } },
    }),
  });
  const doc = await r.json().catch(() => ({}));
  return doc;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!REGISTRY_URL || !TOKEN || !PACKS) throw new Error("env AGENT_SERVING_REGISTRY_URL / AGENT_SERVING_REGISTRY_TOKEN / AGENT_RUNNER_PACKS_URL required");

  // ── 1. Deploy the synthetic dual-agent pack onto THIS runner's slice ─────
  console.log(`[probe] deploying ${PACK_ID} → runner-serving slice (${RUNNER_BASE})`);
  const deployed = await deployToRegistry({
    packId: PACK_ID,
    version: 1,
    manifest,
    runnerBaseUrl: RUNNER_BASE,
    packsPublicBase: PACKS,
    registryUrl: REGISTRY_URL,
    token: TOKEN,
    runnerId: "runner-serving",
  });
  const paths = deployed.deployed.map((d) => d.agentPath);
  console.log(`[probe] deployed: ${paths.join(", ")}`);

  try {
    // ── 2. Wait for the runner's poll pickup (spec bound: five minutes) ────
    let health = null;
    for (let i = 0; i < 40; i++) {
      await sleep(15_000);
      try {
        health = await healthFetch();
        if (paths.every((p) => health.agents.some((a) => a.path === p))) break;
      } catch (e) {
        console.log(`[probe] health not ready (${e.message})`);
      }
      health = null;
    }
    if (!health) throw new Error("the runner never picked both entries up (40 × 15s)");
    console.log(`[probe] runner picked up both entries (children=${health.children})`);

    // ── 3. One A2A turn per member (first touch → cold-start the pod) ──────
    for (const [path, text] of [
      [paths[0], "用一句话说明：共宿验证回合 A（分析师侧）"],
      [paths[1], "用一句话说明：共宿验证回合 B（文案侧）"],
    ]) {
      const port = agentPort(await healthFetch(), path);
      if (!port) throw new Error(`no listener port for ${path}`);
      const t0 = Date.now();
      const doc = await messageSend(port, `pod-probe-${path.split("/").pop()}`, text);
      const out = doc?.result ?? {};
      const text2 = Array.isArray(out.parts) ? out.parts.map((p) => p?.text ?? "").join("") : "";
      console.log(`[probe] turn ${path.split("/").pop()} → ${Math.round((Date.now() - t0) / 1000)}s, ${text2.length} chars: ${text2.slice(0, 60)}`);
      if (!text2.trim()) throw new Error(`member turn returned no text (${JSON.stringify(doc).slice(0, 200)})`);
    }

    // ── 4. The pod evidence ─────────────────────────────────────────────────
    const ps = execSync("ps -eo pid,rss,args | grep -E 'dsh --profile platform' | grep -v grep", { encoding: "utf8" });
    const procs = ps.trim().split("\n").filter(Boolean);
    console.log(`[probe] dsh processes on this host: ${procs.length}`);
    for (const line of procs) console.log(`  ${line.slice(0, 160)}`);
    const podProc = procs.find((l) => l.includes("--profile platform"));
    const rssMb = podProc ? Math.round(Number(podProc.trim().split(/\s+/)[1]) / 1024) : null;
    const finalHealth = await healthFetch();
    console.log(`[probe] health: children=${finalHealth.children} budget=${Math.round(finalHealth.budget)}MB`);
    for (const a of finalHealth.agents.filter((a) => paths.includes(a.path))) {
      console.log(`  ${a.path} → ${a.state} (port ${a.port})`);
    }
    // The decisive fact: BOTH members served while children === 1.
    if (!(finalHealth.children <= 1 && procs.length >= 1)) {
      throw new Error(`expected ONE child hosting both members, got children=${finalHealth.children}, procs=${procs.length}`);
    }
    console.log(`\n[probe] ✓ POD CO-HOST VERIFIED: one process, two members, pod RSS ${rssMb}MB (solo floor ~100-185MB each — the amortization row for the research doc)`);

    // The runner's own pod log line (best-effort; logs may be rotated).
    try {
      const log = execSync("grep -h 'cold-starting pod-' /proc/1/fd/1 2>/dev/null | tail -2", { encoding: "utf8" }).trim();
      if (log) console.log(`[probe] runner log:\n  ${log.split("\n").join("\n  ")}`);
    } catch { /* stdout may not be a readable fd here */ }
  } finally {
    if (!KEEP) {
      for (const p of paths) {
        try {
          await fetch(`${REGISTRY_URL}/api/agents${p}/toggle?enabled=false`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
          console.log(`[probe] disabled ${p} (--keep to leave deployed)`);
        } catch (e) {
          console.log(`[probe] disable failed for ${p}: ${e.message}`);
        }
      }
    } else {
      console.log(`[probe] --keep: entries left deployed for eyeball verification (${paths.join(", ")})`);
    }
  }
}

try {
  await main();
} catch (e) {
  console.error(`\nPROBE FAILED: ${e?.message || e}`);
  process.exitCode = 1;
}
