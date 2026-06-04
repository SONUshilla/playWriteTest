# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — deps
#   Install only production node_modules. This layer is cached separately so
#   rebuilds caused by code changes don't re-download npm packages.
# ─────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.44.0-jammy AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — runner  (final image)
#   The Playwright base image already ships Chromium + all system libs.
#   We just copy in our code and assets on top.
# ─────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Node modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# App source
COPY cloud-runner.js   ./cloud-runner.js
COPY prepare-video.js  ./prepare-video.js

# Static assets (face.png + face-test.mp4 / .y4m)
# These must exist locally before you run `docker build`
COPY assets/           ./assets/

# Run the video conversion at build time so containers start instantly.
# If prepare-video.js has nothing to do (file already correct) it exits 0.
RUN node prepare-video.js || echo "prepare-video skipped (no-op or not needed)"

# ── Runtime ───────────────────────────────────────────────────────────────────
# Chrome in Docker needs /dev/shm headroom; handled by --shm-size at runtime.
# We set --no-sandbox in cloud-runner.js already.

ENV NODE_ENV=production

# All config comes in via env vars — no port needed (not a server)
CMD ["node", "cloud-runner.js"]