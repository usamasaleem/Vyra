CREATE TABLE "operator_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"invited_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "operator_invitations" ADD CONSTRAINT "operator_invitations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_invitations_live_key" ON "operator_invitations" USING btree ("operator_id","email") WHERE accepted_at is null and revoked_at is null;--> statement-breakpoint
CREATE INDEX "operator_invitations_email_idx" ON "operator_invitations" USING btree ("email");--> statement-breakpoint
-- The invitation is tenant data like everything else, and the guard at the end
-- of 0010 fails the migration if this is forgotten.
grant select, insert, update on operator_invitations to vyra_app;

alter table operator_invitations enable row level security;

create policy vyra_app_scope on operator_invitations for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));

-- The one read that cannot be scoped this way: at sign-up the person has no
-- membership yet, so no policy can find their invitation for them. That lookup
-- runs privileged, keyed on the address they just proved they control by
-- signing in with it, and is the only place that reads this table unscoped.
