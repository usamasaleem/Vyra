CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"notified_at" timestamp with time zone,
	"notified_message_id" uuid,
	"closed_reason" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_conversation_operator_fkey" FOREIGN KEY ("conversation_id","operator_id") REFERENCES "public"."conversations"("id","operator_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_vehicle_operator_fkey" FOREIGN KEY ("vehicle_id","operator_id") REFERENCES "public"."vehicles"("id","operator_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_one_open" ON "waitlist_entries" USING btree ("conversation_id","vehicle_id","start_date","end_date") WHERE closed_at is null;--> statement-breakpoint
CREATE INDEX "waitlist_entries_open_idx" ON "waitlist_entries" USING btree ("operator_id","vehicle_id") WHERE closed_at is null;--> statement-breakpoint
grant select, insert, update, delete on waitlist_entries to vyra_app;--> statement-breakpoint
alter table waitlist_entries enable row level security;--> statement-breakpoint
create policy vyra_app_scope on waitlist_entries for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));
