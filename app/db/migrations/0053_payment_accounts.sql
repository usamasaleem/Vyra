CREATE TABLE "payment_accounts" (
	"operator_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"secret_key_cipher" text NOT NULL,
	"secret_key_hint" text NOT NULL,
	"webhook_secret_cipher" text NOT NULL,
	"webhook_endpoint_id" text NOT NULL,
	"account_id" text NOT NULL,
	"livemode" boolean NOT NULL,
	"connected_by_membership_id" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "link_session_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "link_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
grant select, insert, update, delete on payment_accounts to vyra_app;--> statement-breakpoint
alter table payment_accounts enable row level security;--> statement-breakpoint
create policy vyra_app_scope on payment_accounts for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));
