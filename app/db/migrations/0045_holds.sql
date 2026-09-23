ALTER TABLE "operators" ADD COLUMN "hold_minutes" integer;--> statement-breakpoint
ALTER TABLE "vehicle_availability" ADD COLUMN "held_for_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "vehicle_availability" ADD COLUMN "held_for_quote_id" uuid;--> statement-breakpoint
ALTER TABLE "vehicle_availability" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
-- A hold of minutes, not days: long enough to decide, short of taking the car off sale.
ALTER TABLE "operators" ADD CONSTRAINT "operators_hold_minutes_sane"
  CHECK (hold_minutes is null or hold_minutes between 15 and 1440);--> statement-breakpoint
-- A hold is for somebody and ends on its own; one without either is just a block.
ALTER TABLE "vehicle_availability" ADD CONSTRAINT "vehicle_availability_hold_is_complete"
  CHECK ((held_for_conversation_id is null) = (expires_at is null));
