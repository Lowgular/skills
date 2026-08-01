# The image skillgrade's `provider: docker` builds for every trial.
#
# skillgrade looks for it at <taskdir>/environment/Dockerfile, with the task dir
# as build context — so `COPY . /workspace` brings graders and environment in.
# The skill is NOT copied here: skillgrade injects it into
# /workspace/.claude/skills after the build, which is the whole reason a
# container gives real isolation — there is no ~/.claude/skills to shadow it.
FROM node:22-slim

# Chromium, not Chrome: no arm64 Linux build of Chrome exists.
# bash because provider.runCommand execs `/bin/bash -c`.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-dejavu-core ca-certificates procps bash \
 && rm -rf /var/lib/apt/lists/*

# skillgrade is installed here so the box needs only figma-skills mounted —
# otherwise npx has to resolve it from the parent repo's node_modules, which
# means mounting the whole monorepo just for one package.
RUN npm install -g @anthropic-ai/claude-code skillgrade

COPY . /workspace

# The skill, so a plain `docker run` of this image is self-sufficient.
#
# Both other paths override this exact directory, so it never conflicts:
# skillgrade putArchive's the skill here after building, and environment/box.mjs
# bind-mounts the repo copy over it for live editing. Without this line, though,
# a bare container has no skill at all — which is how figma-dev ended up with
# /workspace/.claude/skills missing entirely.
COPY --chown=node:node figma-browser /workspace/.claude/skills/figma-browser

# /profile must exist and be writable by the user Chromium runs as, or it dies
# with "Failed to create /profile/SingletonLock: Permission denied".
RUN mkdir -p /profile \
 && chmod +x /workspace/environment/boot.sh \
 && chown -R node:node /workspace /profile

ENV FIGMA_CHROME_BIN=/usr/bin/chromium
ENV FIGMA_CDP_PORT=9333

# skillgrade's provider execs as ROOT even though this image sets USER node, and
# `claude` refuses --dangerously-skip-permissions as root:
#   "--dangerously-skip-permissions cannot be used with root/sudo privileges"
# IS_SANDBOX is the documented escape for exactly this case, and it is honest
# here — an isolated container with only the skill under test in it.
ENV IS_SANDBOX=1

# claude refuses --dangerously-skip-permissions as root.
RUN mkdir -p /work && chown node:node /work

USER node

# Pre-complete the interactive first-run state.
#
# CLAUDE_CODE_OAUTH_TOKEN authenticates API calls, so `claude -p` works in a
# fresh container — but the TUI keeps its own onboarding flags in ~/.claude.json,
# and without them `claude` (interactive) drops into the setup wizard. Harmless
# for evals, confusing when you exec in to look around.
RUN node -e "const fs=require('fs'),p=process.env.HOME+'/.claude.json'; \
  const j=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{}; \
  Object.assign(j,{hasCompletedOnboarding:true,theme:'dark',bypassPermissionsModeAccepted:true}); \
  fs.writeFileSync(p,JSON.stringify(j,null,2));"

# /work is where figma-skills is mounted: eval.yaml, graders, and
# .claude/skills/figma-browser (a symlink to ../../figma-browser, so skillgrade
# and interactive claude both discover the skill from here).
WORKDIR /work

# ENTRYPOINT, not CMD: skillgrade overrides Cmd with `tail -f /dev/null`, but
# leaves Entrypoint alone — so this still runs and then execs whatever Cmd is.
ENTRYPOINT ["/workspace/environment/boot.sh"]
CMD ["tail", "-f", "/dev/null"]
