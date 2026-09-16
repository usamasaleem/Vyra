ALTER TABLE "operators" ADD COLUMN "ai_resumes_after_minutes" integer DEFAULT 60;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ai_resumed_at" timestamp with time zone;