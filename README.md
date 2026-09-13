# Vyra

A WhatsApp AI sales assistant for Dubai luxury and exotic car-rental operators.

It answers enquiries quickly, qualifies them, explains Operations-approved options, and hands a complete, qualified opportunity to a salesperson — while pricing exceptions, eligibility decisions, payment verification and final booking confirmation stay with people.

`Customer enquiry → AI qualification → verified options → human sales handoff → confirmed booking`

**Status: prototype.** A WhatsApp webhook exists with verified inbound challenge handling and working manual outbound tests. It has no durable memory, no handoff, no shared inbox and no inventory engine. Nothing in this repository should be read as describing deployed software unless it says so explicitly.

---

## How to read this repository

This is a documentation repository. It contains no application code — the prototype lives in a separate `team-hub` project.

**Start here, in this order:**

1. [docs/PROJECT-CONTEXT.md](docs/PROJECT-CONTEXT.md) — positioning and background
2. [docs/CURRENT-STATE.md](docs/CURRENT-STATE.md) — what actually exists today
3. [Whatsapp Agents/Sales Agent/chat sales agent.md](Whatsapp%20Agents/Sales%20Agent/chat%20sales%20agent.md) — the full product specification
4. [Whatsapp Agents/Sales Agent/sales agent mvp.md](Whatsapp%20Agents/Sales%20Agent/sales%20agent%20mvp.md) — the scoped first version

## Which document wins

**The specifications under `Whatsapp Agents/` are authoritative.** Where anything else disagrees with them — a brief, a dashboard page, a summary — the specification is right.

The two `WHATSAPP-AGENT-BRIEF.md` files are earlier context, and they are *not* duplicates of each other despite the shared filename: the root copy is the long-form brief, and `docs/WHATSAPP-AGENT-BRIEF.md` is a short condensed summary. They are kept as history, not as requirements.

## The two agents

Vyra is split in two, and the boundary between them is the core design decision.

| | **Sales Agent** | **Operations Agent** |
|---|---|---|
| Owns | Customer intent, qualification, recommendations from approved data, quotes as conversations, handoffs, follow-up | Fleet, availability, rate inputs, bookings, documents, payments, delivery, active rentals |
| Talks to | The customer, on WhatsApp | Sales, and internal systems |
| Cannot | Edit vehicle status, confirm a booking, verify payment, approve documents | Qualify a lead, negotiate, or replace the salesperson's conversation |

Everything crossing between them is a structured request and a time-stamped answer. An answer that does not carry the time it was checked cannot be given to a customer.

## Repository map

```
Whatsapp Agents/               AUTHORITATIVE specifications
  Sales Agent/
    chat sales agent.md          Full specification, including the technology blueprint
    sales agent mvp.md           Scoped MVP and acceptance checklist
    sales agent build plan.md    36 development steps in six phases
    chat sales agent marketing.md  Customer-facing positioning
  Operations Agent/
    operations agent.md          Full specification
    operations agent mvp.md      Scoped MVP and acceptance checklist

docs/
  PROJECT-CONTEXT.md           Positioning and background
  CURRENT-STATE.md             What is actually built
  WHATSAPP-AGENT-BRIEF.md      Condensed brief (history)
  Vyra-MARKET-RESEARCH.md      Market sizing and pricing research
  TECH-STACK.md                Stack analysis and recommendation
  BUILD-ROADMAP.md             Three commercial gates to a paying pilot
  GO-TO-MARKET.md              Design partners, outreach motion, pricing

dashboard/                     Visual presentation layer (HTML, published as Artifacts)
knowledge-hub/                 Hub structure notes
WHATSAPP-AGENT-BRIEF.md        Long-form brief (history)
```

## Reading the confidence markers

This project deliberately separates what is known from what is assumed, and the documents carry that distinction:

- **Market sizes, operator counts, pricing ranges and revenue examples are working estimates.** The market research says so explicitly and asks for validation through operator interviews and paid pilots.
- **The technology blueprint is a proposal**, not a description of deployed software.
- **The build estimates have not been measured** against real work.

Preserve these markers when summarising or reusing this material. Presenting an estimate as a fact is the specific failure mode these documents are written to avoid.

## For AI assistants and other tools

If you are an assistant working in this repository:

- Treat `Whatsapp Agents/` as ground truth and everything else as commentary.
- Do not convert estimates into claims. If a source says "directional" or "needs validation", carry that forward.
- The Sales Agent's safety rules are not stylistic preferences. The agent must never promise unverified availability, confirm a booking, approve a discount, verify a payment, approve documents, promise a refund, change operational records, or answer confidently from a missing or conflicting source.
- `dashboard/` is a presentation layer. Update the source document first, then reflect the change there.
