ALTER TABLE "operators" ADD COLUMN "auto_check_documents" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "documents_checked_automatically" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "documents_check" jsonb;--> statement-breakpoint
-- A check is attributed to a person, or it was the automatic one — never neither.
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_documents_check_is_attributed";--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_documents_check_is_attributed"
  CHECK (documents_checked_at is null or documents_checked_by_membership_id is not null or documents_checked_automatically);
