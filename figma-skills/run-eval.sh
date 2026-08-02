#!/bin/bash
# run-eval.sh — skillgrade, then ship the results to LangSmith as an experiment.
#
#   ./run-eval.sh                         every task in eval.yaml
#   ./run-eval.sh --eval=explain-4da43204 one task
#   ./run-eval.sh --trials=3              anything skillgrade accepts, passed through
#
# skillgrade has no post-run hook, so this is the seam. The only real work it
# does is the timestamp: the results directory is append-only across every run
# this box has ever done, so without a cutoff the uploader would sweep up old
# results and invent an experiment that never happened.
#
# A killed or failed run uploads nothing — `set -e` and the exit check see to
# that. Half an experiment is worse than none.
set -euo pipefail

cd "$(dirname "$0")"

if [ -z "${FIGMA_RESET_ON_CONNECT:-}" ]; then
  # Without it the browser starts wherever the previous trial left it, and a
  # locate row can pass having done nothing. Containers created before this
  # existed do not set it, so default it here rather than silently degrade.
  export FIGMA_RESET_ON_CONNECT=1
  echo "  (FIGMA_RESET_ON_CONNECT was unset — defaulting to 1 so trials reset)"
fi

SINCE=$(node -e 'console.log(Date.now())')

skillgrade "$@"

echo
node upload-experiment.mjs --since="$SINCE"
