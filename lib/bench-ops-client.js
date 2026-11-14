// ── Bench ops client (openspec: add-bench-ops-tools) ─────────────────────────
//
// The fleet's four missing hands. `bench-proposal-client.js` gave the post an
// outlet for drafts; it did not give it a way to *find out what to do*, to take
// work, to close it, or to report what a round actually did. So the loop on the
// bench side was: a work order lands → nothing on this side can see it → a human
// copies it into a prompt → the round reports into nothing.
//
// Four functions, one per bench machine endpoint (docs/domain-proposal-contract.md
// "舰队执行面" in law-bench-internal is the shape authority — not this file):
//
//   listWorkOrders()          GET  /api/v1/distribution/{domain}/work-orders
//   claimWorkOrder(taskId)    POST …/work-orders/{id}/claim
//   completeWorkOrder(id, …)  POST …/work-orders/{id}/complete
//   recordRun({post, round})  POST …/runs
//
// Three deliberate properties, copied from the proposal client rather than
// re-invented (they were each a bug once):
//   • target/credential come from env and nowhere else — no default domain;
//     guessing one files work in the wrong inbox;
//   • `transport` is an injection seam so contract tests never open a socket.
//
// One property is deliberately NOT copied, and copying it was this module's
// first real defect: **the machine faces have their own credential, not the
// proposal face's.** `/api/v1/distribution/*` authenticates on `X-Consumer-Token`
// only (``_authenticate_consumer`` reads that header and nothing else), while the
// proposal route authenticates a *Logto user* — an `lbk_` api key on X-API-Key or
// a JWT on Bearer. Reusing ``authHeaders()`` therefore sent the wrong header on
// every path: an `lbk_` value rode X-API-Key (401 缺少机器凭据：X-Consumer-Token),
// anything else rode Bearer (same 401). Fourteen tests stayed green because every
// one of them injected `transport` and none looked at the headers it was handed.
//
// One property is NEW here and is the point of the module: **the fleet's own
// identity comes from the peer, not from config.** `listWorkOrders` answers with
// `fleet_ref`; `claim`/`complete`/`run` then build `source`/`runner_ref` from
// that value. A config-supplied prefix could name another fleet (impersonation
// with a typo), while the peer's answer is the identity it just authenticated.

import { fetchWithTimeout, isRetryableHttpStatus } from "./fetch-with-timeout.js";
import {
  BenchProposalError,
  REFUSALS,
  redact,
} from "./bench-proposal-client.js";

// Callers of this surface have to branch on the refusal kind (`not_deployed` is
// "wait / fix the URL", `forbidden` is "fix the credential"), so the error type
// and the shared kinds are re-exported here: the MCP child is a consumer of this
// module first and of the proposal client second, and having it import the error
// type from the module that only *uses* it is how the first version failed to
// link at all.
export { BenchProposalError, REFUSALS } from "./bench-proposal-client.js";

//: Refusal classes this surface adds to the shared ones. Every one of them has a
//: DIFFERENT remedy, which is the only reason to distinguish them:
//:   not_deployed — 404 with a generic body: the peer has not rolled the shard
//:                  that mounts these routes (or BENCH_URL points at the public
//:                  pod, which deliberately does not mount them). Remedy: wait /
//:                  fix the URL. Do NOT go looking at the credential.
//:   not_found    — 404 that names a domain or an order: the *thing* is missing.
//:   conflict     — 409: someone else claimed it, or you completed without
//:                  claiming. Retrying unchanged will not help.
//:   invalid      — 422: the body is out of vocabulary (outcome not in the four
//:                  states). Fix the report, not the network.
export const OPS_REFUSALS = Object.freeze({
  ...REFUSALS,
  NOT_DEPLOYED: "not_deployed",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  INVALID: "invalid",
});

const PREFIX = "/api/v1/distribution";

// ── config + credential ──────────────────────────────────────────────────────

//: ``BENCH_FLEET_TOKEN`` (the fleet registration's consumer token, sent as
//: X-Consumer-Token) is a DIFFERENT value from ``BENCH_CONSUMER_TOKEN`` (the
//: proposal face's Logto api key / JWT). They are not interchangeable and no
//: fallback between them can work — a wrong-value 403 「未登记」 would read as "the
//: fleet was deleted" rather than "you wired the other surface's credential".
const BENCH_FLEET_TOKEN_ENV = "BENCH_FLEET_TOKEN";

