#!/bin/sh
# Claude Code hook wrapper for graders/session-stamp.mjs.
#
# A wrapper rather than the script path directly, for two reasons:
#
#   /work is the bind mount and /workspace is the baked copy. Preferring /work
#   means the hook can be edited and re-run without rebuilding the image, the
#   same bargain the skill itself gets.
#
#   A hook that exits non-zero on UserPromptSubmit can block the turn. If
#   neither copy is present — a bare `docker run` of the image with nothing
#   mounted — this exits 0 and the trial proceeds untraced, which is the right
#   failure: bookkeeping must never cost a trial.
#
# exec, so stdin (the hook payload) passes straight through.
f=/work/graders/session-stamp.mjs
[ -f "$f" ] || f=/workspace/graders/session-stamp.mjs
[ -f "$f" ] || exit 0
exec node "$f"
