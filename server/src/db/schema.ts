import { sql } from 'drizzle-orm';
import {
  pgTable, serial, integer, text, timestamp, boolean, jsonb, primaryKey, index, uniqueIndex, type AnyPgColumn,
} from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').notNull().references(() => users.id),
}, (t) => [
  index('pages_space_parent_idx').on(t.spaceId, t.parentId, t.position),
  index('pages_updated_idx').on(t.updatedAt),
]);

export const revisions = pgTable('revisions', {
  id: serial('id').primaryKey(),
  pageId: integer('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id').notNull().references(() => users.id),
  kind: text('kind', { enum: ['create', 'checkin', 'restore'] }).notNull(),
  message: text('message').notNull().default(''),
  restoredFrom: integer('restored_from'),
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
