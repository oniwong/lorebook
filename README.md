# Lorebook

A self-hosted knowledge base for IT and technical teams: runbooks, how-tos and architecture docs in
one searchable place, running fully offline on a single Linux VM. See [SPEC.md](SPEC.md) for the
full design.

**Status: milestone 2 (Content).** Local accounts, Spaces, the page tree, the Markdown editor with
live preview, check-out editing, and revision history with diff and restore (milestone 1); plus
templates with required sections, attachments, Mermaid diagrams, internal links with backlinks, the
trash, and moving pages (milestone 2). Later milestones add search, secret detection, review dates,
change requests, LDAP and the rest (SPEC.md §16).

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

### Templates, links and attachments

- **Templates** live in the `templates` table. The built-in ones (Runbook, How-to, Architecture, Blank)
  are seeded by migration `0001_content.sql`; admins edit them and add more under **Admin**. A
  template's required sections are `## Headings` that must exist and contain something other than
  `<!-- hint comments -->` before check-in (`server/src/lib/sections.ts`, mirrored in
  `web/src/lib/sections.ts` for the live hint in the editor). The page owner or an admin can switch a
  page to Blank when a template doesn't fit.
- **Internal links** are plain Markdown links to `/p/<id>` (the editor's `[[` picker inserts them).
  Every save re-extracts them into `page_links`, which powers "Linked from" and broken-link markers.
- **Attachments** stream to `/data/attachments/ab/cd/<sha256>` without buffering in memory, so the
  same file is stored once. Removing an attachment from a page only hides it from the list: older
  revisions may still link to it. The file goes away when its page is purged from the trash and the
  nightly job finds nothing referencing it. Files are served with `nosniff` and a sandboxing CSP, and
  only images display inline.
- **Trash**: deleting a page sends it and its subpages to the trash as one group. Admins restore or
  purge groups under **Admin**; groups older than 30 days are purged by the nightly job
  (`NIGHTLY_HOUR`, default 03:00 container time, or run `lorebook nightly` by hand).

### How check-out works

Clicking **Edit** checks the page out inside a row-locked transaction, so exactly one person wins.
The editor autosaves a private draft every few seconds and sends a heartbeat only while the person
is active. After `CHECKOUT_TIMEOUT_MINUTES` (default 120) without activity, the check-out lapses and
the draft stays in the owner's **My drafts**. An admin can break a check-out; the draft is kept,
and the editor will not silently retake the page. If someone else checked in meanwhile, checking in
a resumed draft asks for confirmation before replacing their version (which stays in History).
