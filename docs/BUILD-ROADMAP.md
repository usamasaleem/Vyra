# Vyra — Build Roadmap

Three gates to a paying pilot · one builder, full-time

**These are estimates, not commitments.** They assume one experienced full-stack developer working full-time, starting from the prototype described in [CURRENT-STATE.md](CURRENT-STATE.md). No part of this schedule has been measured against real work. Part-time, multiply by roughly 2.5.

## The organising idea

Sellable comes before finished. Completing the MVP checklist first is the most common way a solo build spends four months and still has no operator who has agreed to pay. These gates are therefore ordered by **what each one lets you sell**, not by what is easiest to build.

| Gate | Weeks | Outcome |
|---|---|---|
| 1 — Working demo | 1–4 | A demo that survives a skeptical operator; a design partner commits |
| 2 — One operator live | 5–11 | Supervised pilot in shadow mode; first recurring revenue |
| 3 — Evidence, then repeat | 12–16 | Measured before-and-after; repeatable sales |

Meta business verification runs alongside the whole build and is the one span that cannot be compressed by working harder.

---

## Gate 1 — A demo that survives a skeptical operator (weeks 1–4)

The purpose is not a product. It is a conversation you can run in front of someone who rents Lamborghinis for a living, without anything embarrassing happening.

**Build:** durable transport (signature verification, save-before-acknowledge, deduplication, outbox, dispatcher), a minimal inbox with manual reply and takeover, conversation storage that survives a restart, and AI drafting from a small set of hand-written answers.

**Skip entirely:** approved-knowledge management, follow-ups, reporting, quote calculation, multi-operator isolation, everything in the Operations MVP.

**What this lets you sell:** not a subscription — nothing has touched a real customer yet. Three ways to take money in this window are described in [GO-TO-MARKET.md](GO-TO-MARKET.md).

This is where you stop spending your own money, not where recurring revenue starts.

## Gate 2 — One operator live, supervised (weeks 5–11)

Their knowledge, their number, their salespeople — running in **shadow mode**, where the AI drafts and a person sends every message.

**Build:** their approved FAQs, rates, requirements and delivery areas loaded and versioned; extraction of the five qualifying fields with dates resolved against their timezone; the handoff packet, queue and owner; the Operations request queue and a console to answer it; voice notes and photos acknowledged and routed; the eight safety rules enforced in the backend rather than the prompt.

**Still skip:** quote calculation and approval workflow, follow-up automation, booking creation, payments, documents, Arabic, reporting dashboards.

**What this lets you sell:** the pilot itself, at roughly the Starter price the market research proposes for a small operator.

Shadow mode is not a limitation to apologise for. *"Your team approves every message — the AI just makes sure nothing waits"* is an easier sell to someone whose brand is the product than full autonomy would be, and it is Step 1 of the specification's own rollout rather than a detour around it.

## Gate 3 — Evidence, then repeat (weeks 12–16)

Operators three through ten are not closed by a demo. They are closed by what happened to operator one.

**Build:** limited automation (clarifying questions and approved FAQs sent by the AI, everything else still drafted); measurement of first-response time, enquiries captured and handoffs, before and after; tenant isolation hardened and tested against a second operator's data; admin configuration and an onboarding path that does not require you in the database.

**Now worth adding:** follow-up automation once opt-out handling is proven; a simple funnel view for the operator's manager; quote drafting if the pilot showed it was the bottleneck.

**What this lets you sell:** a number. *"Their median first response went from four hours to ninety seconds, and they stopped losing weekend enquiries."* It is also the first claim in this project backed by measurement rather than estimate.

---

## Scope discipline

### Safe to defer

Quote calculation and approval workflow · follow-up automation · lead scoring · reporting dashboards · Arabic and mixed-language handling · everything in the Operations MVP beyond the request queue.

None of these are what an operator says yes to.

### Do not cut, even for one customer

**An operator ID on every table, from the first migration.** Retrofitting tenancy is the single most expensive change on this roadmap, because it touches every query written by then.

**The eight safety rules, from day one.** They cost almost nothing to build and they are the entire reason an operator trusts software near their customers. The first unsupported promise to a real customer is the one that ends the pilot.

Everything on the deferred list can be added later at roughly today's cost. These two get more expensive every week they are postponed.

## Calendar risks

**Meta business verification — start in week 1.** Business verification and template approval run on Meta's schedule. This is the likeliest way to finish the code and have no number to run it on. Demo on a test number while it clears.

**Getting the operator's knowledge out of people's heads — before Gate 2.** Rates, deposits, driver requirements, delivery areas, and the exceptions nobody wrote down. The rollout plan allots a week; it usually takes longer, because the answer currently lives with whoever has worked there longest. The agent cannot answer anything that has not been captured.

**The prototype audit — unknown until done.** The specification notes the existing prototype's language, deployment and credentials have not been audited. If little is reusable, add a week or two to Gate 1. This is the estimate most likely to move, and it resolves in the first few days.

## The failure mode

Building all sixteen weeks before showing anyone. Four months of solo work with no operator committed is the most common way a project like this ends. Gate 1 exists specifically to put something in front of a real buyer in month one, while the cost of being wrong is four weeks rather than four months.
