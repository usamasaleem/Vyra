-- bookings never had the composite unique its children need. Added here
-- rather than in its own migration because payments is the first table to
-- reference it, and a foreign key without this target simply will not create.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_id_operator_key" UNIQUE("id","operator_id");--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('rental', 'deposit');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('link', 'bank_transfer', 'cash', 'card_in_person');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('due', 'paid', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"state" "payment_state" DEFAULT 'due' NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'AED' NOT NULL,
	"method" "payment_method",
	"link_url" text,
	"provider" text,
	"provider_ref" text,
	"recorded_by_membership_id" uuid,
	"reference" text,
	"paid_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_operator_fkey" FOREIGN KEY ("booking_id","operator_id") REFERENCES "public"."bookings"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_conversation_operator_fkey" FOREIGN KEY ("conversation_id","operator_id") REFERENCES "public"."conversations"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorder_operator_fkey" FOREIGN KEY ("recorded_by_membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_live_kind_key" ON "payments" USING btree ("booking_id","kind") WHERE state in ('due', 'paid');--> statement-breakpoint
CREATE INDEX "payments_operator_state_idx" ON "payments" USING btree ("operator_id","state","created_at");--> statement-breakpoint
-- Tenant data like everything else, and the guard at the end of 0010 fails the
-- migration if this is forgotten.
grant select, insert, update on payments to vyra_app;

alter table payments enable row level security;

create policy vyra_app_scope on payments for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));--> statement-breakpoint
-- An amount owed is a positive amount. Zero is not a payment and a negative
-- one is a refund, which is a state rather than a sign.
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_is_positive"
  CHECK (amount_minor > 0);--> statement-breakpoint
-- Taken means somebody or something says how and when. Without both, a row
-- reading 'paid' is a claim nobody stands behind — the same rule the quotes
-- and knowledge tables already carry.
ALTER TABLE "payments" ADD CONSTRAINT "payments_paid_is_evidenced"
  CHECK (state <> 'paid' or (paid_at is not null and method is not null));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_follows_payment"
  CHECK (state <> 'refunded' or (refunded_at is not null and paid_at is not null));
