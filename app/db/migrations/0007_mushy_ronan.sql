CREATE TYPE "public"."knowledge_provenance" AS ENUM('placeholder', 'operator_confirmed');--> statement-breakpoint
CREATE TABLE "knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"covers" text,
	"answer" text NOT NULL,
	"version" integer NOT NULL,
	"provenance" "knowledge_provenance" DEFAULT 'placeholder' NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by_membership_id" uuid,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_published_requires_operator_confirmation" CHECK (published_at is null or (
        provenance = 'operator_confirmed'
        and confirmed_by is not null
        and confirmed_at is not null
        and effective_from is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_publisher_operator_fkey" FOREIGN KEY ("published_by_membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_entries_operator_topic_version_key" ON "knowledge_entries" USING btree ("operator_id","topic","version");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_entries_one_current_per_topic" ON "knowledge_entries" USING btree ("operator_id","topic") WHERE published_at is not null and effective_to is null;--> statement-breakpoint
CREATE INDEX "knowledge_entries_lookup_idx" ON "knowledge_entries" USING btree ("operator_id","topic","effective_from");--> statement-breakpoint
-- Row-level security for the new table, on the same terms as every other.
-- A table added after migration 0005 does not inherit its policies, and a
-- knowledge table left open would expose one operator's commercial terms to
-- another.
ALTER TABLE "knowledge_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "knowledge_entries" TO vyra_app;--> statement-breakpoint
CREATE POLICY vyra_app_scope ON "knowledge_entries" FOR ALL TO vyra_app
  USING (operator_id IN (SELECT public.vyra_operator_ids()))
  WITH CHECK (operator_id IN (SELECT public.vyra_operator_ids()));
