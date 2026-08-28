# Riotline Tool - broadcast graphics for VALORANT.
#
# The application itself has zero npm dependencies and would run in a 60 MB
# image. Everything below exists for one optional feature: the tracker.gg
# fallback, which drives a real Chromium because the site is Cloudflare
# protected and loads matches by XHR. If you do not use that source, set
# TRACKER_ENABLED=false and this image is simply larger than it needs to be.
#
# **bookworm, deliberately.** Playwright's dependency table has entries for
# debian12 and several ubuntu releases, and nothing for debian13/trixie - which
# is what the default `node:22` tag now is. On trixie `playwright install
# --with-deps` prints a warning, installs nothing, and Chromium then fails to
# start with a missing-library error that has nothing to do with the real cause.
# Bookworm also still uses the pre-time_t64 package names below; do not
# transplant this list onto trixie or noble without renaming them.

FROM node:22-bookworm-slim

# ---------------------------------------------------------------- system ---

# Three groups, one layer:
#
#   1. Chromium's shared libraries, from Playwright's own debian12-x64 list.
#   2. Fonts. Not cosmetic here - a human has to read and click a Cloudflare
#      widget through the viewer, and a box of tofu is not clickable.
#   3. The viewer stack. Xvfb gives the headed browser a display, x11vnc makes
#      that display watchable, novnc + websockify make it watchable from a
#      browser tab. See docker/tracker-login-session.sh.
#
# tini is PID 1 so that Chromium's zombie children get reaped and a docker stop
# actually stops rather than waiting out its timeout.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      fonts-freefont-ttf \
      fonts-ipafont-gothic \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-tlwg-loma-otf \
      fonts-unifont \
      fonts-wqy-zenhei \
      libfontconfig1 \
      libfreetype6 \
      xfonts-scalable \
      novnc \
      websockify \
      x11vnc \
      xvfb \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Fail the build rather than the feature. The dashboard opens
# /tracker-login/vnc.html, and some noVNC packagings ship only vnc_lite.html -
# which would surface at 03:00 as a blank viewer, not as a missing file.
RUN test -f /usr/share/novnc/vnc.html \
    || (echo "novnc did not install vnc.html" && exit 1)

# ------------------------------------------------------------ playwright ---

# Baked into the image at a fixed path rather than left in a home directory:
# the default is $HOME/.cache/ms-playwright, which changes with the user and
# would be re-downloaded on every container that mounted a fresh home.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# package.json alone first, so the browser download is cached across every
# change to the application. It is ~170 MB and by far the slowest step.
COPY package.json package-lock.json* ./

# Playwright is the only dependency, and it is optional at runtime. `npm ci`
# needs a lockfile; fall back to install so a checkout without one still builds.
#
# Not --with-deps: the libraries are installed explicitly above, where they can
# be read, and where a missing one is a build failure rather than a warning.
RUN (npm ci --omit=dev || npm install --omit=dev) \
    && npx playwright install chromium \
    && npm cache clean --force

# ----------------------------------------------------------- application ---

COPY . .

# The script is spawned directly, with no shell, so it needs the bit set. The
# repository carries it (git mode 100755) but a build from an archive or a
# Windows checkout without .gitattributes may not.
RUN chmod +x docker/tracker-login-session.sh

# One directory for everything that must outlive the container: operator state
# under /data/state, the Chromium profile under /data/profile.
#
# PROFILE_DIR points at a *subdirectory* of the volume and never at the mount
# itself. browser.js recovers from a poisoned Cloudflare clearance by deleting
# and recreating that directory, and removing a mount point returns EBUSY -
# which `force: true` does not suppress. The recovery would fail silently, and
# silent is the one thing it must not be.
ENV STATE_DIR=/data/state \
    PROFILE_DIR=/data/profile \
    HOST=0.0.0.0 \
    PORT=8080 \
    NODE_ENV=production

# node (uid 1000) is in the base image. Chromium writes to $HOME even when it
# has a user-data-dir, so the home directory has to be its own and writable.
RUN mkdir -p /data/state /data/profile /home/node/.cache /home/node/.config \
    && chown -R node:node /data /home/node \
    && chmod 1777 /tmp

USER node

EXPOSE 8080

# /api/health is outside the auth gate on purpose - a health check has no cookie
# and never will. --start-period covers Node's boot only: the tracker.gg browser
# warm-up is fired and forgotten, so the port is open well before it finishes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
