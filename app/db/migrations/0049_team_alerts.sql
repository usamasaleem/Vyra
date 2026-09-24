CREATE TABLE "push_keys" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_keys_single_row" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"membership_id" uuid,
	"conversation_id" uuid,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"url" text NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_membership_operator_fkey" FOREIGN KEY ("membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_alerts" ADD CONSTRAINT "team_alerts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_operator_idx" ON "push_subscriptions" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_alerts_subject_key" ON "team_alerts" USING btree ("operator_id","kind","subject");--> statement-breakpoint
CREATE INDEX "team_alerts_unsent_idx" ON "team_alerts" USING btree ("created_at") WHERE sent_at is null;--> statement-breakpoint
grant select, insert, update, delete on push_subscriptions to vyra_app;--> statement-breakpoint
alter table push_subscriptions enable row level security;--> statement-breakpoint
create policy vyra_app_scope on push_subscriptions for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));--> statement-breakpoint
-- Staff read what was sent, and ask for a test alert; the worker sends.
grant select, insert on team_alerts to vyra_app;--> statement-breakpoint
alter table team_alerts enable row level security;--> statement-breakpoint
create policy vyra_app_scope on team_alerts for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));--> statement-breakpoint
-- The public half only: a phone needs it to subscribe, and nothing a signed-in
-- person does needs the private one.
grant select (id, public_key) on push_keys to vyra_app;
