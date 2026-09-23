CREATE TABLE "booking_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "delivery_address" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "delivery_time" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "payment_plan" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "customer_reported_paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "documents_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "documents_checked_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_documents" ADD CONSTRAINT "booking_documents_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_documents" ADD CONSTRAINT "booking_documents_booking_operator_fkey" FOREIGN KEY ("booking_id","operator_id") REFERENCES "public"."bookings"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_documents" ADD CONSTRAINT "booking_documents_conversation_operator_fkey" FOREIGN KEY ("conversation_id","operator_id") REFERENCES "public"."conversations"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_documents_message_key" ON "booking_documents" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "booking_documents_booking_idx" ON "booking_documents" USING btree ("booking_id");--> statement-breakpoint
grant select, insert, update on booking_documents to vyra_app;

alter table booking_documents enable row level security;

create policy vyra_app_scope on booking_documents for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));--> statement-breakpoint
-- The three ways an operator takes money, and nothing a model could invent.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_payment_plan_known"
  CHECK (payment_plan is null or payment_plan in ('transfer', 'link', 'on_delivery'));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_delivery_time_is_a_time"
  CHECK (delivery_time is null or delivery_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');--> statement-breakpoint
-- A check with nobody against it is not a check.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_documents_check_is_attributed"
  CHECK (documents_checked_at is null or documents_checked_by_membership_id is not null);
