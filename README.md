# Lorebook

A self-hosted knowledge base for IT and technical teams: runbooks, how-tos and architecture docs in
one searchable place, running fully offline on a single Linux VM. See [SPEC.md](SPEC.md) for the
full design.

**Status: milestone 1 (Foundation).** Local accounts, Spaces, the page tree, the Markdown editor
with live preview, check-out editing, and revision history with diff and restore. Later milestones
add templates, attachments, search, change requests, LDAP and the rest (SPEC.md §16).

## Running it

Production install on the air-gapped VM: see [INSTALL.md](INSTALL.md). Upgrades: [UPGRADE.md](UPGRADE.md).

Quick try-out on a machine with Docker:

```sh
cp .env.example .env              # set POSTGRES_PASSWORD, BASE_URL=https://localhost, TLS_DIR=./deploy/tls
scripts/dev-cert.sh deploy/tls    # self-signed cert, for trying it out only
docker compose up -d --build
docker compose exec app lorebook create-admin
```

Then open https://localhost, sign in, and create a Space under **Admin**.

## Development

Requirements: Node 22 and PostgreSQL 16.

```sh
npm install
createdb lorebook && createdb lorebook_test   # user/password lorebook/lorebook by default
DATABASE_URL=postgres://lorebook:lorebook@localhost/lorebook npx -w server tsx src/cli.ts create-admin
COOKIE_SECURE=false DATA_DIR=/tmp npm run dev:server   # API on :3000 (runs migrations on start)
npm run dev:web                                        # UI on :5173, proxies /api to :3000
```

| Command | What it does |
|---|---|
| `npm test` | Server API tests against `lorebook_test` (override with `TEST_DATABASE_URL`) |
| `npm run typecheck` | Type-checks server and web |
| `npm run build` | Builds the web bundle and the server |
| `npm run check:offline` | Fails if the built frontend references any external host |
| `npm run db:generate -w server` | Generates a SQL migration after changing `server/src/db/schema.ts` |
| `scripts/release.sh` | Builds the offline release tarball (image archives + compose + docs) |

### Layout

```
server/            Fastify API (TypeScript), Drizzle schema + SQL migrations, CLI
  src/lib/pages.ts   check-out, drafts, check-in, revisions: the core editing rules
web/               React + Vite UI, CodeMirror 6 editor, remark/rehype + Shiki rendering
deploy/nginx/      TLS reverse proxy config
scripts/           offline check, release tarball, dev certificate
```

### How check-out works

Clicking **Edit** checks the page out inside a row-locked transaction, so exactly one person wins.
The editor autosaves a private draft every few seconds and sends a heartbeat only while the person
is active. After `CHECKOUT_TIMEOUT_MINUTES` (default 120) without activity, the check-out lapses and
the draft stays in the owner's **My drafts**. An admin can break a check-out; the draft is kept,
and the editor will not silently retake the page. If someone else checked in meanwhile, checking in
a resumed draft asks for confirmation before replacing their version (which stays in History).
