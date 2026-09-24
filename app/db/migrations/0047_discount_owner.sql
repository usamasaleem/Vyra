ALTER TABLE "operators" ADD COLUMN "discount_tiers_set_by_membership_id" uuid;--> statement-breakpoint
-- A standing discount with nobody behind it is not an offer anyone made.
ALTER TABLE "operators" ADD CONSTRAINT "operators_discount_tiers_are_attributed"
  CHECK (discount_tiers is null or discount_tiers_set_by_membership_id is not null);
