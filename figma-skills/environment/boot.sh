#!/bin/bash
# boot.sh — ENTRYPOINT. Bring up a logged-in Figma browser, then hand over.
#
# skillgrade's docker provider sets Cmd (`tail -f /dev/null`) but NOT Entrypoint,
# so this runs first on every trial container and `exec "$@"` passes control on.
# That is what makes a stateless per-trial container workable: by the time the
# agent types `figma.mjs open …`, CDP is already alive and authenticated, so the
# skill's own ensureChrome finds a browser and never has to launch one.
#
# Three flags are load-bearing and were each found by a failed run:
#   --user-agent=<desktop>        without it Figma's CDN answers 403
#   --enable-unsafe-swiftshader   without it: "WebGL isn't supported"
#   --no-sandbox                  no user namespaces in the container
set -u

PROFILE=/profile
PORT="${FIGMA_CDP_PORT:-9333}"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"

# A profile carried in an image layer can hold a lock from whatever container
# wrote it. Chromium refuses to start on a lock naming another host.
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie" 2>/dev/null || true

/usr/bin/chromium \
  --headless=new --no-sandbox --disable-dev-shm-usage \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" \
  --user-agent="$UA" --disable-blink-features=AutomationControlled \
  "https://www.figma.com/design/${FIGMA_FILE_SDS:-}/boot" >/tmp/chrome.log 2>&1 &

# Cookies arrive as an env var because skillgrade's provider mounts no volumes —
# env is the only channel into a container it creates. Failure is logged, not
# fatal: the agent should then hit "window.figma absent" and escalate, which is
# a real result rather than a hung container.
if ! node /workspace/environment/seed.mjs; then
  echo "boot: FIGMA_COOKIES seed failed — the agent will see an unauthenticated browser" >&2
fi

exec "$@"
