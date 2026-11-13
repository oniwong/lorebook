# Lorebook

A self-hosted knowledge base for IT and technical teams: runbooks, how-tos and architecture docs in
one searchable place, running fully offline on a single Linux VM. See [SPEC.md](SPEC.md) for the
full design.

**Status: milestone 4 (Collaboration).** Local accounts, Spaces, the page tree, the Markdown editor
with live preview, check-out editing, and revision history with diff and restore (milestone 1);
templates with required sections, attachments, Mermaid diagrams, internal links with backlinks, the
trash, and moving pages (milestone 2); search with filters and exact matching of technical strings,
tags, secret warnings, review dates and the stale pages list (milestone 3); plus locked pages, change
requests reviewed like pull requests, owner reassignment and the in-app inbox (milestone 4). The last
milestone adds LDAP, the REST API, the static export and the rest of operations (SPEC.md §16).

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

### Running without a certificate (testing only)

For trying Lorebook at home or in a lab, it can run over plain HTTP with no certificate at all.
Add these lines to `.env`:

```sh
COMPOSE_FILE=docker-compose.yml:docker-compose.http.yml
BASE_URL=http://localhost:8080    # or http://<this machine's IP>:8080 to reach it from other devices
HTTP_PORT=8080
```

then `docker compose up -d --build` and open the `BASE_URL`. `TLS_DIR` is not needed. Every other
`docker compose` command works unchanged, because Compose reads `COMPOSE_FILE` from `.env`.

What the HTTP layer changes ([docker-compose.http.yml](docker-compose.http.yml)): nginx uses
[deploy/nginx/lorebook-http.conf](deploy/nginx/lorebook-http.conf), which serves the app on port 80
inside the container with no redirect to HTTPS and publishes only `HTTP_PORT`; and the app gets
`COOKIE_SECURE=false`, because browsers refuse to store a cookie marked Secure over HTTP, so sign-in
would otherwise fail without an error. The app logs a warning at start-up while this is on. It needs
Docker Compose 2.24 or newer.

Do not use this mode in production: passwords and session cookies cross the network unencrypted.
Delete the `COMPOSE_FILE` line (and set `BASE_URL` back to `https://…`) to return to HTTPS, which
stays the default.

Copying a page link uses the browser clipboard, which browsers only allow on HTTPS or `localhost`;
from another device over HTTP, Lorebook shows the link in a box to copy by hand instead.

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
deploy/nginx/      reverse proxy config: TLS (lorebook.conf) and plain-HTTP testing (lorebook-http.conf)
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

### Search, secrets and review dates

- **Search** (`server/src/lib/search.ts`) is plain PostgreSQL: a weighted `tsvector` per page (title,
  then headings and tags, then text, then code) for word search, and `pg_trgm` indexes on a lowercased,
  accent-stripped copy of the text for substring matches, so `srv-db-01`, `10.20.30.41` or `0x80070005`
  are found exactly. Text attachments under 5 MB are indexed too. The index columns are rebuilt in the
  same transaction as every save. Pages from older versions, and every page after an admin changes the
  search language, are re-indexed in the background by the housekeeping timer; `lorebook reindex`
  rebuilds everything by hand.
- **Secret detection** (`server/src/lib/secrets.ts`) is one dependency-free file that the editor uses as
  well (`web/src/lib/secrets.ts` must stay an identical copy; a test checks). The editor underlines
  matches as you type; check-in asks before saving them, and "Save anyway" flags the revision. Only
  masked previews are stored. Admins tune rules and placeholder values, see the **Possible secrets**
  report, and purge old revisions or files under **Admin**. `lorebook rescan-secrets` re-checks
  everything after a rule change. Suppress a false alarm with `lorebook:ignore-secret` on the line
  (e.g. `<!-- lorebook:ignore-secret -->`).
- **Review dates**: new pages get a review-by date from their template's interval. The owner or an
  admin changes or clears it, or marks the page reviewed (which moves the date forward). Overdue pages
  show a banner, appear under **Stale pages** and on the owner's home page, and can be filtered in search.

### Locking, change requests and the inbox

- **Locking**: the page owner (or an admin) locks a page. Then only they check it out, restore old
  revisions, delete it or remove its files; everyone else gets **Suggest change**. Locking is refused
  while someone else has the page checked out. Anyone can still add attachments, tags and subpages.
- **Change requests** (`server/src/lib/changeRequests.ts`) are private copies of a page: a draft that
  autosaves, then **Submit** sends it to the owner's inbox (to all admins if the owner is disabled).
  The reviewer sees the diff against the revision it started from and can comment, ask for changes,
  reject, or approve. Approving writes a revision credited to the requester, "approved by" the
  reviewer. Each person has at most one unfinished request per page; Suggest change resumes it.
  Unlocked pages take requests too, and the owner can't suggest changes to their own page.
- **Outdated requests**: when the page gets a new revision, open requests based on an older one are
  outdated and can't be approved. The requester clicks **Update onto latest version**, which runs a
  three-way line merge (`server/src/lib/merge.ts`). Where both sides changed the same lines, both are
  kept between `<<<<<<< your change` / `>>>>>>> current page` markers, and submit and approve refuse
  the request until the markers are gone. Approval also needs the reviewer to have seen the latest
  version (a version counter) and the page not to be checked out.
- **Owners**: admins change a page's owner from the page, or hand all of a disabled user's pages to
  someone under **Admin → Users → Reassign pages**. Open requests move to the new owner.
- **Inbox** (`server/src/lib/inbox.ts`): stored items, one per person, for change request activity,
  broken or expired check-outs, locks and owner changes. A sweep in the housekeeping timer (every
  15 minutes) adds review reminders for owners and "needs an owner" items for admins, once per review
  date or former owner. Items about something that's been dealt with (a decided request, a reviewed
  page, a reassigned page) are marked read automatically. The bell polls the unread count every minute.

### How check-out works

Clicking **Edit** checks the page out inside a row-locked transaction, so exactly one person wins.
The editor autosaves a private draft every few seconds and sends a heartbeat only while the person
is active. After `CHECKOUT_TIMEOUT_MINUTES` (default 120) without activity, the check-out lapses and
the draft stays in the owner's **My drafts**. An admin can break a check-out; the draft is kept,
and the editor will not silently retake the page. If someone else checked in meanwhile, checking in
a resumed draft asks for confirmation before replacing their version (which stays in History).
