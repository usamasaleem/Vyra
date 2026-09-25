CREATE TABLE "whatsapp_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"provider_template_id" text,
	"rejected_reason" text,
	"submitted_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "template" jsonb;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_templates_name_key" ON "whatsapp_templates" USING btree ("operator_id","name","language");--> statement-breakpoint
grant select on whatsapp_templates to vyra_app;--> statement-breakpoint
alter table whatsapp_templates enable row level security;--> statement-breakpoint
create policy vyra_app_scope on whatsapp_templates for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));
