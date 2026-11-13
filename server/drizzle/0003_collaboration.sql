CREATE TABLE "change_request_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"change_request_id" integer NOT NULL,
	"actor_id" integer NOT NULL,
	"kind" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer NOT NULL,
	"author_id" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"base_revision_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"secret_findings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" integer,
	"applied_revision_id" integer
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"page_id" integer,
	"change_request_id" integer,
	"actor_id" integer,
	"text" text DEFAULT '' NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "locked_by" integer;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "change_request_id" integer;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "approved_by" integer;--> statement-breakpoint
ALTER TABLE "change_request_events" ADD CONSTRAINT "change_request_events_change_request_id_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."change_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_request_events" ADD CONSTRAINT "change_request_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_change_request_id_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."change_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_request_events_cr_idx" ON "change_request_events" USING btree ("change_request_id","id");--> statement-breakpoint
CREATE INDEX "change_requests_page_idx" ON "change_requests" USING btree ("page_id","status");--> statement-breakpoint
CREATE INDEX "change_requests_author_idx" ON "change_requests" USING btree ("author_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "change_requests_one_active_idx" ON "change_requests" USING btree ("page_id","author_id") WHERE status in ('draft', 'open', 'changes_requested');--> statement-breakpoint
CREATE INDEX "inbox_items_user_idx" ON "inbox_items" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "inbox_items_unread_idx" ON "inbox_items" USING btree ("user_id") WHERE read_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_items_dedupe_idx" ON "inbox_items" USING btree ("user_id","dedupe_key");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;