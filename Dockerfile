# Playwright's own image: Chromium plus every system library it needs, already
# installed and verified together.
#
# Why not Render's native Node runtime? The build there runs as an unprivileged
# user, and `playwright install --with-deps` shells out to apt-get as root to
# fetch Chromium's shared libraries. That call fails, and the whole build exits 1.
# Installing without --with-deps gets the browser but not the libraries, so it
# then dies at launch instead. Using this image sidesteps both.
#
# Keep this tag in lockstep with the `playwright` version resolved in
# package-lock.json. A mismatch means the library looks for a browser build the
# image does not carry, and every scrape fails with "Executable doesn't exist".
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

# Workspace manifests first so the dependency layer stays cached until they change.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json

# Dev dependencies are required to build (typescript, vite, tsx).
RUN npm ci

COPY . .

# Build the frontend and compile the server, then drop the build-only packages.
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production

# Render injects PORT; the server falls back to 3001 when running locally.
EXPOSE 3001

# Migrations run on boot (see server/src/index.ts), so there is no release step.
CMD ["npm", "start"]
