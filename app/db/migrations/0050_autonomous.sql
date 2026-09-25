ALTER TABLE "operators" ADD COLUMN "autonomous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "autonomous_set_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "autonomous_set_at" timestamp with time zone;