/**
 * Machine-surface config: url + domain from the shared names, credential from
 * the fleet-only name.
 *
 * Same failure style as ``resolveConfig``: name the missing env var, send no
 * request. The extra sentence exists because the neighbouring value is present
 * and plausible — the wrong one would otherwise be tried next.
 */
export function resolveOpsConfig(env = process.env) {
  const url = String(env.BENCH_URL || "").trim().replace(/\/+$/, "");
  const token = String(env[BENCH_FLEET_TOKEN_ENV] || "").trim();
  const domain = String(env.BENCH_PROPOSAL_DOMAIN || "").trim();
  const missing = [];
  if (!url) missing.push("BENCH_URL");
  if (!token) missing.push(BENCH_FLEET_TOKEN_ENV);
  if (!domain) missing.push("BENCH_PROPOSAL_DOMAIN");
  if (missing.length) {
    throw new BenchProposalError(
      REFUSALS.CONFIG,
      `bench ops target not configured: missing ${missing.join(", ")}` +
        (missing.includes(BENCH_FLEET_TOKEN_ENV)
          ? ` (${BENCH_FLEET_TOKEN_ENV} is the fleet's X-Consumer-Token; ` +
            `BENCH_CONSUMER_TOKEN belongs to the proposal face and cannot stand in for it)`
          : ""),
    );
  }
  return { url, token, domain };
}

//: The machine surface has exactly one credential channel. No prefix branch and
//: no second header: a value that *looks* like an api key is still just the
//: wrong value, and riding X-API-Key buys a 401 that names the missing header.
function machineAuthHeaders(token) {
  return { "x-consumer-token": token };
}

// ── transport ────────────────────────────────────────────────────────────────

