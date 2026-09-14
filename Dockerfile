# One image: the bundle, the API, the MCP server and the database, on one port.
#
# The build is staged so the runtime carries neither the toolchain nor the dev
# dependencies — only what is needed to serve. better-sqlite3 is native, so it is compiled
# against the same Node the runtime uses rather than copied from the build host.

# ── build the web bundle ────────────────────────────────────────────────────────────────
#
# The whole tree is copied before installing rather than a hand-written list of workspace
# manifests. The list was the original arrangement and it is a trap: a workspace added later
# is simply missing from it, npm prunes what that workspace depended on, and the image builds
# clean and dies at boot. The tree is small — node_modules and dist are excluded — so the
# caching this costs is worth less than the failure it removes.
FROM node:22-alpine AS web
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts && npm run build --workspace @ledger/web

# ── install the runtime dependencies, native modules included ───────────────────────────
#
# better-sqlite3 is native, so it is compiled here against the same Node the runtime uses
# rather than copied from the build host.
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY . .
RUN npm ci --omit=dev && npm rebuild better-sqlite3

# ── run ─────────────────────────────────────────────────────────────────────────────────
#
# The prepared tree is taken whole from the deps stage rather than reassembled here. npm does
# not hoist everything: where two workspaces need versions that conflict with a build tool, it
# nests a copy under `apps/api/node_modules`. Copying only the root `node_modules` and then
# laying the sources back over the top silently drops those, and the image builds clean and
# dies at boot looking for a package that is plainly in its package.json.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    LEDGER_DATA=/data \
    LEDGER_DB=/data/ledger.db \
    LEDGER_WEB=/app/apps/web/dist

COPY --from=deps /app /app
COPY --from=web /app/apps/web/dist ./apps/web/dist

# No seed. The ledger comes up empty and holds only what its owner puts in it. `seedIfAsked`
# still honours LEDGER_SEED if one is set at run time, and still refuses a database that
# already holds records.

RUN mkdir -p /data && addgroup -S ledger && adduser -S ledger -G ledger \
 && chown -R ledger:ledger /data /app
USER ledger

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "apps/api/src/main.ts"]
