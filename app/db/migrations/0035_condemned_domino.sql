-- Retire every live answer that no account ever published.
--
-- Nine of them, seeded, and the agent has been quoting them to real customers
-- as the operator's confirmed policy: a AED 5,000 deposit, 250km a day, AED 10
-- a kilometre after that, what a visitor needs to drive. All invented.
--
-- Retired rather than deleted. What we told a customer is a fact about this
-- business now, and `messages` proves we said it — destroying the policy row
-- would leave the sentence with no explanation for why it was ever sent.
--
-- The criterion is structural rather than a search for the word DEMO:
-- published, currently live, and published by nobody. A real answer goes
-- through publishKnowledge, which records the account that pressed the button.
UPDATE "knowledge_entries"
SET "effective_to" = now()
WHERE "published_at" IS NOT NULL
  AND "effective_to" IS NULL
  AND "published_by_membership_id" IS NULL;--> statement-breakpoint

INSERT INTO "audit_events" ("operator_id", "actor_type", "action", "subject_type", "subject_id", "data")
SELECT DISTINCT k."operator_id", 'system'::actor_type, 'knowledge.retired_unattributed', 'operator', k."operator_id",
       jsonb_build_object(
         'why', 'published with no account behind it; stated to customers as confirmed policy',
         'topics', (SELECT jsonb_agg(DISTINCT t."topic") FROM "knowledge_entries" t
                     WHERE t."operator_id" = k."operator_id"
                       AND t."published_by_membership_id" IS NULL
                       AND t."published_at" IS NOT NULL))
FROM "knowledge_entries" k
WHERE k."published_at" IS NOT NULL AND k."published_by_membership_id" IS NULL;--> statement-breakpoint

ALTER TABLE "knowledge_entries" ADD COLUMN "confirmed_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_confirmer_operator_fkey" FOREIGN KEY ("confirmed_by_membership_id","operator_id") REFERENCES "public"."memberships"("id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- NOT VALID: the fabricated rows stay exactly as they are.
--
-- Backfilling them with the real admin's membership would satisfy this
-- constraint by recording that a person confirmed content they have never seen
-- — which is the thing being fixed, written into the column built to prevent
-- it. They are retired, they can never be served again, and the history says
-- truthfully that nobody stood behind them.
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_published_requires_a_real_person" CHECK (published_at is null or (
        confirmed_by_membership_id is not null
        and published_by_membership_id is not null
      )) NOT VALID;
