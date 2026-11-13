CREATE TABLE "attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" integer
);
--> statement-breakpoint
CREATE TABLE "page_links" (
	"from_page_id" integer NOT NULL,
	"to_page_id" integer NOT NULL,
	CONSTRAINT "page_links_from_page_id_to_page_id_pk" PRIMARY KEY("from_page_id","to_page_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"required_sections" text[] DEFAULT '{}'::text[] NOT NULL,
	"review_interval_months" integer,
	"builtin" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 100 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "templates_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "deleted_by" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "trash_root_id" integer;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_from_page_id_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_page_idx" ON "attachments" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "attachments_sha_idx" ON "attachments" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "page_links_to_idx" ON "page_links" USING btree ("to_page_id");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pages_trash_root_idx" ON "pages" USING btree ("trash_root_id");--> statement-breakpoint
INSERT INTO "templates" ("key", "name", "description", "body", "required_sections", "review_interval_months", "builtin", "position") VALUES
('blank', 'Blank', 'An empty page with no required sections.', '', '{}', NULL, true, 0),
('runbook', 'Runbook', 'Step-by-step procedure for operating or recovering a system.', '## Purpose

<!-- What this runbook is for and when to use it. -->

## Prerequisites

<!-- Access, tools, approvals and maintenance windows needed before you start. -->

## Steps

<!-- Numbered steps. Put commands in code blocks so they can be copied. -->

## Verification

<!-- How to confirm the procedure worked. -->

## Rollback

<!-- How to undo the change if something goes wrong. -->

## Contacts/Escalation

<!-- Who owns the system and who to call when this runbook does not help. -->
', '{"Purpose","Prerequisites","Steps","Verification","Rollback","Contacts/Escalation"}', 6, true, 1),
('howto', 'How-to', 'Short instructions for getting one task done.', '## Goal

<!-- What the reader will have achieved at the end. -->

## Steps

<!-- Numbered steps. Put commands in code blocks so they can be copied. -->
', '{"Goal","Steps"}', 12, true, 2),
('architecture', 'Architecture', 'How a system is built and why.', '## Overview

<!-- What the system does, who uses it, and a diagram if it helps (a mermaid block works). -->

## Components

<!-- The main parts: servers, services, databases, network segments. -->

## Data flow

<!-- How requests and data move between components. -->

## Dependencies

<!-- What this system relies on (DNS, AD, storage, other services), and what relies on it. -->

## Decisions

<!-- Important design decisions and the reasons for them. -->
', '{"Overview","Components","Data flow","Dependencies","Decisions"}', 12, true, 3);
--> statement-breakpoint
INSERT INTO "page_links" ("from_page_id", "to_page_id")
SELECT DISTINCT p.id, (m[1])::int
FROM "pages" p
CROSS JOIN LATERAL regexp_matches(p.body, '(?:^|[\s(<"''])(?:https?://[^/\s)]+)?/(?:s/[a-z0-9-]+/)?p/([0-9]{1,9})(?![[:alnum:]_-])', 'g') AS m
WHERE (m[1])::int <> p.id
ON CONFLICT DO NOTHING;
