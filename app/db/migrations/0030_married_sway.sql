ALTER TABLE "whatsapp_accounts" ADD COLUMN "access_token_cipher" text;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD COLUMN "token_hint" text;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD COLUMN "connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD COLUMN "connected_by_membership_id" uuid;