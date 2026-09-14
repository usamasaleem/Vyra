CREATE TYPE "public"."quote_state" AS ENUM('draft', 'approved', 'sent', 'expired', 'superseded', 'rejected');--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"enquiry_id" uuid,
	"vehicle_id" uuid,
	"revision" integer NOT NULL,
	"state" "quote_state" DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'AED' NOT NULL,
	"total_minor" integer NOT NULL,
	"deposit_minor" integer,
	"lines" jsonb NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"days" integer,
	"rate_id" uuid,
	"valid_until" timestamp with time zone,
	"approved_by_membership_id" uuid,
	"approved_at" timestamp with time zone,
	"sent_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_id_operator_key" UNIQUE("id","operator_id")
);
--> statement-breakpoint
CREATE TABLE "vehicle_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"currency" text DEFAULT 'AED' NOT NULL,
	"daily_rate_minor" integer NOT NULL,
	"weekly_rate_minor" integer,
	"monthly_rate_minor" integer,
	"minimum_days" integer DEFAULT 1 NOT NULL,
	"included_km_per_day" integer,
	"extra_km_rate_minor" integer,
	"deposit_minor" integer,
	"delivery_fee_minor" integer,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"provenance" "fleet_provenance" DEFAULT 'placeholder' NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_rates_id_operator_key" UNIQUE("id","operator_id")
);
--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_conversation_operator_fkey" FOREIGN KEY ("conversation_id","operator_id") REFERENCES "public"."conversations"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_enquiry_operator_fkey" FOREIGN KEY ("enquiry_id","operator_id") REFERENCES "public"."enquiries"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_approver_operator_fkey" FOREIGN KEY ("approved_by_membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_rates" ADD CONSTRAINT "vehicle_rates_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_rates" ADD CONSTRAINT "vehicle_rates_vehicle_operator_fkey" FOREIGN KEY ("vehicle_id","operator_id") REFERENCES "public"."vehicles"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quotes_operator_state_idx" ON "quotes" USING btree ("operator_id","state","created_at");--> statement-breakpoint
CREATE INDEX "quotes_conversation_idx" ON "quotes" USING btree ("conversation_id","revision");--> statement-breakpoint
CREATE INDEX "vehicle_rates_vehicle_current_idx" ON "vehicle_rates" USING btree ("vehicle_id","effective_to");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON vehicle_rates, quotes TO vyra_app;--> statement-breakpoint
ALTER TABLE vehicle_rates ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY vyra_app_scope ON vehicle_rates FOR ALL TO vyra_app
  USING (operator_id IN (SELECT public.vyra_operator_ids()))
  WITH CHECK (operator_id IN (SELECT public.vyra_operator_ids()));--> statement-breakpoint
CREATE POLICY vyra_app_scope ON quotes FOR ALL TO vyra_app
  USING (operator_id IN (SELECT public.vyra_operator_ids()))
  WITH CHECK (operator_id IN (SELECT public.vyra_operator_ids()));--> statement-breakpoint
-- One current rate per vehicle. Two rows both claiming to be in force is a
-- calculation that silently picks one, and the customer finds out which.
CREATE UNIQUE INDEX vehicle_rates_one_current_per_vehicle
  ON vehicle_rates (vehicle_id) WHERE effective_to IS NULL;--> statement-breakpoint
-- One draft per conversation at a time, for the same reason: two unapproved
-- drafts means an approver picks one without knowing the other exists.
CREATE UNIQUE INDEX quotes_one_draft_per_conversation
  ON quotes (conversation_id) WHERE state = 'draft';--> statement-breakpoint
-- Money is never negative, and an approved quote has an approver and a time.
ALTER TABLE quotes ADD CONSTRAINT quotes_amounts_are_sane
  CHECK (total_minor >= 0 AND (deposit_minor IS NULL OR deposit_minor >= 0));--> statement-breakpoint
ALTER TABLE quotes ADD CONSTRAINT quotes_approval_is_attributed
  CHECK (
    state NOT IN ('approved', 'sent')
    OR (approved_by_membership_id IS NOT NULL AND approved_at IS NOT NULL)
  );--> statement-breakpoint
ALTER TABLE vehicle_rates ADD CONSTRAINT vehicle_rates_confirmed_is_attributed
  CHECK (
    provenance <> 'operator_confirmed'
    OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
  );--> statement-breakpoint
DO $$
DECLARE unprotected text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'operator_id' AND a.attnum > 0
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'these tables carry operator_id but have no row-level security: %', unprotected;
  END IF;
END $$;
