ALTER TYPE "public"."payment_kind" ADD VALUE 'add_on';--> statement-breakpoint
DROP INDEX "payments_live_kind_key";--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "add_ons" jsonb;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "label" text;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_live_kind_key" ON "payments" USING btree ("booking_id","kind") WHERE state in ('due', 'paid') and label is null;--> statement-breakpoint
-- A label exactly when it is an add-on: money nobody can read is money nobody can
-- explain. Written against the old values, because a new enum value cannot be used
-- in the transaction that adds it.
ALTER TABLE "payments" ADD CONSTRAINT "payments_add_on_is_labelled"
  CHECK ((label is null) = (kind in ('rental', 'deposit')));--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_add_ons_is_a_list"
  CHECK (add_ons is null or jsonb_typeof(add_ons) = 'array');
