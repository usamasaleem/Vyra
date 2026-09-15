CREATE TABLE "vehicle_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"reason" text DEFAULT 'booked' NOT NULL,
	"note" text,
	"recorded_by" text NOT NULL,
	"recorded_by_membership_id" uuid,
	"released_at" timestamp with time zone,
	"released_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "availability_calendar_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicle_availability" ADD CONSTRAINT "vehicle_availability_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_availability" ADD CONSTRAINT "vehicle_availability_vehicle_operator_fkey" FOREIGN KEY ("vehicle_id","operator_id") REFERENCES "public"."vehicles"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vehicle_availability_lookup_idx" ON "vehicle_availability" USING btree ("operator_id","vehicle_id","start_date","end_date");--> statement-breakpoint
-- A block that ends before it starts is a typo that silently blocks nothing.
ALTER TABLE vehicle_availability ADD CONSTRAINT vehicle_availability_dates_are_ordered
  CHECK (end_date >= start_date);--> statement-breakpoint
-- Released means released by somebody. An anonymous release is a booking that
-- vanished, and the customer who lost the car cannot be told why.
ALTER TABLE vehicle_availability ADD CONSTRAINT vehicle_availability_release_is_attributed
  CHECK (released_at IS NULL OR released_by IS NOT NULL);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON vehicle_availability TO vyra_app;--> statement-breakpoint
ALTER TABLE vehicle_availability ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY vyra_app_scope ON vehicle_availability FOR ALL TO vyra_app
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
