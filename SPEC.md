# Lorebook — Specification

Lorebook is a self-hosted, web-based knowledge base for a company's IT and technical staff. It gathers runbooks, how-tos and architecture docs, which are scattered around today, into one searchable place that runs fully offline on a single Linux VM.

Status: draft v1, written 2026-11-13 from a requirements interview.

---

## 1. Goals and non-goals

### Goals
- One place for runbooks, how-tos and architecture docs for about 20 people, all of whom can read and write.
- Runs on a single Linux VM with Docker and **no internet access at all**.
- Fast to write in (Markdown with a live preview) and fast to find things in (full-text search with filters).
- Runbooks stay trustworthy, through version history, review dates and author-locked pages with change requests.
- Runbooks can still be read when Lorebook itself is down.

### Non-goals for v1
These are deliberately out of scope. Most could be added later.
- Email, Teams or chat notifications (in-app inbox only)
- Mapping AD groups to permissions, and per-Space read restrictions
- Entra ID / Azure AD sign-in (needs internet; see §4)
- Live co-editing (Lorebook uses check-out instead; see §6)
- A bulk import tool for existing documentation
- An embedded draw.io editor, and Visio preview (both are upload/download only)
- Mobile apps and a translated UI

---

## 2. Users and roles

| Role | Who | Can do |
|---|---|---|
| **User** | All staff (~20) | Read everything; create, edit, move and delete pages they're allowed to edit; lock pages they own; submit and review change requests; create API tokens |
| **Admin** | A few people | Everything a user can do, plus: manage users and Spaces, unlock pages and reassign owners, break check-outs, restore from and purge the trash, purge revisions, change settings, view the audit log |

- Every page has an **owner**: its creator, unless reassigned.
- There are no per-Space or per-page read restrictions in v1. Everyone who can log in can read everything.

---

## 3. Architecture

### Stack
| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, both frontend and backend | One language for the whole codebase; easy to hire for and maintain |
| Backend | Node.js 22 LTS + Fastify | Fast, simple, good streaming for uploads |
| Frontend | React + Vite, CodeMirror 6 editor | CodeMirror is a strong Markdown editor; Vite builds a fully static bundle |
| Markdown | remark/rehype (GFM), Shiki for code highlighting, Mermaid | All bundled locally, with no CDN |
| Database | PostgreSQL 16 (+ `pg_trgm`, `unaccent`) | Stores the data and also provides search, so there's no separate search server to run |
| ORM / migrations | Drizzle | Typed queries, plain SQL migrations |
| TLS / reverse proxy | nginx | Terminates TLS with internal-CA certificates and streams large uploads |

### Deployment
One `docker-compose.yml` with three containers:

```
 browser ──HTTPS──▶ nginx ──▶ app (Node) ──▶ postgres
                                │
                                ├── /data/attachments  (volume)
                                ├── /data/backups      (volume, read by external backup tool)
                                └── /data/export       (volume or mounted file share)
```

### Air-gap requirements (hard rules)
- **No outbound network calls at runtime.** No CDNs, web fonts, telemetry, update checks or external avatars. All JS, CSS, fonts, Mermaid and highlighting grammars are bundled into the image.
- **Offline install and upgrade.** Each release ships as a tarball containing the image archives (`docker save`), `docker-compose.yml`, `.env.example` and an `UPGRADE.md`. Install with `docker load` and `docker compose up -d`.
- CI tests that the built frontend references no external URLs.

### Configuration
All settings live in a single `.env` file: database credentials, LDAP settings, base URL, session secret, paths, and the check-out timeout. Settings that admins change at runtime (upload cap, default review interval, secret-scan rules) are stored in the database and edited in the admin UI.

---

## 4. Authentication

Two sign-in methods can be enabled at the same time:

