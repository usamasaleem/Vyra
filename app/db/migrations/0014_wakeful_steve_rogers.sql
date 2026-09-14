CREATE TYPE "public"."follow_up_state" AS ENUM('scheduled', 'sent', 'cancelled', 'needs_a_person');--> statement-breakpoint
CREATE TABLE "follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"state" "follow_up_state" DEFAULT 'scheduled' NOT NULL,
	"reason" text NOT NULL,
	"sent_body" text,
	"sent_message_id" uuid,
	"sent_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_conversation_operator_fkey" FOREIGN KEY ("conversation_id","operator_id") REFERENCES "public"."conversations"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "follow_ups_one_scheduled_per_conversation" ON "follow_ups" USING btree ("conversation_id") WHERE state = 'scheduled';--> statement-breakpoint
CREATE INDEX "follow_ups_due_idx" ON "follow_ups" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "follow_ups_conversation_idx" ON "follow_ups" USING btree ("conversation_id");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON follow_ups TO vyra_app;--> statement-breakpoint
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY vyra_app_scope ON follow_ups FOR ALL TO vyra_app
  USING (operator_id IN (SELECT public.vyra_operator_ids()))
  WITH CHECK (operator_id IN (SELECT public.vyra_operator_ids()));--> statement-breakpoint
-- A sent follow-up has a body and a time. Section 11 allows only approved
-- automated follow-ups, and a sent row with no record of what was said is one
-- nobody can check afterwards.
ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_sent_is_recorded
  CHECK (state <> 'sent' OR (sent_body IS NOT NULL AND sent_at IS NOT NULL));--> statement-breakpoint
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
