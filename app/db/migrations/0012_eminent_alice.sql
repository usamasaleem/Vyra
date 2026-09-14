CREATE TYPE "public"."operations_answer" AS ENUM('available', 'unavailable', 'pending_confirmation', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."operations_request_kind" AS ENUM('availability', 'pricing');--> statement-breakpoint
CREATE TYPE "public"."operations_request_state" AS ENUM('open', 'answered', 'cancelled');--> statement-breakpoint
CREATE TABLE "operations_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid,
	"kind" "operations_request_kind" NOT NULL,
	"vehicle_id" uuid,
	"requested_vehicle" text,
	"start_date" date,
	"end_date" date,
	"state" "operations_request_state" DEFAULT 'open' NOT NULL,
	"answer" "operations_answer",
	"answer_note" text,
	"source" text,
	"checked_at" timestamp with time zone,
	"answered_by_membership_id" uuid,
	"answer_valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_requests_id_operator_key" UNIQUE("id","operator_id")
);
--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "answer_valid_minutes" integer DEFAULT 240 NOT NULL;--> statement-breakpoint
ALTER TABLE "operations_requests" ADD CONSTRAINT "operations_requests_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_requests" ADD CONSTRAINT "operations_requests_conversation_operator_fkey" FOREIGN KEY ("conversation_id","operator_id") REFERENCES "public"."conversations"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_requests" ADD CONSTRAINT "operations_requests_vehicle_operator_fkey" FOREIGN KEY ("vehicle_id","operator_id") REFERENCES "public"."vehicles"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_requests" ADD CONSTRAINT "operations_requests_answered_by_operator_fkey" FOREIGN KEY ("answered_by_membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operations_requests_operator_state_idx" ON "operations_requests" USING btree ("operator_id","state","created_at");--> statement-breakpoint
CREATE INDEX "operations_requests_answer_lookup_idx" ON "operations_requests" USING btree ("operator_id","vehicle_id","start_date","end_date");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON operations_requests TO vyra_app;--> statement-breakpoint
ALTER TABLE operations_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY vyra_app_scope ON operations_requests FOR ALL TO vyra_app
  USING (operator_id IN (SELECT public.vyra_operator_ids()))
  WITH CHECK (operator_id IN (SELECT public.vyra_operator_ids()));--> statement-breakpoint
-- An answer without a time checked cannot reach a customer (MVP section 6), so
-- the database refuses to record one. A constraint rather than a convention:
-- the read paths all require checked_at, and this makes it impossible for a
-- row to exist that would satisfy them dishonestly.
ALTER TABLE operations_requests ADD CONSTRAINT operations_requests_answer_is_checked
  CHECK (
    answer IS NULL
    OR (checked_at IS NOT NULL AND source IS NOT NULL AND answer_valid_until IS NOT NULL)
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