1. **Local accounts.** Username and password, hashed with argon2id. Admins create these accounts. Users can change their own password. Passwords must be at least 12 characters, and repeated failed logins are throttled.
2. **On-prem Active Directory over LDAP.**
   - Uses LDAPS (or StartTLS) against the domain controllers. The internal CA is trusted via a mounted CA bundle (`NODE_EXTRA_CA_CERTS`).
   - Flow: a service account searches for the user, then Lorebook binds as the user to check the password.
   - A configurable LDAP filter decides who may log in (e.g. members of `CN=IT-Staff,...`). This only controls access; it does not map groups to permissions.
   - The user's account is created on first login, with display name and email copied from AD. Those are refreshed on every login.
   - Users who are disabled or deleted in AD can no longer log in. A nightly job also marks them inactive in Lorebook, so their pages show a "former user" owner and admins can reassign them.

**Why not Entra ID:** Entra sign-in needs both the server and the browser to reach Microsoft's servers, and that isn't possible on this network. The auth layer keeps providers pluggable, so OIDC/Entra can be added later if the network changes.

**Sessions:** server-side sessions stored in Postgres, set as an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. Sessions end after 12 hours of inactivity. Requests that change data are CSRF-protected.

**Bootstrap:** the first admin is created by running `docker compose exec app lorebook create-admin`.

---

## 5. Content model

### Spaces and the page tree
- **Spaces** are top-level containers, e.g. "Network", "Servers", "Security".
- Each Space holds a folder-style **tree of pages**. A page can have subpages at any depth, and siblings are ordered manually.
- Pages can be moved within a Space or between Spaces, by dragging in the sidebar tree or with a "Move" dialog.

### Page
| Field | Notes |
|---|---|
| `id` | Stable numeric ID that never changes |
| `space_id`, `parent_id`, `position` | Where the page sits in the tree |
| `title`, `slug` | The slug is generated from the title. Old slugs are kept so old links still work |
| `body` | Markdown (the source of truth) |
| `template` | `runbook`, `howto`, `architecture`, `blank`, or an admin-defined template |
| `tags` | Free-form, with autocomplete from existing tags |
| `owner_id` | The page owner |
| `locked` | When true, only the owner (or an admin) can edit directly |
| `review_by` | Optional date when the page should be reviewed |
| `deleted_at` | Set when the page is moved to the trash |
| `created_*`, `updated_*` | Timestamps and user |

### URLs and links
- Page URL: `/s/<space-key>/p/<id>/<slug>`. Lookups use only the **id**, so renames and moves never break links. A request with an outdated slug redirects to the current one.
- Internal links are written as normal Markdown links. The editor's link picker (triggered by `[[`) inserts `/p/<id>` links that keep working.
- Each page shows its backlinks ("Linked from"). Links to pages that are deleted or in the trash are marked as broken in the rendered page.

### Version history
- Every check-in, approved change request, API update and restore creates an immutable **revision**: full body snapshot, title, author, timestamp and an optional message.
- The History view shows a side-by-side or inline diff between any two revisions, and a **Restore** button. A restore creates a new revision rather than rewriting history.
- Admins can **purge** a single revision, which permanently deletes it. This is for removing a secret that was saved by mistake, and every purge is written to the audit log.

### Templates
Lorebook ships with three built-in templates, and admins can add more or edit them.

| Template | Required sections (H2 headings) | Default review interval |
|---|---|---|
| **Runbook** | Purpose, Prerequisites, Steps, Verification, Rollback, Contacts/Escalation | 6 months |
| **How-to** | Goal, Steps | 12 months |
| **Architecture** | Overview, Components, Data flow, Dependencies, Decisions | 12 months |

- A new page created from a template starts with the headings and placeholder hints.
- **Required sections are enforced on check-in.** A required heading that is missing or left empty blocks the save, and the editor lists what's missing. Owners can switch a page to `blank` if a template genuinely doesn't fit.

