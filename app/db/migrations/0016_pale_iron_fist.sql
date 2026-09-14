CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"input_revision" integer NOT NULL,
	"prompt_version" text NOT NULL,
	"model_id" text NOT NULL,
	"result_state" text NOT NULL,
	"detail" text,
	"rounds" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"tool_names" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"cached_input_tokens" integer,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"reported_calls" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_operator_fkey" FOREIGN KEY ("conversation_id","operator_id") REFERENCES "public"."conversations"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_idx" ON "agent_runs" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_operator_created_idx" ON "agent_runs" USING btree ("operator_id","created_at");--> statement-breakpoint
-- Row-level security for the run log, and the guard from migration 0010 re-run
-- so a table added without a policy fails here rather than shipping.
--
-- No DELETE grant. A run record is the evidence for what the agent did and what
-- it cost; a cost report whose rows can be removed by the application is a cost
-- report nobody can rely on.
GRANT SELECT, INSERT ON agent_runs TO vyra_app;--> statement-breakpoint
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY vyra_app_scope ON agent_runs FOR ALL TO vyra_app
  USING (operator_id IN (SELECT public.vyra_operator_ids()))
  WITH CHECK (operator_id IN (SELECT public.vyra_operator_ids()));--> statement-breakpoint
-- Tokens are counts. A negative one is a parsing bug, and it would quietly
-- reduce a total rather than announce itself.
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_tokens_are_counts
  CHECK (
    (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
    AND (reasoning_tokens IS NULL OR reasoning_tokens >= 0)
    AND (cached_input_tokens IS NULL OR cached_input_tokens >= 0)
  );--> statement-breakpoint
-- Usage cannot be reported by more calls than were made.
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_reported_calls_are_possible
  CHECK (reported_calls <= model_calls);--> statement-breakpoint
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
