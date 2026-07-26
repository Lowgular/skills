/**
 * cdp.mjs — a minimal Chrome DevTools Protocol client. ZERO dependencies.
 *
 * GENERIC ON PURPOSE. Nothing in this file knows about Figma. It does three
 * things, which is all any "drive a real browser" task needs:
 *
 *   connect()   attach to a tab (picked by URL substring)
 *   evaluate()  run JS in that tab and get the JSON result back
 *   waitFor()   evaluate repeatedly until truthy or timeout
 *
 * Why not playwright/puppeteer: their headline feature is a DOM locator engine
 * (getByRole/getByText), which is worth nothing against a WebGL canvas. Apps
 * that expose their own JS API are queried through that API. Node 24 ships a
 * global WebSocket and fetch, so the protocol needs no packages at all.
 *
 * Runtime: Node 22+ (global WebSocket). NOT Bun — its websocket stack can't
 * complete the CDP handshake.
 */

const DEFAULT_TIMEOUT = 15_000;

/** List debuggable targets. */
export async function targets(port = 9333) {
  const r = await fetch(`http://localhost:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw new Error(`CDP /json/list returned ${r.status}`);
  return r.json();
}

/** Force a tab into existence — /json/list can legitimately be empty. */
export async function newTab(url, port = 9333) {
  const r = await fetch(`http://localhost:${port}/json/new?${url}`, {
    method: "PUT",
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`CDP /json/new returned ${r.status}`);
  return r.json();
}

/**
 * Attach to the first page target whose URL contains `match`.
 * If none matches and `openUrl` is given, opens a tab and attaches to that.
 */
export async function connect({ port = 9333, match = "", openUrl = null } = {}) {
  let list = (await targets(port)).filter((t) => t.type === "page");
  let target = list.find((t) => t.url.includes(match));

  if (!target && openUrl) {
    await newTab(openUrl, port);
    for (let i = 0; i < 20 && !target; i++) {
      await new Promise((r) => setTimeout(r, 500));
      list = (await targets(port)).filter((t) => t.type === "page");
      target = list.find((t) => t.url.includes(match));
    }
  }
  if (!target) {
    throw new Error(
      `no page target matching "${match}" on :${port}` +
        (list.length ? ` — open tabs: ${list.map((t) => t.url).join(", ")}` : " — no tabs at all"),
    );
  }
  return new CDP(target, port);
}

class CDP {
  constructor(target, port) {
    this.target = target;
    this.port = port;
    this._id = 0;
    this._pending = new Map();
    this._ws = null;
  }

  get url() {
    return this.target.url;
  }

  async _socket() {
    if (this._ws && this._ws.readyState === 1) return this._ws;
    const ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP websocket open timed out")), 10_000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("CDP websocket error"));
      });
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg.id === undefined) return; // an event, not a reply — ignored
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(`${msg.error.message} (${msg.error.code})`)) : p.resolve(msg.result);
    });
    this._ws = ws;
    return ws;
  }

  /** Raw protocol call, e.g. send("Page.navigate", { url }). */
  async send(method, params = {}, timeoutMs = DEFAULT_TIMEOUT) {
    const ws = await this._socket();
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Run JS in the page and return its value.
   *
   * `expr` is an EXPRESSION, not a statement list — a bare function source is
   * returned uncalled. Call it inline:
   *   evaluate(`(${FN})(${JSON.stringify(args)})`)
   *
   * Promises are awaited and results returned by value (so plain JSON only).
   */
  async evaluate(expr, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
    const r = await this.send(
      "Runtime.evaluate",
      { expression: expr, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const e = r.exceptionDetails;
      throw new Error(`page threw: ${e.exception?.description || e.text || "unknown"}`);
    }
    return r.result?.value;
  }

  /**
   * Poll an expression until it returns something truthy.
   * This is the generic replacement for a selector engine's auto-waiting —
   * readiness, canvas settling, login polling all reduce to this.
   */
  async waitFor(expr, { timeoutMs = 30_000, intervalMs = 500, label = "condition" } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expr, { timeoutMs: Math.min(5000, timeoutMs) });
        if (last) return last;
      } catch (e) {
        last = String(e.message || e);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms — last: ${JSON.stringify(last)}`);
  }

  async navigate(url, { waitMs = 0 } = {}) {
    await this.send("Page.enable").catch(() => {});
    await this.send("Page.navigate", { url });
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
  }

  /** Current URL, re-read from the target list (survives navigation). */
  async currentUrl() {
    const t = (await targets(this.port)).find((x) => x.id === this.target.id);
    return t ? t.url : this.target.url;
  }

  close() {
    try {
      this._ws?.close();
    } catch {}
    this._ws = null;
  }
}
