CREATE TYPE "public"."enquiry_field" AS ENUM('vehicle', 'start_at', 'end_at', 'duration', 'delivery_preference', 'location', 'residency', 'driver_age', 'budget', 'special_requirements');
--> statement-breakpoint
CREATE TYPE "public"."verification_state" AS ENUM('unknown', 'customer_stated', 'system_verified', 'human_confirmed', 'expired', 'conflicting');
--> statement-breakpoint
CREATE TABLE "enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"stage" "sales_stage" DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enquiries_id_operator_key" UNIQUE("id","operator_id")
);
--> statement-breakpoint
CREATE TABLE "field_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"field" "enquiry_field" NOT NULL,
	"value" text NOT NULL,
	"original_wording" text,
	"source_message_id" uuid,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verification_state" "verification_state" DEFAULT 'customer_stated' NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_conversation_operator_fkey" FOREIGN KEY ("conversation_id","operator_id") REFERENCES "public"."conversations"("id","operator_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "field_evidence" ADD CONSTRAINT "field_evidence_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "field_evidence" ADD CONSTRAINT "field_evidence_enquiry_operator_fkey" FOREIGN KEY ("enquiry_id","operator_id") REFERENCES "public"."enquiries"("id","operator_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_id_operator_key" UNIQUE("id","operator_id");
--> statement-breakpoint
ALTER TABLE "field_evidence" ADD CONSTRAINT "field_evidence_message_operator_fkey" FOREIGN KEY ("source_message_id","operator_id") REFERENCES "public"."messages"("id","operator_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "enquiries_conversation_idx" ON "enquiries" USING btree ("conversation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "field_evidence_one_live_per_field" ON "field_evidence" USING btree ("enquiry_id","field") WHERE superseded_at is null;
--> statement-breakpoint
CREATE INDEX "field_evidence_enquiry_idx" ON "field_evidence" USING btree ("enquiry_id","field");
--> statement-breakpoint
-- Row-level security on the same terms as every other table.
ALTER TABLE "enquiries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "field_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "enquiries", "field_evidence" TO vyra_app;
--> statement-breakpoint
CREATE POLICY vyra_app_scope ON "enquiries" FOR ALL TO vyra_app
  USING (operator_id IN (SELECT public.vyra_operator_ids()))
  WITH CHECK (operator_id IN (SELECT public.vyra_operator_ids()));
--> statement-breakpoint
CREATE POLICY vyra_app_scope ON "field_evidence" FOR ALL TO vyra_app
  USING (operator_id IN (SELECT public.vyra_operator_ids()))
  WITH CHECK (operator_id IN (SELECT public.vyra_operator_ids()));