// The headers are built by the caller and travelled here in the payload, so the
// `transport` seam (which is what every test injects) sees exactly the bytes
// that would hit the wire. Before that, the header lived in here and 14 tests
// could not have noticed it was the wrong one.
async function defaultTransport({ url, method = "GET", headers, body, timeoutMs }) {
  return fetchWithTimeout(
    url,
    {
      method,
      headers: { "content-type": "application/json", ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { timeoutMs },
  );
}

async function readJson(res) {
  try {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { detail: text };
    }
  } catch {
    return {};
  }
}

function classify(status, data, token, { domain, what }) {
  const detail = redact(String(data?.detail ?? data?.error ?? ""), token);
  const mk = (kind, message, retryable = false) =>
    new BenchProposalError(kind, redact(message, token), { status, detail, retryable });

  if (status === 401) {
    return mk(REFUSALS.AUTH, `401 unauthorized — the credential is missing or not a fleet ` +
      `registration${detail ? `: ${detail}` : ""}`);
  }
  if (status === 403) {
    return mk(REFUSALS.FORBIDDEN, `403 forbidden for '${what}' in domain '${domain}' — ` +
      `the token's registration does not own this${detail ? `: ${detail}` : ""}`);
  }
  if (status === 404) {
    // Generic body = the route is not there at all. A body that names a domain or
    // an order = the route is there and the *thing* is missing. Mixing these up
    // sends the operator to the wrong place (this exact confusion cost a round
    // trip on the bench's own reference client).
    const namesSomething = /域|domain|工单|order|task/i.test(detail);
    if (namesSomething) {
      return mk(OPS_REFUSALS.NOT_FOUND, `404 not found: ${detail || what}`);
    }
    return mk(
      OPS_REFUSALS.NOT_DEPLOYED,
      `404: the fleet machine surface is not deployed at this base URL ` +
        `(no ${what} route) — confirm the peer rolled an image that mounts it ` +
        `(bench: register_fleet.py --schema should answer 8/8 and the machine ` +
        `faces 401/403) and that BENCH_URL is the workbench origin, not the ` +
        `read-only public pod${detail ? `; peer said: ${detail}` : ""}`,
    );
  }
  if (status === 409) {
    return mk(OPS_REFUSALS.CONFLICT, `409 conflict: ${detail || what}`);
  }
  if (status === 422) {
    return mk(OPS_REFUSALS.INVALID, `422 rejected the body: ${detail || what}`);
  }
  if (status === 400) {
    return mk(OPS_REFUSALS.INVALID, `400 rejected the request: ${detail || what}`);
  }
  if (isRetryableHttpStatus(status)) {
    return mk(REFUSALS.SERVER, `${status} from the peer: ${detail || what}`, true);
  }
  return mk(REFUSALS.SERVER, `${status} from the peer: ${detail || what}`, false);
}

/**
 * One request against the machine surface.
 *
 * @param {string} method  GET | POST
 * @param {string} path    `/api/v1/distribution/{domain}/…` (domain already encoded)
 * @param {object} [opts]  `{ env?, transport?, timeoutMs?, body?, what? }`
 */
export async function callMachine(method, path, opts = {}) {
  const env = opts.env ?? process.env;
  const transport = opts.transport ?? defaultTransport;
  const timeoutMs = opts.timeoutMs ?? undefined;
  const { url, token, domain } = resolveOpsConfig(env);
  const what = opts.what ?? `${method} ${path}`;

  const target = `${url}${path.split("{domain}").join(encodeURIComponent(domain))}`;
  const headers = machineAuthHeaders(token);

  let res;
  try {
    res = await transport({ url: target, method, token, headers, body: opts.body, timeoutMs });
  } catch (err) {
    const timedOut =
      err?.code === "FETCH_TIMEOUT" ||
      err?.name === "FetchTimeoutError" ||
      err?.name === "AbortError" ||
      err?.name === "TimeoutError";
    throw new BenchProposalError(
      timedOut ? REFUSALS.TIMEOUT : REFUSALS.UNREACHABLE,
      redact(
        `${timedOut ? "bench ops timed out" : "bench ops unreachable"}: ${err?.message || err}`,
        token,
      ),
    );
  }

  const data = await readJson(res);
  if (!res.ok) throw classify(res.status, data, token, { domain, what });
  return data;
}

// ── the four hands ───────────────────────────────────────────────────────────

/**
 * What is waiting for this fleet in this domain.
 *
 * Returns `{ domain, fleet_ref, count, work_orders }` verbatim. Read-only on the
 * peer: no status change, no event, no pull footprint.
 */
export async function listWorkOrders(opts = {}) {
  const data = await callMachine("GET", `${PREFIX}/{domain}/work-orders`, {
    ...opts,
    what: "work-orders list",
  });
  return {
    domain: String(data?.domain ?? ""),
    fleetRef: String(data?.fleet_ref ?? ""),
    count: Number(data?.count ?? (Array.isArray(data?.work_orders) ? data.work_orders.length : 0)),
    workOrders: Array.isArray(data?.work_orders) ? data.work_orders : [],
  };
}

/**
 * The fleet's own ref, as the peer just authenticated it.
 *
 * This is why the module does not take a `fleet_ref` env: the authoritative
 * answer arrives with the list call. `opts.fleetRef` exists only so a caller
 * that already listed can avoid a second round trip.
 */
export async function resolveFleetRef(opts = {}) {
  const given = String(opts.fleetRef ?? "").trim();
  if (given) return given;
  const listed = await listWorkOrders(opts);
  if (!listed.fleetRef) {
    throw new BenchProposalError(
      REFUSALS.CONFIG,
      "the peer answered the work-order list without fleet_ref — cannot build an " +
        "identity prefix; refusing to guess one",
    );
  }
  return listed.fleetRef;
}

function requirePost(post) {
  const p = String(post ?? "").trim();
  if (!p) {
    throw new BenchProposalError(
      REFUSALS.CONFIG,
      "post is required: take it from the turn's identity line (`post=<ref>`) — it is " +
        "half of every idempotency key on the peer, and it is never inferred",
    );
  }
  if (/\s/.test(p)) {
    throw new BenchProposalError(REFUSALS.CONFIG, "post must be a single token with no whitespace");
  }
  return p;
}

//: The peer wraps every write answer in an envelope, and the three routes do not
//: use the same key: claim/complete ship `{task, created}` (claim also carries
//: `claimed_by`), runs ships `{run, created}`, and the proposal route ships the
//: row flat. Reading the fields off the envelope therefore returned `status: ""`
//: and `id: null` for a call that had actually succeeded — the round report said
//: "claimed" with no status, which is indistinguishable from a half-applied
//: claim. The unit tests could not see it: their fake transport replied with the
//: flat shape this module *assumed*, so the fixture encoded the bug.
//:
//: This helper is deliberately dumb (no schema sniffing): known envelope keys in
//: order, else the response itself. Every field read below goes through it.
const ENVELOPE_KEYS = ["task", "run", "proposal"];

function unwrapRow(data) {
  if (!data || typeof data !== "object") return {};
  for (const key of ENVELOPE_KEYS) {
    const inner = data[key];
    if (inner && typeof inner === "object") return inner;
  }
  return data;
}

/** Take one order. 409 = another fleet holds it; 403 = it is not ours. */
export async function claimWorkOrder(taskId, opts = {}) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BenchProposalError(REFUSALS.CONFIG, `taskId must be a positive integer, got ${taskId}`);
  }
  const data = await callMachine("POST", `${PREFIX}/{domain}/work-orders/${id}/claim`, {
    ...opts,
    what: `claim order ${id}`,
  });
  const row = unwrapRow(data);
  return {
    id: row?.id ?? id,
    status: String(row?.status ?? ""),
    claimedBy: String(row?.claimed_by ?? data?.claimed_by ?? ""),
    // `created:false` on a repeat claim is an idempotent hit, not a new claim —
    // the round report has to say which, or a retry looks like progress.
    created: data?.created !== false,
  };
}

