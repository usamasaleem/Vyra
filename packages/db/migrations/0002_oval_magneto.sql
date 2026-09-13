ALTER TYPE "public"."delivery_state" ADD VALUE 'dispatching' BEFORE 'accepted';--> statement-breakpoint
ALTER TYPE "public"."delivery_state" ADD VALUE 'cancelled' BEFORE 'accepted';