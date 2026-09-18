CREATE TYPE "public"."booking_state" AS ENUM('requested', 'confirmed', 'declined', 'cancelled');--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"enquiry_id" uuid,
	"quote_id" uuid NOT NULL,
	"state" "booking_state" DEFAULT 'requested' NOT NULL,
	"requested_from_message_id" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_membership_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_conversation_operator_fkey" FOREIGN KEY ("conversation_id","operator_id") REFERENCES "public"."conversations"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_quote_operator_fkey" FOREIGN KEY ("quote_id","operator_id") REFERENCES "public"."quotes"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_enquiry_operator_fkey" FOREIGN KEY ("enquiry_id","operator_id") REFERENCES "public"."enquiries"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_decider_operator_fkey" FOREIGN KEY ("decided_by_membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_live_quote_key" ON "bookings" USING btree ("quote_id") WHERE state in ('requested', 'confirmed');--> statement-breakpoint
CREATE INDEX "bookings_operator_state_idx" ON "bookings" USING btree ("operator_id","state","requested_at");--> statement-breakpoint
CREATE INDEX "bookings_conversation_idx" ON "bookings" USING btree ("conversation_id");--> statement-breakpoint
-- Tenant data like everything else, and the guard at the end of 0010 fails the
-- migration if this is forgotten.
grant select, insert, update on bookings to vyra_app;

alter table bookings enable row level security;

create policy vyra_app_scope on bookings for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));
