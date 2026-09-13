CREATE TYPE "public"."actor_type" AS ENUM('user', 'ai', 'system', 'customer');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('none', 'pending', 'confirmed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('pending', 'accepted', 'sent', 'delivered', 'read', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."handler_mode" AS ENUM('ai', 'human');--> statement-breakpoint
CREATE TYPE "public"."inbound_event_status" AS ENUM('received', 'processing', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('admin', 'manager', 'salesperson', 'operations');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'interactive', 'template', 'system', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'published', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."sales_stage" AS ENUM('new', 'qualifying', 'qualified', 'options_sent', 'quote_sent', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."waiting_reason" AS ENUM('none', 'waiting_for_customer', 'waiting_for_operations', 'waiting_for_internal_approval');--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_operator_user_key" UNIQUE("operator_id","user_id"),
	CONSTRAINT "memberships_id_operator_key" UNIQUE("id","operator_id")
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Dubai' NOT NULL,
	"service_hours" jsonb,
	"response_expectation" text,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"ai_sending_enabled" boolean DEFAULT false NOT NULL,
	"retention_days" integer DEFAULT 730 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"display_phone_number" text,
	"secret_ref" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_accounts_id_operator_key" UNIQUE("id","operator_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"channel_identifier" text NOT NULL,
	"display_name" text,
	"verified_identity_ref" text,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_id_operator_key" UNIQUE("id","operator_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"whatsapp_account_id" uuid NOT NULL,
	"sales_stage" "sales_stage" DEFAULT 'new' NOT NULL,
	"handler_mode" "handler_mode" DEFAULT 'ai' NOT NULL,
	"waiting_reason" "waiting_reason" DEFAULT 'none' NOT NULL,
	"booking_status" "booking_status" DEFAULT 'none' NOT NULL,
	"owner_membership_id" uuid,
	"priority" "priority" DEFAULT 'normal' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"last_customer_message_at" timestamp with time zone,
	"last_staff_response_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"next_action_at" timestamp with time zone,
	"next_action" text,
	"lost_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_id_operator_key" UNIQUE("id","operator_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"kind" "message_kind" NOT NULL,
	"provider_id" text,
	"body" text,
	"media" jsonb,
	"delivery_state" "delivery_state" DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"error_detail" text,
	"sent_by_membership_id" uuid,
	"idempotency_key" text,
	"revision_at_send" integer,
	"provider_timestamp" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"subject_version" integer,
	"correlation_id" uuid,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"whatsapp_account_id" uuid NOT NULL,
	"provider_event_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "inbound_event_status" DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_id" uuid,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_operator_fkey" FOREIGN KEY ("contact_id","operator_id") REFERENCES "public"."contacts"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_operator_fkey" FOREIGN KEY ("whatsapp_account_id","operator_id") REFERENCES "public"."whatsapp_accounts"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_operator_fkey" FOREIGN KEY ("owner_membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_operator_fkey" FOREIGN KEY ("conversation_id","operator_id") REFERENCES "public"."conversations"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_operator_fkey" FOREIGN KEY ("sent_by_membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_whatsapp_account_id_whatsapp_accounts_id_fk" FOREIGN KEY ("whatsapp_account_id") REFERENCES "public"."whatsapp_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memberships_operator_active_idx" ON "memberships" USING btree ("operator_id") WHERE active;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_accounts_phone_number_id_key" ON "whatsapp_accounts" USING btree ("phone_number_id");--> statement-breakpoint
CREATE INDEX "whatsapp_accounts_operator_idx" ON "whatsapp_accounts" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_operator_channel_key" ON "contacts" USING btree ("operator_id","channel_identifier");--> statement-breakpoint
CREATE INDEX "conversations_operator_stage_idx" ON "conversations" USING btree ("operator_id","sales_stage");--> statement-breakpoint
CREATE INDEX "conversations_operator_owner_idx" ON "conversations" USING btree ("operator_id","owner_membership_id");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_operator_provider_id_key" ON "messages" USING btree ("operator_id","provider_id") WHERE provider_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_operator_idempotency_key" ON "messages" USING btree ("operator_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_operator_created_idx" ON "audit_events" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_account_event_key" ON "inbound_events" USING btree ("whatsapp_account_id","provider_event_key");--> statement-breakpoint
CREATE INDEX "inbound_events_status_idx" ON "inbound_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "inbound_events_operator_idx" ON "inbound_events" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_dead_idx" ON "outbox" USING btree ("operator_id","created_at") WHERE status = 'dead';