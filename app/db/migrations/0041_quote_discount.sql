ALTER TABLE "quotes" ADD COLUMN "discount_minor" integer;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "discount_reason" text;--> statement-breakpoint
-- A discount is an amount off a price, not a way to invent one. Anything that
-- would make the total negative, or that claims a reduction of nothing, is a
-- mistake rather than a deal.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_discount_is_a_reduction"
  CHECK (discount_minor is null or (discount_minor > 0 and total_minor >= 0));--> statement-breakpoint
-- And a discount that nobody put their name to is the thing this prevents.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_discount_is_attributed"
  CHECK (discount_minor is null or approved_by_membership_id is not null);
