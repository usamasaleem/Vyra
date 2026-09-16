ALTER TABLE "handoffs" ADD COLUMN "escalated_to_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_escalated_to_operator_fkey" FOREIGN KEY ("escalated_to_membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The two handoffs already escalated into thin air. The sweep will not revisit
-- them: it only touches `state = 'waiting'`, and these are past that. Leaving
-- them null would mean the one customer this was built for stays invisible.
UPDATE "handoffs" h
SET "escalated_to_membership_id" = coalesce(
      (SELECT op."fallback_owner_membership_id" FROM "operators" op WHERE op."id" = h."operator_id"),
      (SELECT m."id" FROM "memberships" m
        WHERE m."operator_id" = h."operator_id" AND m."active"
        ORDER BY (m."role" = 'admin') DESC, (m."role" = 'manager') DESC, m."created_at"
        LIMIT 1))
WHERE h."escalated_at" IS NOT NULL AND h."escalated_to_membership_id" IS NULL;
