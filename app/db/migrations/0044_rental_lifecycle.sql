ALTER TABLE "bookings" ADD COLUMN "return_time" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "return_address" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "returned_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_return_time_is_a_time"
  CHECK (return_time is null or return_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');--> statement-breakpoint
-- A car marked back with nobody against it is not a record.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_return_is_attributed"
  CHECK (returned_at is null or returned_by_membership_id is not null);
