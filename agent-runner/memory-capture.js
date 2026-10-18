// Platform-seam memory capture (add-fleet-memory-v1 D6): the manager already
// sees every turn's outcome at the same seam usage events flow through — this
// client turns those observations into hooks-shaped events for the fleet
// memory capture API. Fail-open by contract: no capture failure may ever
// affect a turn, and gaps are logged, never retried forever.

const FLUSH_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

export class MemoryCapture {
  constructor({ url, token, fetchImpl = fetch, log = console, now = () => Date.now() } = {}) {
    this.url = String(url || "").replace(/\/+$/, "");
    this.token = String(token || "");
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.now = now;
    this.queue = [];
    this.timer = null;
    this.backoffMs = 0;
    this.droppedBatches = 0;
  }

  get enabled() {
    return Boolean(this.url && this.token);
  }

  // Observe a completed turn from the manager's viewpoint. Pure enqueue —
  // network happens on the flush timer, never on the turn's path.
  observe({ namespace, sessionId, summary, at }) {
    if (!this.enabled || !namespace || !sessionId) return;
    this.queue.push({
      event: "stop",
      session_id: String(sessionId),
      agent: "platform-manager",
      summary: String(summary ?? "").slice(0, 2000),
      at: at ?? new Date(this.now()).toISOString(),
    });
    this.#namespace = namespace;
    this.#scheduleFlush();
  }

  #namespace = null;
  #scheduleFlush() {
    if (this.timer) return;
    const delay = FLUSH_MS + this.backoffMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#flush().catch(() => {});
    }, delay);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async #flush() {
    if (this.queue.length === 0 || !this.#namespace) return;
    const events = this.queue.splice(0, 100);
    try {
      const res = await this.fetchImpl(`${this.url}/capture`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ events, namespace: this.#namespace }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.backoffMs = 0;
    } catch (e) {
      // Fail-open: the batch is dropped with a counted gap line, never
      // retried into infinity and never thrown into a turn's path.
      this.droppedBatches += 1;
      this.queue.unshift(...events.slice(0, Math.max(0, 100 - this.queue.length)));
      this.backoffMs = Math.min(MAX_BACKOFF_MS, (this.backoffMs || 1000) * 2);
      this.log.warn?.(`[agent-runner] memory capture gap #${this.droppedBatches} (${e.message}); turns unaffected`);
      this.#scheduleFlush();
    }
  }

  async drain() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.#flush().catch(() => {});
  }
}
