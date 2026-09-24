ALTER TABLE "operators" ADD COLUMN "auto_confirm_max_days" integer;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "handover_notice_minutes" integer;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "discount_tiers" jsonb;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_auto_confirm_max_days_sane"
  CHECK (auto_confirm_max_days is null or auto_confirm_max_days between 1 and 365);--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_handover_notice_sane"
  CHECK (handover_notice_minutes is null or handover_notice_minutes between 0 and 2880);--> statement-breakpoint
-- An array of tiers, each a number of days and a percentage the operator stands behind.
ALTER TABLE "operators" ADD CONSTRAINT "operators_discount_tiers_is_a_list"
  CHECK (discount_tiers is null or jsonb_typeof(discount_tiers) = 'array');
