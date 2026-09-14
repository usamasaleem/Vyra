ALTER TABLE "conversations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_through_count" integer DEFAULT 0 NOT NULL;