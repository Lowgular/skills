/**
 * trace-writer.mjs — append-only trace store for eval trials.
 *
 * Data model and rationale: ../LOGGING.md. In short:
 *
 *   index.ndjson              one ~250B line per trial — answers most questions alone
 *   <run>/trials/*.spans.ndjson   the tree (trial → turn → tool), one JSON per line
 *   <run>/blobs/sha256-*.json     payloads over 8KB, content-addressed (dedupes)
 *
 * Hierarchy is carried by `dotted_order`, borrowed from LangSmith:
 *
 *   <ts>Z<root_id>.<ts>Z<parent_id>.<ts>Z<own_id>
 *
 * Sorting those strings lexicographically yields depth-first order, and a prefix
 * match finds every descendant — so a flat file is queryable as a tree with no
 * index and no recursion. Timestamps carry microseconds because sibling spans
 * otherwise tie within the same millisecond and the sort becomes unstable.
 *
 * Everything is written as it happens and flushed per line: a killed or timed-out
 * trial must still leave a readable trace.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const BLOB_LIMIT = 8192;
const SCHEMA = 1;

/** Compact UTC stamp with microsecond precision: 20260726T083500123456 */
let lastMs = 0, seq = 0;
function stamp() {
  const now = Date.now();
  if (now === lastMs) seq++; else { lastMs = now; seq = 0; }
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const micros = p(d.getUTCMilliseconds(), 3) + p(Math.min(seq, 999), 3);
  return (
    d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + "T" +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + micros
  );
}

const iso = () => new Date().toISOString();

/**
 * Open a trace for one trial. Returns the root span plus close().
 *
 *   root      absolute log root (MUST be outside the eval workspace — the
 *             provider deletes the workspace on cleanup, taking traces with it)
 */
export function openTrace({ root, runId, task, trial = 1, attrs = {} }) {
  const runDir = join(root, runId);
  const trialsDir = join(runDir, "trials");
  const blobsDir = join(runDir, "blobs");
  for (const d of [trialsDir, blobsDir]) mkdirSync(d, { recursive: true });

  const spansPath = join(trialsDir, `${task}.${trial}.spans.ndjson`);
  const indexPath = join(root, "index.ndjson");
  const rawPath = join(trialsDir, `${task}.${trial}.raw.ndjson`);
  writeFileSync(spansPath, "");
  writeFileSync(rawPath, "");

  /** Spill anything large to a content-addressed blob. Identical payloads across
   *  trials (e.g. `figma.mjs pages --json`) then cost one copy, not N. */
  const store = (value) => {
    if (value === undefined || value === null) return value;
    let s;
    try { s = JSON.stringify(value); } catch { return { $unserializable: true }; }
    if (s.length <= BLOB_LIMIT) return value;
    const id = "sha256-" + createHash("sha256").update(s).digest("hex").slice(0, 32);
    const p = join(blobsDir, `${id}.json`);
    if (!existsSync(p)) writeFileSync(p, s);
    return { $blob: id, $bytes: s.length };
  };

  const write = (line) => { try { appendFileSync(spansPath, JSON.stringify(line) + "\n"); } catch {} };

  /** One span. Children inherit dotted_order, so the tree is implicit. */
  function makeSpan({ runType, name, parentDotted, traceId, parentId, inputs, spanAttrs, startAt }) {
    const id = randomUUID();
    const dotted = (parentDotted ? parentDotted + "." : "") + stamp() + "Z" + id;
    const tid = traceId || id;               // root span: trace_id is its own id
    // startAt lets a caller backdate a span. The agent stream carries no per-event
    // timestamps, so an assistant turn is only observable at the moment it lands;
    // dating it from the previous event is what makes its duration mean anything.
    const start = startAt || iso();
    let ended = false;

    const self = {
      id,
      trace_id: tid,
      dotted_order: dotted,

      /** Child span. Same signature; nesting is automatic. */
      span(runType2, name2, opts = {}) {
        return makeSpan({
          runType: runType2, name: name2, parentDotted: dotted, traceId: tid,
          parentId: id, inputs: opts.inputs, spanAttrs: opts.attrs, startAt: opts.startAt,
        });
      },

      end({ status = "success", error = null, outputs, tokens, cost_usd, attrs: extra } = {}) {
        if (ended) return self;             // idempotent: double-end must not duplicate a line
        ended = true;
        write({
          v: SCHEMA,
          dotted_order: dotted,
          id, trace_id: tid, parent_id: parentId || null,
          run_type: runType, name,
          start, end: iso(),
          status, error,
          attrs: { ...(spanAttrs || {}), ...(extra || {}) },
          inputs: store(inputs),
          outputs: store(outputs),
          tokens: tokens || null,
          cost_usd: cost_usd ?? null,
        });
        return self;
      },
    };
    return self;
  }

  const rootSpan = makeSpan({ runType: "chain", name: "trial", spanAttrs: { task, trial, ...attrs } });

  return {
    ...rootSpan,
    spansPath, rawPath, runDir, indexPath,

    /** Verbatim agent stream — the last resort when a summary loses something. */
    raw(obj) { try { appendFileSync(rawPath, JSON.stringify(obj) + "\n"); } catch {} },

    /**
     * Finish the trial and append the index line. `reward` is normally unknown
     * here — grading happens after the agent returns — so it stays null and
     * `logs.mjs --link` fills it in from skillgrade's results.
     */
    close({ status = "success", error = null, summary = {} } = {}) {
      rootSpan.end({ status, error, outputs: summary });
      const line = {
        v: SCHEMA,
        run: runId,
        task, trial,
        reward: null,
        trace_id: rootSpan.trace_id,
        status,
        spans: `${runId}/trials/${task}.${trial}.spans.ndjson`,
        ...summary,
      };
      try { appendFileSync(indexPath, JSON.stringify(line) + "\n"); } catch {}
      return line;
    },
  };
}

/** manifest.json — what makes two runs comparable, or proves they aren't. */
export function writeManifest(root, runId, data) {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ v: SCHEMA, run: runId, ...data }, null, 2));
}
