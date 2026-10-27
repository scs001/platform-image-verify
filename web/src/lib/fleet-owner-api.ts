// fleet-owner-api.ts — 主人经营坞读面与装作链的 typed client
// (add-fleet-owner-surface):
//   - 坞面总览(状态/告警/花销(a)投影): /api/fleets/owner/board;
//   - 机位占位(跨机可见): gateway 的 /api/fleets/owner/cells — 单机部署没有
//     gateway 代理面时 404=天然退化(honest absence, 不报错);
//   - 花销(c)粗粒度金额: 账户级 sub2api 快照窗口差, 口径随行;
//   - 装作链: from-template(参数槽) → start(点燃, 显式动作)。

function json(r: Response) {
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, json: () => r.json() });
  return r.json();
}

export interface OwnerBoardFleet {
  id: string;
  name: string;
  state: string;
  sourceTemplate: { packId: string; version: string | null } | null;
  counts: { onDuty: number; paused: number; missing: number; vacant: number; passive: number; failing: number; total: number };
  openDecisions: number;
  failing: number;
  lastActivityAt: number | null;
  spend: SpendProjection;
}

export interface SpendProjection {
  baseline: string;
  sampledAt: number;
  windows: Record<"24h" | "7d" | "30d", { runs: number; turns: number; usageInput: number | null; usageOutput: number | null }>;
  allTime: { runs: number; turns: number; usageInput: number | null; usageOutput: number | null };
}

export function fetchOwnerBoard() {
  return fetch("/api/fleets/owner/board").then(json) as Promise<{ v: number; sampledAt: number; fleets: OwnerBoardFleet[] }>;
}

export function fetchFleetSpend(fleetId: string) {
  return fetch(`/api/fleets/${encodeURIComponent(fleetId)}/spend`).then(json) as Promise<SpendProjection>;
}

export interface OwnerCellRow {
  cellId: string;
  state: string;
  placeholder: boolean;
  lastTrafficAt: number | null;
  lastDutyRunAt: number | null;
  policy: string;
}

export function fetchOwnerCells(): Promise<{ v: number; sampledAt: number; cells: OwnerCellRow[] } | null> {
  return fetch("/api/fleets/owner/cells")
    .then((r) => (r.status === 404 ? null : json(r)))
    .catch(() => null);
}

export interface BillingSnapshot {
  linked: boolean;
  balance: number | null;
  accountState: string | null;
  basis?: string;
  sampledAt?: number | null;
  deltas: Record<"24h" | "7d" | "30d", { spentUsd: number; baselineAt: number } | null> | null;
  panelUrl: string;
}

export function fetchBillingSnapshot() {
  return fetch("/api/packs/billing/snapshot").then(json) as Promise<BillingSnapshot>;
}

export interface ProvisionResult {
  ok: boolean;
  code?: string;
  error?: string;
  errors?: { name: string; error: string }[];
  fleet?: { id: string; name: string; state: string };
  deduped?: boolean;
  pausedAtBirth?: boolean;
  missing?: { ref: string; title: string; kind: string }[];
  conflicts?: { ref: string; title: string; kind: string }[];
}

export function provisionFromTemplate(packId: string, params: Record<string, unknown> | null) {
  return fetch("/api/fleets/from-template", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packId, ...(params ? { params } : {}) }),
  }).then((r) => r.json().then((body) => ({ status: r.status, body }))) as Promise<{ status: number; body: ProvisionResult }>;
}

export function startFleet(fleetId: string) {
  return fetch(`/api/fleets/${encodeURIComponent(fleetId)}/start`, { method: "POST" }).then(json);
}

// ── 迭代回路与 digest (fleet-owner-iteration) ────────────────────────────────

export interface SubUpdate {
  packId: string;
  name: string;
  subscribedVersion: number;
  latestVersion: number;
  publishedAt: number;
  notes: string | null;
}

export function subscriptionUpdates() {
  return fetch("/api/packs/subscriptions/updates").then(json) as Promise<{ updates: SubUpdate[] }>;
}

export interface IterationRow {
  id: string;
  fleetId: string;
  packId: string;
  decisionId: string | null;
  state: "proposed" | "approved" | "casting" | "publishing" | "published" | "failed";
  axis: string | null;
  note: string | null;
  notes?: string | null;
  publishedVersion: number | null;
  createdBy: string;
  createdAt: number;
}

export function proposeIteration(fleetId: string, doc: { summary: string; changes: Record<string, unknown>; diff?: unknown }) {
  return fetch(`/api/fleets/${encodeURIComponent(fleetId)}/iterations/propose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc),
  }).then(json) as Promise<{ decision: unknown; iteration: IterationRow }>;
}

export function listIterations(fleetId: string) {
  return fetch(`/api/fleets/${encodeURIComponent(fleetId)}/iterations`).then(json) as Promise<{ iterations: IterationRow[] }>;
}

export function retryIteration(fleetId: string, iterationId: string) {
  return fetch(`/api/fleets/${encodeURIComponent(fleetId)}/iterations/${encodeURIComponent(iterationId)}/retry`, { method: "POST" }).then(json) as Promise<{ ok: boolean; iteration: IterationRow }>;
}

export interface DigestSub {
  id: string;
  fleetId: string;
  ownerEmail: string;
  cadence: "daily" | "weekly";
  lastRunAt: number | null;
  fleetName?: string | null;
}

export function listDigestSubscriptions() {
  return fetch("/api/fleets/owner/digest-subscriptions").then(json) as Promise<{ subscriptions: DigestSub[] }>;
}

export function digestSubscribe(fleetId: string, cadence: "daily" | "weekly") {
  return fetch(`/api/fleets/${encodeURIComponent(fleetId)}/digest-subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cadence }),
  }).then(json) as Promise<{ subscription: DigestSub }>;
}

export function digestUnsubscribe(fleetId: string, cadence: "daily" | "weekly") {
  return fetch(`/api/fleets/${encodeURIComponent(fleetId)}/digest-subscribe/${encodeURIComponent(cadence)}`, { method: "DELETE" }).then(json);
}
