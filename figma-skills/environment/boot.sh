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
  "https://www.figma.com/design/${FIGMA_FILE:-}/boot" >/tmp/chrome.log 2>&1 &

# No cookie seeding here, on purpose.
#
# The session lives in the profile VOLUME, which is the box's own state and
# outlives the container. It used to also be snapshotted into .env as
# FIGMA_COOKIES and replayed on every boot, to make startup deterministic rather
# than dependent on the volume. That inverted: the snapshot went stale and this
# line then replayed a week-old session OVER a freshly seeded one, so the
# mechanism meant to prevent a silent failure caused one.
#
# .env is config a human writes; a captured browser session is not that. It is
# also a place a client's credentials should never sit.
#
# When the session does expire the skill reports "window.figma absent" and
# escalates, which is a real result — and `box.mjs seed` refreshes it from the
# host browser without anything touching disk.
#
# NOTE for whoever revives skillgrade's `provider: docker` path (TODO §0.6):
# those containers are created by skillgrade and mount no volumes, so they get
# no profile and boot unauthenticated. Mount `figma-profile` into them rather
# than reintroducing a cookie snapshot.

exec "$@"
