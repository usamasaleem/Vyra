# Vyra — Go To Market

Design partners, outreach, and how to price a first cheque

**Working notes, not validated strategy.** Pricing ranges quoted here come from [Vyra-MARKET-RESEARCH.md](Vyra-MARKET-RESEARCH.md), which marks them directional and asks for validation through paid pilots.

## 1. The design partner

A **design partner** is an early customer who builds the product with you rather than just buying it.

**The trade:** they give you access — their real enquiries, their staff's time, their actual rates and policies, an honest view of what they are losing. You give them influence over what gets built, early access, and a low founder price they keep. They are not a tester (a tester reports bugs) and not yet a customer (a customer buys a finished thing). They are closer to a co-author with a budget.

**For Vyra specifically:** one Dubai luxury or exotic car-rental operator who lets you sit with their sales team for a day, hands over the FAQs and rate cards that currently live in people's heads, shares their real enquiry volume, and commits to running the pilot on their own number.

The entire roadmap depends on finding one. Gate 2 *is* "one operator live" — without a design partner there is no Gate 2, only more building.

### What makes a good one

- High WhatsApp enquiry volume, and they feel the pain — they can name enquiries they lost last weekend.
- A decision-maker you can reach directly, not a committee.
- Willing to pay something, even a small amount. A free partner is not committed and will deprioritise you in their first busy week.
- Fairly typical operations, so what you build generalises.
- Small enough that one person can serve them properly.

### What to avoid

The biggest, most prestigious operator on the list. They move slowly, want custom everything, and their workflow is usually the least representative. Also avoid collecting five design partners — conflicting demands at this stage pull the product apart. One or two is right.

### Where to look

The market research estimates roughly 3,494 rental companies and 71,040 rental vehicles in Dubai, with 50–150 initial target accounts — while explicitly flagging the luxury and exotic slice as directional and requiring validation through operator interviews. Treat those figures as orientation, not a list.

In practice the fastest design partner is usually one introduction away rather than a cold prospect. A warm contact in that world is worth more to the timeline than any amount of Gate 1 building, because it turns four weeks of building toward a demo into four weeks of building toward a demo *for someone specific*.

## 2. Generating revenue at Gate 1

At Gate 1 nothing has touched a real customer, and selling a monthly fee for software that does not exist creates an obligation you may not be able to meet. Three alternatives:

### Run it as a service, by hand — strongest

One operator forwards their enquiries; you answer fast using the drafts, from the inbox Gate 1 already produces. They pay for the outcome — replies in minutes, nothing lost overnight — not for software.

You are the human in shadow mode. You learn their real questions, objections and rates while being paid to do it, which also removes the Gate 2 knowledge-extraction blocker.

### A paid discovery engagement

Map their enquiry volume, current response times, and what is being lost at night and on weekends. Valuable to them independent of the product, and it ends with a number that becomes your own sales asset. It also filters seriousness: an operator who will not pay for discovery will not pay for a pilot.

### A setup fee against a committed pilot

The design partner signs, pays onboarding now, and the subscription starts when they go live at Gate 2. Keep this cheque small and the scope explicit — if Gate 2 slips, you owe someone something.

### Two constraints

**Meta verification may not have cleared by week 4.** If it has not, you cannot run on their number, which limits the service option to a number you control, or to replying from their existing phone with the system behind you. Know this before promising a start date.

**Do not anchor on the research pricing yet.** The AED 1,000–2,000 Starter range is marked directional and unvalidated. Price a first cheque as what it actually is — a discovery or a service month — not as a discount off a subscription that has not been proven.

## 3. The demo-as-outreach motion

Observed in a WhatsApp-AI-agency video (Oliver Rasmussen, August 2026) reviewed for relevance. The video's build content is too simple for Vyra — a dental booking bot has fixed slots, no dated availability across ranges, no deposits, no eligibility rules, no delivery — and its production platform recommendation is an affiliate placement. The **sales motion**, however, is directly applicable.

**The loop:** scrape a prospect's website, generate a WhatsApp-lookalike demo pre-filled with *their* fleet, rates and FAQs, and send it as the cold outreach itself.

This reframes Gate 1. Instead of "a demo I can show if I get a meeting," the demo becomes "the thing that gets me the meeting." For a solo builder with no warm introductions, that is a meaningful difference — and a hosted demo page works while you sleep and can be forwarded to whoever actually decides.

The pieces largely exist already: a Netlify site, a working design system, and a WhatsApp-style message component in the dashboard.

**Two smaller borrowings:** a calendar invite plus a pre-call research question, to raise show-up rates; and pricing anchored on cost-per-lead divided by conversion against current spend.

**One caution:** a demo built from a company's scraped rates and branding is fine sent *to them*, but should not be hosted publicly or in any way that implies they are already a customer. Keep each one private or unlisted.

## 4. Pricing models to test

The market research proposes flat monthly bands — roughly AED 1,000–2,000 for small operators, AED 3,000–5,000 for growth operators, AED 8,000–15,000 for larger fleets — and marks all of them directional.

Worth testing against those: **per-booking or per-qualified-lead pricing.** For luxury rental, where a single booking is worth thousands of dirhams, *"X per booking we source you"* is an easier first yes than a monthly fee, and it places your incentive visibly on the operator's side. The market research's own cost-per-lead framing supports the arithmetic.

Validate through paid pilots. The research says so, and nothing here changes that.