/** Close one order. Must be claimed first (409 otherwise); never writes units. */
export async function completeWorkOrder(taskId, { note, artifactRefs } = {}, opts = {}) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BenchProposalError(REFUSALS.CONFIG, `taskId must be a positive integer, got ${taskId}`);
  }
  const body = {};
  if (note) body.note = String(note);
  if (artifactRefs !== undefined && artifactRefs !== null) body.artifact_refs = artifactRefs;

  const data = await callMachine("POST", `${PREFIX}/{domain}/work-orders/${id}/complete`, {
    ...opts,
    body,
    what: `complete order ${id}`,
  });
  const row = unwrapRow(data);
  return {
    id: row?.id ?? id,
    status: String(row?.status ?? ""),
    created: data?.created !== false,
  };
}

/**
 * Report one round: `runner_ref` is `fleet:<fleet_ref>/<post>#<round>`.
 *
 * Both halves are built here from the peer-reported fleet ref and the turn's own
 * post — never accepted as a literal. A hand-written prefix is how a report ends
 * up attributed to a fleet that did not run it.
 */
export async function recordRun(
  { post, round, role, outcome, counts, artifactRefs, remaining, detail, taskId } = {},
  opts = {},
) {
  const p = requirePost(post);
  const r = Number(round);
  if (!Number.isInteger(r) || r <= 0) {
    throw new BenchProposalError(REFUSALS.CONFIG, `round must be a positive integer, got ${round}`);
  }
  const role_ = String(role ?? "").trim();
  if (!role_) {
    throw new BenchProposalError(REFUSALS.CONFIG, "role is required (which seat ran this round)");
  }
  const fleetRef = await resolveFleetRef(opts);

  const body = {
    runner_ref: `fleet:${fleetRef}/${p}#${r}`,
    role: role_,
    outcome: String(outcome ?? "").trim(),
  };
  if (counts !== undefined && counts !== null) body.counts = counts;
  if (artifactRefs !== undefined && artifactRefs !== null) body.artifact_refs = artifactRefs;
  if (remaining !== undefined && remaining !== null) body.remaining = remaining;
  if (detail !== undefined && detail !== null) body.detail = detail;
  if (taskId !== undefined && taskId !== null) body.task_id = Number(taskId);

  const data = await callMachine("POST", `${PREFIX}/{domain}/runs`, {
    ...opts,
    body,
    what: "run report",
  });
  const row = unwrapRow(data);
  return {
    id: row?.id ?? null,
    runnerRef: String(row?.runner_ref ?? body.runner_ref),
    // Same `runner_ref` replayed = idempotent hit, nothing overwritten.
    created: data?.created !== false,
  };
}
