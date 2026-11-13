import { sql } from 'drizzle-orm';
import {
  pgTable, serial, integer, bigint, text, timestamp, boolean, jsonb, primaryKey, index, uniqueIndex, date, customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/** Postgres full-text vector. Written with SQL (see lib/search.ts), never read back into JS. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** Masked secret-scan findings (see lib/secrets.ts). Never contains the secret itself. */
export type StoredFinding = { ruleId: string; ruleName: string; line: number; preview: string };

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull(),
  displayName: text('display_name').notNull(),
  email: text('email'),
  passwordHash: text('password_hash'),
  authSource: text('auth_source').notNull().default('local'),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  active: boolean('active').notNull().default(true),
  prefs: jsonb('prefs').$type<Record<string, unknown>>().notNull().default({}),
  failedLogins: integer('failed_logins').notNull().default(0),
  lastFailedLoginAt: timestamp('last_failed_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('users_username_lower_idx').on(sql`lower(${t.username})`)]);

export const sessions = pgTable('sessions', {
  // sha256 of the cookie token, so a DB leak does not leak live sessions
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  csrfToken: text('csrf_token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('sessions_user_idx').on(t.userId)]);

export const spaces = pgTable('spaces', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
});

export const pages = pgTable('pages', {
  id: serial('id').primaryKey(),
  spaceId: integer('space_id').notNull().references(() => spaces.id),
  parentId: integer('parent_id').references((): AnyPgColumn => pages.id),
  position: integer('position').notNull().default(0),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  body: text('body').notNull().default(''),
  template: text('template').notNull().default('blank'),
  ownerId: integer('owner_id').notNull().references(() => users.id),
  currentRevisionId: integer('current_revision_id'),
  checkedOutBy: integer('checked_out_by').references(() => users.id),
  checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
  checkoutHeartbeatAt: timestamp('checkout_heartbeat_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: integer('deleted_by').references(() => users.id),
  // The page the user actually deleted; its whole subtree shares this id and is restored together.
  trashRootId: integer('trash_root_id'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  // Locked pages (spec §6): only the owner or an admin may edit directly; everyone else suggests changes.
  locked: boolean('locked').notNull().default(false),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: integer('locked_by').references(() => users.id),
  // Review dates (spec §11). review_by is a calendar date; null means the page is never due.
  reviewBy: date('review_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: integer('reviewed_by').references(() => users.id),
  // Search index (spec §9), maintained by lib/search.ts on every change.
  searchTsv: tsvector('search_tsv'),
  // lower(unaccent(title, headings, tags, body)) for trigram substring matching
  searchBlob: text('search_blob'),
  searchCode: text('search_code'),
  searchVersion: integer('search_version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').notNull().references(() => users.id),
}, (t) => [
  index('pages_space_parent_idx').on(t.spaceId, t.parentId, t.position),
  index('pages_updated_idx').on(t.updatedAt),
  index('pages_trash_root_idx').on(t.trashRootId),
  index('pages_tags_idx').using('gin', t.tags),
  index('pages_review_by_idx').on(t.reviewBy),
  index('pages_search_tsv_idx').using('gin', t.searchTsv),
  index('pages_search_blob_trgm_idx').using('gin', sql`${t.searchBlob} gin_trgm_ops`),
  index('pages_search_code_trgm_idx').using('gin', sql`${t.searchCode} gin_trgm_ops`),
  index('pages_title_trgm_idx').using('gin', sql`lower(${t.title}) gin_trgm_ops`),
]);

export const revisions = pgTable('revisions', {
  id: serial('id').primaryKey(),
  pageId: integer('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id').notNull().references(() => users.id),
  kind: text('kind', { enum: ['create', 'checkin', 'restore', 'change_request'] }).notNull(),
  message: text('message').notNull().default(''),
  restoredFrom: integer('restored_from'),
  // Set on revisions applied from an approved change request: the author is the requester.
  changeRequestId: integer('change_request_id'),
  approvedBy: integer('approved_by').references(() => users.id),
  // Possible secrets found when the revision was written; empty or null when clean.
  secretFindings: jsonb('secret_findings').$type<StoredFinding[]>(),
  // The author saw the secret warning and chose "Save anyway".
  secretsAcknowledged: boolean('secrets_acknowledged').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('revisions_page_idx').on(t.pageId, t.id)]);

export const drafts = pgTable('drafts', {
  pageId: integer('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  baseRevisionId: integer('base_revision_id').notNull(),
  // why the draft is no longer attached to a live check-out, if it isn't
  status: text('status', { enum: ['active', 'expired', 'broken'] }).notNull().default('active'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.pageId, t.userId] })]);

export const templates = pgTable('templates', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  body: text('body').notNull().default(''),
  requiredSections: text('required_sections').array().notNull().default(sql`'{}'::text[]`),
  reviewIntervalMonths: integer('review_interval_months'),
  builtin: boolean('builtin').notNull().default(false),
  position: integer('position').notNull().default(100),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
});

/** One row per file attached to a page. The bytes live on disk, named by SHA-256 (see lib/attachments.ts). */
export const attachments = pgTable('attachments', {
  id: serial('id').primaryKey(),
  pageId: integer('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  uploadedBy: integer('uploaded_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Removed from the page's list. The row (and file) stays so old revisions that link to it still work.
  removedAt: timestamp('removed_at', { withTimezone: true }),
  removedBy: integer('removed_by').references(() => users.id),
  // Text files under 5 MB are indexed for search and scanned for secrets (spec §7).
  textExtracted: boolean('text_extracted').notNull().default(false),
  searchBlob: text('search_blob'),
  searchTsv: tsvector('search_tsv'),
  secretFindings: jsonb('secret_findings').$type<StoredFinding[]>(),
}, (t) => [
  index('attachments_page_idx').on(t.pageId),
  index('attachments_sha_idx').on(t.sha256),
  index('attachments_search_tsv_idx').using('gin', t.searchTsv),
  index('attachments_search_blob_trgm_idx').using('gin', sql`${t.searchBlob} gin_trgm_ops`),
]);

/** Internal links between pages, extracted from the current body on every save. */
export const pageLinks = pgTable('page_links', {
  fromPageId: integer('from_page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  // No foreign key: a link can point at a page that is trashed, purged or never existed.
  toPageId: integer('to_page_id').notNull(),
}, (t) => [primaryKey({ columns: [t.fromPageId, t.toPageId] }), index('page_links_to_idx').on(t.toPageId)]);

/** Settings admins change at runtime, plus bookkeeping for the nightly jobs. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const CR_STATUSES = ['draft', 'open', 'changes_requested', 'approved', 'rejected', 'withdrawn'] as const;
export type ChangeRequestStatus = typeof CR_STATUSES[number];

/**
 * A suggested edit to a page (spec §6): a private copy of the page, based on one revision, that the owner
 * reviews as a diff and approves, rejects or sends back. "Outdated" is derived: base revision ≠ page's current one.
 */
export const changeRequests = pgTable('change_requests', {
  id: serial('id').primaryKey(),
  pageId: integer('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').notNull().references(() => users.id),
  status: text('status', { enum: CR_STATUSES }).notNull().default('draft'),
  title: text('title').notNull(),
  body: text('body').notNull(),
  description: text('description').notNull().default(''),
  baseRevisionId: integer('base_revision_id').notNull(),
  // Bumped on every content change, so a reviewer only approves the version they looked at.
  version: integer('version').notNull().default(1),
  secretFindings: jsonb('secret_findings').$type<StoredFinding[]>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: integer('decided_by').references(() => users.id),
  appliedRevisionId: integer('applied_revision_id'),
}, (t) => [
  index('change_requests_page_idx').on(t.pageId, t.status),
  index('change_requests_author_idx').on(t.authorId, t.status),
  // One unfinished request per person per page: "Suggest change" resumes it.
  uniqueIndex('change_requests_one_active_idx').on(t.pageId, t.authorId)
    .where(sql`status in ('draft', 'open', 'changes_requested')`),
]);

/** The conversation and decisions on a change request, oldest first. */
export const changeRequestEvents = pgTable('change_request_events', {
  id: serial('id').primaryKey(),
  changeRequestId: integer('change_request_id').notNull().references(() => changeRequests.id, { onDelete: 'cascade' }),
  actorId: integer('actor_id').notNull().references(() => users.id),
  kind: text('kind', {
    enum: ['submitted', 'resubmitted', 'comment', 'changes_requested', 'approved', 'rejected', 'withdrawn', 'updated_to_latest'],
  }).notNull(),
  body: text('body').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('change_request_events_cr_idx').on(t.changeRequestId, t.id)]);

/**
 * The in-app inbox (spec §6). One row per notification for one user. `dedupeKey` stops the periodic sweep
 * (review dates, former-user pages) from adding the same item twice.
 */
export const inboxItems = pgTable('inbox_items', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  pageId: integer('page_id').references(() => pages.id, { onDelete: 'cascade' }),
  changeRequestId: integer('change_request_id').references(() => changeRequests.id, { onDelete: 'cascade' }),
  actorId: integer('actor_id').references(() => users.id),
  text: text('text').notNull().default(''),
  dedupeKey: text('dedupe_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
}, (t) => [
  index('inbox_items_user_idx').on(t.userId, t.id),
  index('inbox_items_unread_idx').on(t.userId).where(sql`read_at is null`),
  uniqueIndex('inbox_items_dedupe_idx').on(t.userId, t.dedupeKey),
]);