### Diagrams
- **Mermaid** fenced blocks (` ```mermaid `) render to diagrams in the preview and on the page. The Mermaid library is bundled locally.
- **draw.io and Visio** files are attachments, shown as download links with a file-type icon. Tip for the docs: draw.io can export `.drawio.png` or `.drawio.svg` files, which display inline as images and can still be opened in draw.io.

---

## 6. Editing UX

### Editor
- Split view: **raw Markdown (CodeMirror) on the left and a live preview on the right**, with scroll sync. Users can also switch to editor-only or preview-only.
- A toolbar plus shortcuts for headings, bold, code, links, tables and checklists. Paste or drag an image and it is uploaded and inserted as `![](…)`.
- Draft autosave to the server every few seconds while checked out. Drafts survive a browser crash.
- On check-in: optional revision message, the template check (§5) and the secret check (§8).

### Check-out (one editor at a time)
Lorebook uses an explicit **check-out** model instead of live co-editing or merge conflicts.

1. Clicking **Edit** checks the page out to you. Everyone else sees a banner: *"Checked out by Anna since 10:42"*, and the page is read-only for them.
2. **Check in** saves a new revision and releases the page. **Discard** throws the draft away and releases the page.
3. The editor sends a heartbeat. If there's no activity for **2 hours** (configurable), the check-out expires automatically and the draft is kept privately for the person who had it checked out.
4. **Admins can break a check-out.** The previous editor is notified in their inbox, and their draft is kept and can be recovered from "My drafts".
5. A page can't be checked out while it is in the trash. A check-out also blocks moving or deleting that page.

### Locked pages and change requests
- The **owner can lock** a page. Then only the owner or an admin can check it out.
- Anyone else gets a **Suggest change** button instead of Edit. It opens the same editor on a private copy based on the current revision. Submitting it creates a **change request** with an optional description.
- The owner gets an inbox item and opens a review screen showing the diff against the base revision. They can then:
  - **Approve**: the change is applied as a new revision credited to the requester ("approved by owner").
  - **Reject**, with a comment.
  - **Comment**, to ask for changes. The requester can edit and resubmit.
- If the page changed after the request was made, the request is marked **outdated**. The requester must update it onto the latest version before it can be approved. The editor shows both diffs to help.
- A change request can't be approved while the page is checked out.
- Unlocked pages can also take change requests. These are useful for "I'm not sure, please review."
- **If the owner is unavailable** (vacation, left the company), an admin can review change requests, unlock the page, or reassign its owner.

### In-app inbox
With no email or chat integration in v1, a bell icon with an unread count shows:
- Change requests on pages you own, and decisions on requests you made
- Check-outs of yours that were broken or expired
- Pages you own that are due for review, or overdue
- "Former user" pages that need an owner (admins)

### Page view
- Breadcrumbs, sidebar tree, an outline built from the page headings, tags, owner, last updated, a review status badge, and a lock icon.
- Actions: Edit or Suggest change, History, Move, Copy link, Export (Markdown or HTML), Delete.
- Watching pages and following changes is out of scope for v1, since there are no notifications.

### Navigation
- A sidebar tree for each Space, with an expand/collapse state remembered per user.
- Home page: recently updated pages, my drafts, my pending change requests, and stale pages I own.
- `Ctrl+K` quick switcher that jumps to a page by title.

---

## 7. Attachments

- Supported: screenshots and other images, Visio (`.vsdx`, `.vsd`), draw.io (`.drawio`, `.xml`), config and text files (`.conf`, `.yaml`, `.json`, `.ini`, `.xml`, `.ps1`, `.sh`, `.txt`, etc.), PDFs, and any other file type.
- Stored on the `/data/attachments` volume, named by SHA-256 hash (identical files are stored once). Filename, type, size, uploader and page are recorded in the database.
- **Display:**
  - Images display inline.
  - Text and config files get an inline syntax-highlighted preview with a "Download" button.
  - Visio, draw.io and other binary files are download-only.
- **Size:** no limit by default. Admins can set an optional upload cap in settings. Uploads stream to disk (no buffering in memory), and nginx's `client_max_body_size` follows the setting.
- Attachments are versioned along with the page. Deleting an attachment reference keeps the file until no live revision or trashed page uses it. A nightly garbage-collection job removes orphaned files.
- Text attachments under 5 MB are indexed for search (§9).
- Uploads are scanned for secrets like page content (§8), but only as a warning.

---

## 8. Secret detection

Runbooks tend to collect credentials, so Lorebook **warns** about content that looks like a secret. It does not block it.

- **Where it runs:** live in the editor (a subtle underline and a gutter marker), and again on check-in, change-request submission, API writes and text attachment uploads.
- **Rules** (admins can edit them in settings; regex plus an entropy check):
  - Private keys (`-----BEGIN … PRIVATE KEY-----`)
  - Cloud and API keys: AWS `AKIA…`, Azure connection strings and SAS tokens, GitHub/GitLab tokens, Slack-style tokens, JWTs
  - `password=` / `pwd:` / `secret:` / `api_key` assignments followed by a non-placeholder value
  - Connection strings with embedded credentials (`user:pass@host`)
  - Long, high-entropy strings in code blocks
- **On check-in with a match:** a dialog lists each match with its line and a masked preview. The user can **go back and fix it** or **save anyway**. "Save anyway" flags the revision, and the flag shows in History.
- An allowlist of placeholder values (`<password>`, `changeme`, `********`, `${VAR}`) prevents obvious false positives. A line can be suppressed with an inline comment: `<!-- lorebook:ignore-secret -->`.
- **API writes:** the response includes a `warnings` array. The write is not rejected.
- **Admin report:** a "Possible secrets" page lists pages and revisions that have flagged content. Combined with revision purge (§5), this lets an admin actually remove a leaked secret from history.
- Docs and the UI suggest storing secrets in the company's password vault and linking to the vault entry instead.

---

## 9. Search

Built on PostgreSQL full-text search plus trigram indexes, so there's no extra search service.

- **What is indexed:** title (highest weight), headings, body text, code blocks, tags, and text content of attachments.
- **Two kinds of matching:**
  - Full-text with stemming, for normal prose.
  - Trigram (`pg_trgm`) matching for technical strings that stemming breaks, such as hostnames, IP addresses, file paths, error codes and command flags. The query `srv-db-01` or `0x80070005` must find exact substrings.
- **Query syntax:** words, `"exact phrases"`, `-exclude` and `OR`, via `websearch_to_tsquery`.
- **Filters:** Space, tag, author/owner, template type, last updated (range), review status (current or stale), has attachments, and an option to search only inside code blocks.
- **Results:** title, breadcrumb path, highlighted snippet, last updated, and the owner. Results that matched in attachments show the attachment name.
- Search results and quick-switcher results respond in under 200 ms at the expected size (a few thousand pages).
- Trashed pages are excluded from normal search and are searchable within the trash view for admins.
- **Language:** the text-search configuration is a setting. The default is `simple` with `unaccent`, which handles mixed English and Swedish acceptably. See open questions.

---

## 10. Delete, move and trash

- **Delete** moves a page *and its subpages* to the **trash**, after a confirmation that shows how many pages are affected.
- Admins can restore from the trash for **30 days**. After that a nightly job purges trashed pages permanently, along with their revisions and orphaned attachments.
- Restore puts pages back under their original parent. If the parent is gone, they go to the root of the original Space (or a chosen location).
- Links to trashed pages show as broken. Restoring a page fixes them, because ids are stable.
- **Move** keeps the id, so every link keeps working. Moving a page moves its subtree.
- Deleting a Space requires it to be empty (or a typed confirmation, with every page sent to the trash).

---

## 11. Page review (staleness)

- Each page can have a **review-by date**. Templates set a default interval (§5), and the owner can change it or clear it.
- Once the date passes, the page shows a **"Needs review — last reviewed 2026-03-01"** banner and appears in:
  - the owner's inbox
  - a **Stale pages** list (filterable by Space and owner)
  - search filters
- **Mark as reviewed** (owner or admin) resets the date without needing a content edit, and records who reviewed it and when.
- Pages owned by inactive "former users" are flagged for an admin to reassign.

---

## 12. REST API

- Base path `/api/v1`, JSON. An OpenAPI 3 document is served locally at `/api/v1/openapi.json`, with a bundled docs UI.
- **Auth:** personal API tokens created in user settings. Each token has a name, a scope (`read` or `read-write`) and an optional expiry. Tokens are stored hashed, shown once, and can be revoked. Requests use `Authorization: Bearer <token>`. Admins can see and revoke anyone's tokens.
- **Endpoints (v1):**
  - Spaces: list, get
  - Pages: list (by Space or parent), get (Markdown and rendered HTML), create, update, move, delete (to trash), get history and a specific revision
  - Attachments: upload, list, download
  - Search: same query and filters as the UI
  - Change requests: create, list
- **Rules for API writes:**
  - They follow the same rules as the UI. An update fails with `409` if the page is checked out by someone else, and `403` if it's locked and the token user isn't the owner.
  - Updates use optimistic concurrency: the client sends `If-Match: <revision id>` and gets `412` if the page has changed since.
  - Each write creates a revision credited to the user, with "via API token <name>" recorded.
- **Automation pattern** (e.g. generated server inventory pages): a script uses a token belonging to a dedicated local service account, which owns and locks its pages. People suggest changes through change requests, and the next run doesn't overwrite human edits by accident.
- Basic rate limit per token (e.g. 10 requests/second) to protect the VM from runaway scripts.

---

## 13. Offline export (reading during outages)

Runbooks are needed most when things are broken, which may include Lorebook itself.

- A **nightly static HTML export** writes the whole knowledge base to `/data/export` (a volume, or a mounted SMB/NFS share):
  - One HTML file per page with the same tree structure, a navigation sidebar and the attachments.
  - Mermaid is bundled into the export so diagrams render offline. Code highlighting is pre-rendered.
  - A small client-side search index (title and body text) so people can search without a server.
  - It opens straight from the file system (`index.html`), with no web server needed.
- Each export is written to a temp directory and swapped in atomically, so readers never see a half-written export. `LAST_EXPORT.txt` holds the timestamp.
- Trashed pages are excluded. Content flagged as a secret is exported as-is, which is another reason to fix flagged pages.
- An admin can also trigger an export manually, and any user can export one page or subtree as a ZIP of Markdown or HTML.

---

## 14. Operations

### TLS
- nginx serves HTTPS using a certificate and key issued by the **internal CA**, mounted from the host (`/etc/lorebook/tls/`). HTTP redirects to HTTPS.
- The internal CA bundle is also mounted into the app container, so LDAPS connections to the domain controllers are trusted.
- Replacing the certificate needs only an nginx reload (`docker compose exec nginx nginx -s reload`).

### Backups
The company's **external backup tool** does the backing up. Lorebook's job is to give it a consistent snapshot to copy.
- A nightly job (time configurable) runs `pg_dump -Fc` to `/data/backups/lorebook-YYYYMMDD.dump`, keeping the last 7. It writes a `LAST_BACKUP_OK` marker on success.
- The external tool backs up `/data/backups` and `/data/attachments`. Attachments are content-addressed and never changed in place, so copying them live is safe.
- `RESTORE.md` documents a full restore (`pg_restore` plus copying attachments back) and is tested in CI against a sample dataset.
- The admin dashboard shows the last backup time and turns red if it is more than 26 hours old.

### Upgrades
- Download the release tarball on a connected machine and copy it to the VM. Then run `docker load` and `docker compose up -d`.
- The app takes a pre-upgrade `pg_dump` and then runs database migrations automatically on startup. If a migration fails, the app refuses to start and logs how to roll back.

### Monitoring and logs
- `GET /healthz` (liveness) and `GET /readyz` (database reachable, disk writable, free disk above threshold).
- Structured JSON logs to stdout, collected by Docker's log driver.
- Admin dashboard: disk usage for the attachment volume, last backup, last export, active check-outs, and pending change requests.

### Audit log
Admins can read the audit log in the UI, and it is kept for 1 year. It records:
- Logins and failed logins
- User and role changes
- Token creation and revocation
- Lock and unlock, owner reassignment, and broken check-outs
- Deletes, restores and purges
- Revision purges
- "Save anyway" on secret warnings
- Settings changes

### Security baseline
- Rendered Markdown is sanitized (no raw `<script>`; HTML is allowlisted), with a strict Content-Security-Policy.
- Attachments are served with `Content-Disposition: attachment` (except images and the safe text preview) and `X-Content-Type-Options: nosniff`.
- Dependencies are pinned. Image builds run a vulnerability scan in CI, since the deployed box can't fetch updates by itself.

---

## 15. Edge cases

| Situation | Behaviour |
|---|---|
| Two people click Edit at the same moment | Check-out is taken in a database transaction, so exactly one wins. The other immediately sees "Checked out by X" |
| Browser crashes while a page is checked out | The draft was autosaved. Reopening the page resumes the check-out and the draft |
| Editor walks away for the weekend | The check-out expires after 2 hours idle, and the draft is kept in their "My drafts" |
| Owner leaves the company or is disabled in AD | The page shows a "former user" owner and is flagged for admins. Admins reassign it or unlock it, and pending change requests become reviewable by admins |
| Change request opened, then the page is edited | The request is marked outdated, and the requester updates it onto the latest version before approval |
| Page with subpages is deleted | The whole subtree goes to the trash, after a confirmation showing the count |
| Restoring a page whose parent was purged | It is restored to the root of the Space, or to a location the admin chooses |
| Page moved or renamed | Its id is unchanged, links keep working, and old slugs redirect |
| Secret saved by mistake | The admin fixes the page, then purges the affected revisions. The audit log records the purge |
| Very large upload fills the disk | `/readyz` warns at a free-space threshold, the admin dashboard shows disk use, and admins can set the upload cap |
| Same file attached to many pages | It is stored once (content-addressed), and only removed when nothing references it |
| Script and human edit the same page | The API's `If-Match` check returns `412`. For automation pages the recommended pattern is a lock plus change requests |
| LDAP / domain controllers unreachable | AD logins fail with a clear message. Local accounts (including at least one local admin) still work, and existing sessions continue |
| Required template section deleted | Check-in is blocked with a list of what's missing. The owner can switch the page to `blank` |
| Mermaid syntax error | The preview shows the error inline, and the rest of the page renders normally |
| Search for a hostname or IP | Trigram matching finds exact substrings even where stemming wouldn't |
| Lorebook itself is down during an incident | Use the nightly static export on the file share |

---

## 16. Milestones

1. **Foundation:** compose setup, offline build, local accounts, Spaces, page tree, Markdown editor with preview, check-out, revisions with diff and restore.
2. **Content:** templates and required sections, attachments, Mermaid, internal links and backlinks, trash, move.
3. **Find and trust:** search with filters and trigram matching, secret detection, review dates, stale pages.
4. **Collaboration:** locking, change requests, in-app inbox.
5. **Integration and ops:** LDAP/AD, REST API and tokens, static export, backups, audit log, admin dashboard, release tarball and upgrade path.

---

## 17. Open questions

These have working defaults in the spec. Confirm or change them.

1. **Who can create Spaces?** Default: admins only, to keep the top level tidy.
2. **Search language.** Is most content in English, Swedish or both? Default: `simple` + `unaccent`. A Swedish or English stemming configuration would improve prose search if one language dominates.
3. **Check-out timeout.** Default: 2 hours idle.
4. **Who may log in through AD.** Default: a single configurable LDAP filter/group (e.g. `IT-Staff`), with all members as regular users.
5. **Review intervals.** Default: 6 months for runbooks and 12 months for other templates.
6. **Export location.** A local volume or a mounted file share? A share is better, since it stays readable if the VM is down.
