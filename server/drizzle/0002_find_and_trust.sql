-- pg_trgm and unaccent ship with the postgres image (contrib) and are trusted extensions, so the database
-- owner can create them without superuser rights. Nothing is downloaded.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "text_extracted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "search_blob" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "search_tsv" "tsvector";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "secret_findings" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "review_by" date;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "reviewed_by" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "search_tsv" "tsvector";--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "search_blob" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "search_code" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "search_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "secret_findings" jsonb;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "secrets_acknowledged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_search_tsv_idx" ON "attachments" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "attachments_search_blob_trgm_idx" ON "attachments" USING gin ("search_blob" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "pages_tags_idx" ON "pages" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "pages_review_by_idx" ON "pages" USING btree ("review_by");--> statement-breakpoint
CREATE INDEX "pages_search_tsv_idx" ON "pages" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "pages_search_blob_trgm_idx" ON "pages" USING gin ("search_blob" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "pages_search_code_trgm_idx" ON "pages" USING gin ("search_code" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "pages_title_trgm_idx" ON "pages" USING gin (lower("title") gin_trgm_ops);--> statement-breakpoint
-- Existing pages get a review date from their template's interval, counted from their last update.
UPDATE "pages" p SET "review_by" = (p."updated_at" + make_interval(months => t."review_interval_months"))::date
FROM "templates" t
WHERE t."key" = p."template" AND t."review_interval_months" IS NOT NULL AND p."review_by" IS NULL;
