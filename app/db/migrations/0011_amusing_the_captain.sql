CREATE TYPE "public"."handoff_reason" AS ENUM('customer_asked', 'qualified_lead', 'discount_requested', 'cannot_verify', 'payment_or_dispute', 'safety_or_accident', 'non_text_message', 'agent_uncertain', 'turn_failed');--> statement-breakpoint
CREATE TYPE "public"."handoff_state" AS ENUM('waiting', 'accepted', 'escalated', 'resolved');--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"reason" "handoff_reason" NOT NULL,
	"summary" text NOT NULL,
	"priority" "priority" DEFAULT 'normal' NOT NULL,
	"state" "handoff_state" DEFAULT 'waiting' NOT NULL,
	"owner_membership_id" uuid,
	"accepted_at" timestamp with time zone,
	"due_at" timestamp with time zone NOT NULL,
	"escalated_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"trigger_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoffs_id_operator_key" UNIQUE("id","operator_id")
);
--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "handoff_sla_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "fallback_owner_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_conversation_operator_fkey" FOREIGN KEY ("conversation_id","operator_id") REFERENCES "public"."conversations"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_owner_operator_fkey" FOREIGN KEY ("owner_membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handoffs_one_open_per_conversation" ON "handoffs" USING btree ("conversation_id") WHERE state in ('waiting', 'escalated');--> statement-breakpoint
CREATE INDEX "handoffs_operator_state_due_idx" ON "handoffs" USING btree ("operator_id","state","due_at");--> statement-breakpoint
CREATE INDEX "handoffs_conversation_idx" ON "handoffs" USING btree ("conversation_id");
--> statement-breakpoint
-- Row-level security for the handoff queue, and the guard from migration 0010
-- re-run so a table added without a policy fails here rather than shipping.
GRANT SELECT, INSERT, UPDATE ON handoffs TO vyra_app;--> statement-breakpoint
ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY vyra_app_scope ON handoffs FOR ALL TO vyra_app
  USING (operator_id IN (SELECT public.vyra_operator_ids()))
  WITH CHECK (operator_id IN (SELECT public.vyra_operator_ids()));--> statement-breakpoint
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
