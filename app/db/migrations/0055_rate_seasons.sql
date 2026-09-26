CREATE TABLE "rate_seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"vehicle_id" uuid,
	"name" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"percent" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by" text,
	"removed_at" timestamp with time zone,
	CONSTRAINT "rate_seasons_dates" CHECK (start_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and end_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and end_date >= start_date),
	CONSTRAINT "rate_seasons_percent" CHECK (percent between -90 and 300 and percent <> 0)
);
--> statement-breakpoint
ALTER TABLE "rate_seasons" ADD CONSTRAINT "rate_seasons_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_seasons" ADD CONSTRAINT "rate_seasons_vehicle_operator_fkey" FOREIGN KEY ("vehicle_id","operator_id") REFERENCES "public"."vehicles"("id","operator_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_seasons_live_idx" ON "rate_seasons" USING btree ("operator_id","start_date") WHERE removed_at is null;--> statement-breakpoint
grant select, insert, update, delete on rate_seasons to vyra_app;--> statement-breakpoint
alter table rate_seasons enable row level security;--> statement-breakpoint
create policy vyra_app_scope on rate_seasons for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));
