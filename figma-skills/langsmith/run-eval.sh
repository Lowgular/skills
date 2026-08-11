#!/bin/bash
# run-eval.sh — skillgrade, then ship the results to LangSmith as an experiment.
#
#   langsmith/run-eval.sh                         every task in eval.yaml
#   langsmith/run-eval.sh --eval=explain-4da43204 one task
#   langsmith/run-eval.sh --trials=3              anything skillgrade accepts
#   langsmith/run-eval.sh --model=claude-opus-5   which model answers
#
# --model is ours, not skillgrade's — its ClaudeAgent shells out to a bare
# `claude -p` with no --model flag, so the only lever is ANTHROPIC_MODEL in the
# environment. It is stripped from the arguments before the passthrough;
# skillgrade would reject it.
#
# It moves the AGENT only. The answer grader pins its own judge with an explicit
# --model (graders/score-answer.mjs), so a model comparison keeps one judge and
# stays apples-to-apples. SCORE_ANSWER_MODEL moves that one, deliberately.
#
# skillgrade has no post-run hook, so this is the seam. The only real work it
# does is the timestamp: the results directory is append-only across every run
# this box has ever done, so without a cutoff the uploader would sweep up old
# results and invent an experiment that never happened.
#
# A killed or failed run uploads nothing — `set -e` and the exit check see to
# that. Half an experiment is worse than none.
set -euo pipefail

# skillgrade reads eval.yaml from the working directory, and grader run:
# commands are relative to it — so run from the repo root, not from here.
cd "$(dirname "$0")/.."

if [ -z "${FIGMA_RESET_ON_CONNECT:-}" ]; then
  # Without it the browser starts wherever the previous trial left it, and a
  # locate row can pass having done nothing. Containers created before this
  # existed do not set it, so default it here rather than silently degrade.
  export FIGMA_RESET_ON_CONNECT=1
  echo "  (FIGMA_RESET_ON_CONNECT was unset — defaulting to 1 so trials reset)"
fi

ARGS=()
for a in "$@"; do
  case "$a" in
    --model=*) export ANTHROPIC_MODEL="${a#*=}" ;;
    --model)   echo "✗ --model takes a value: --model=claude-opus-5" >&2; exit 2 ;;
    *)         ARGS+=("$a") ;;
  esac
done

if [ -n "${ANTHROPIC_MODEL:-}" ]; then
  echo "  model       $ANTHROPIC_MODEL"
fi

SINCE=$(node -e 'console.log(Date.now())')

# ${ARGS[@]+…} because `set -u` treats an unset empty array as unbound.
skillgrade ${ARGS[@]+"${ARGS[@]}"}

echo
node langsmith/upload-experiment.mjs --since="$SINCE"
