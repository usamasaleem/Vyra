ALTER TABLE "operators" ADD COLUMN "auto_confirm_bookings" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "auto_confirm_limit_minor" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "decided_automatically" boolean DEFAULT false NOT NULL;