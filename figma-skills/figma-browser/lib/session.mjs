/**
 * session.mjs — what task is running right now, resolved.
 *
 * A runtime that invokes this skill knows things the skill cannot work out for
 * itself: which task this is, which design system the task is about, where the
 * trace should go. It is invoked once per task, so it resolves all of that ONCE,
 * at the top, and hands it down. Every tool call underneath just reads.
 *
 * That is the whole point: no tool resolves configuration. `figma.mjs` does not
 * look up a file key, does not read a slug, does not know what a slug is or that
 * .env exists. It reads `figma_url` and opens it.
 *
 * WHY IT TRAVELS IN THE ENVIRONMENT
 *
 * The tools are separate processes, and the model types `node figma.mjs vars …`
 * itself — so nothing can be handed to them as an argument. A newborn process
 * gets argv, cwd, stdin and its environment. The environment is the only one of
 * those that a parent controls, that reaches a grandchild automatically, and
 * that lives in memory rather than on disk.
 *
 * A file would work too, and was the first shape of this. The environment is
 * better for one reason: a file outlives its writer, so it needs a staleness
 * check, cleanup on every exit path, and a gitignore entry — machinery that
 * exists purely to undo the persistence nobody wanted. Environment inheritance
 * is scoped to the process tree by construction. When the task ends, its session
 * is already gone.
 *
 * ONE VARIABLE, ONE READER
 *
 * This is not "config in env vars" — that is the thing it replaces. It is one
 * opaque record, written by the layer that has the task config, read by one
 * function. Adding a second fact to the session does not add a second variable.
 */

const SESSION_ENV = "FIGMA_SESSION";

/**
 * This process's session. An in-memory object, hydrated at most once.
 *
 * Two layers, and the distinction is the whole design:
 *
 *   in memory   `session` — what this process works with. Set directly by a
 *               runtime, or hydrated from the transport on first read.
 *   transport   one env var — how it crosses a spawn, and ONLY that.
 *
 * A module-level variable cannot cross a process boundary: `figma.mjs` is a
 * different OS process with its own heap, so it imports this module fresh and
 * sees `null`. The env var exists solely to bridge that one gap. Everything
 * after the bridge is this object.
 */
let session = null;

/**
 * The current task's context, or null.
 *
 * Returns rather than throws, because a human typing `figma.mjs vars` has no
 * session and must still work. Callers read null as "resolve it the ordinary
 * way" — which for a single design system means the sole binding, i.e. no
 * config at all. Use requireSession() where absence is genuinely a bug.
 */
export function readSession() {
  if (session) return session;
  const raw = process.env[SESSION_ENV];
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (s && typeof s === "object") session = s;
  } catch {}
  return session;
}

/** Same, for a caller that cannot proceed without one. */
export function requireSession() {
  const s = readSession();
  if (!s) throw new Error(`no session — a runtime must call setSession() before spawning`);
  return s;
}

/**
 * Called by a runtime, once, before it starts the agent. Sets the session for
 * THIS process and returns the env fragment that carries it to children — the
 * caller stays in control of the spawn.
 *
 * @param task       what is being run, for the record and for logs
 * @param figmaFile  the slug from the task config
 * @param figmaKey   that slug resolved against .env — the RUNTIME does this,
 *                   because the runtime is the layer that knows the task
 * @param extra      anything else tools may want: trace_id, run, trial
 */
export function setSession({ task = null, figmaFile = null, figmaKey = null, ...extra } = {}) {
  session = {
    v: 1,
    task,
    figma_file: figmaFile,
    // Resolved up here so no tool has to. The URL is what a tool actually
    // needs — it is how cdp.mjs finds the right Chrome tab.
    figma_url: figmaKey ? `https://www.figma.com/design/${figmaKey}/` : null,
    figma_key: figmaKey,
    ...extra,
  };
  return { [SESSION_ENV]: JSON.stringify(session) };
}
