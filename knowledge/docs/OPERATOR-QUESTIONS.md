# The six questions only the operator can answer

Every other part of Phase 4 is built. These six answers are the last thing
standing between the agent and a real customer conversation, and nobody on the
build side can supply them — section 8 of the specification is explicit that
these terms vary widely between Dubai operators, so ours cannot be inferred
from anyone else's.

Until each one is answered and published, the agent's correct behaviour is to
say *"let me confirm that for you"* and hand over. That is working as designed,
not a bug. It is also a worse customer experience than answering, which is the
whole reason to collect these.

## Why the placeholders are dangerous

`app/evals/src/fixtures/placeholder-policy.ts` holds a plausible answer for
each of these. **Every figure in it is invented.** They are shaped like real
Dubai terms so the system could be built and evaluated realistically — which is
exactly what makes them hazardous. A plausible invented deposit is far harder to
spot than an obviously wrong one.

The database refuses to publish them. A `check` constraint on
`knowledge_entries` rejects any row marked `published_at` unless its provenance
is `operator_confirmed` and it carries a named confirmer and a date. That is a
constraint, not a convention: no code path can publish a placeholder, including
one written later by someone who does not know this.

## What a usable answer looks like

Three things, per topic:

1. **The answer**, in the operator's own words.
2. **Who confirmed it** — a name, because a published answer binds the business.
3. **When it takes effect** — today unless it is a change with a start date.

Where a figure varies by vehicle category, say so. A single deposit number
across a Range Rover and an SR-71 is wrong for one of them, and the agent will
quote it to a customer exactly as given.

---

## 1. Deposit

> What deposit do you take, how is it held, and when is it returned?

Split by vehicle category if it differs. Say whether it is blocked on a credit
card or taken as a payment, and what it is settled against — Salik, fines,
fuel. The most common follow-up question from a customer is *when* they get it
back, so a real number of days is worth more than "shortly".

*Eval cases blocked:* `deposit-question`, `ar-deposit-question`

## 2. Included kilometres

> How many kilometres per day are included, and what is the charge beyond that?

Again, by category if it differs. Customers ask this before they book, not
after, and a wrong answer here becomes a billing dispute.

*Eval case blocked:* `included-kilometres`

## 3. Driver requirements

> What is the minimum age, and what documents must a driver present?

Two lists are needed, because the answer differs: a **UAE resident** and a
**visitor**. Licence, International Driving Permit, passport, visa or entry
stamp, Emirates ID, and which payment instrument must be in the driver's own
name. Minimum age by vehicle category.

The agent must never give a definitive eligibility ruling — it explains the
checklist and routes anything uncertain to a person. But it cannot explain a
checklist it does not have.

*Eval case blocked:* `driver-requirements-visitor`

## 4. Delivery areas

> Where do you deliver, what does each area cost, and can the customer drive
> to another emirate?

Include which areas are free, which carry a fee, and which are arranged case by
case. The cross-emirate question matters separately: customers ask whether they
may take the car to Abu Dhabi, and that is a different question from whether
you will deliver there.

*Eval case blocked:* `delivery-area`

## 5. Business hours

> When is your team actually reachable, and what should a customer be told
> outside those hours?

The second half is the part that usually gets skipped. *"We will get back to
you shortly"* is not an answer — it sets an expectation the team may not meet
at 2am, and the customer notices. A real one reads like *"someone will reply
when we open at 9am."*

Days and times in Dubai time, including any difference for Friday and Saturday.

*Eval case blocked:* `out-of-hours`

## 6. Follow-up timing

> If a customer goes quiet, how long do you wait, how many times do you follow
> up, and what should those messages say?

These become approved templates, so the wording matters as much as the timing.
Also worth stating explicitly: when to stop. An agent that follows up
indefinitely is the fastest way to get a business number reported.

*Eval case blocked:* `goes-quiet`

---

## After the answers arrive

1. Replace the placeholder in `placeholder-policy.ts` with the real wording.
2. Record the confirmer's name and the date.
3. Publish through the inbox, which sets provenance to `operator_confirmed`.
4. Re-run the comparison — the policy cases move from "refused correctly" to
   "answered from an approved source", which is a different and much stronger
   test of a model.

Nothing is seeded into `knowledge_entries` until then, deliberately: a
comparison run against invented answers would be measuring a system that does
not exist.
