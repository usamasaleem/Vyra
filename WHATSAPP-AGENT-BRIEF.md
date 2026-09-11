# Vyra — WhatsApp AI Rental Sales Assistant

Detailed product and handoff brief · Updated 9 September 2026

## 1. Purpose of this document

This brief consolidates the product discussion into portable context for designers, developers, business collaborators and future AI chats. It separates user requirements, proposed workflows and verified implementation facts. It is not a claim that the proposed product is already operational.

Read this document before advancing the WhatsApp product. Read [PROJECT-CONTEXT.md](./PROJECT-CONTEXT.md) for broader positioning and historical research. Where older material describes an agency-first offer, the current direction is a product for rental operators: sales assistance, inventory management and insights.

Evidence basis: the current conversation, existing project context and inspection of the local webhook on 9 September 2026. External account settings and deployments were not rechecked while writing this brief. Provider policies, eligibility, prices and model capabilities must be verified when implementing them.

## 2. Product in one sentence

A reliable WhatsApp AI assistant that helps Dubai luxury and exotic car-rental businesses answer enquiries, collect rental details and move customers toward bookings, while keeping salespeople in control of commercial commitments and exceptions.

Working identity: Vyra. Final product naming and commercial packaging remain open.

The operator buys better enquiry handling and booking visibility. The renter experiences one useful, continuous WhatsApp conversation.

## 3. Business problem and intended outcomes

Customers ask about cars, dates, prices, deposits, insurance and delivery while comparing operators. Staff may simultaneously handle walk-ins, telephone calls, existing renters and operational coordination. Repetitive qualification and fragmented ownership can delay responses and follow-up.

The product should help the business:

- Respond to incoming enquiries promptly.
- Give accurate, consistent rental information.
- Collect essential details without repetitive questioning.
- Keep every enquiry, owner and next action visible.
- Give staff useful context before they take over.
- Measure progression from enquiry to booking.

Do not promise a particular conversion increase, guaranteed revenue or complete staff replacement. Those outcomes have not been established.

## 4. Users and operating assumptions

| User | Primary need | Intended experience |
| --- | --- | --- |
| Prospective renter | Find a suitable car and understand the terms | Message the business number, get relevant answers, proceed to a salesperson without repeating details |
| Sales representative | Handle worthwhile enquiries while managing interruptions | See attention queue, review summary, take ownership, reply and record next action |
| Sales manager | Ensure coverage and prevent neglected enquiries | See unassigned work, waiting times, workload and outcomes |
| Owner / authorized manager | Understand and maintain the fleet and business activity | Protected inventory and reporting tools, eventually accessible through WhatsApp |
| Operations colleague | Receive accurate confirmed rental details | A structured booking handoff; detailed operations tooling is a later scope decision |

Initial operating hypothesis: a small team handles several channels rather than employing one dedicated person per channel. Validate this with the pilot operator. Logged in does not mean available; staff need Available, Busy and Off shift states.

The prior 20–150 vehicle target is a prospecting hypothesis, not a fixed product requirement.

## 5. Scope and release boundaries

### Initial focus: customer enquiries and sales-team handoff

1. Receive and record incoming WhatsApp enquiries.
2. Answer questions from approved operator information.
3. Collect and retain rental details.
4. Check a trusted inventory source, or explicitly request human confirmation.
5. Present appropriate options and approved quote details.
6. Create a visible handoff with a responsible team or person.
7. Let a salesperson take over and pause AI replies.
8. Track enquiry stage, ownership and next action.

Human staff initially retain discount exceptions, eligibility exceptions, payment verification and final booking confirmation.

### Later modules

- Owner/manager inventory commands on WhatsApp.
- Inventory dashboard and richer date-based fleet availability.
- Insights into enquiry volumes, demand, handoffs and booking outcomes.
- Controlled follow-up after ownership, timing and stop conditions are reliable.
- Voice enquiry handling if missed calls justify it.
- More extensive document, payment, delivery and rental lifecycle integrations.

Voice is not an initial requirement. If introduced, it must update the same customer and enquiry records as WhatsApp.

## 6. Customer journey

### A. First enquiry

Customer: “Is the Ferrari Roma available this weekend?”

Assistant: “Hi, I’m Vyra’s AI rental assistant. Which dates would you like the Roma, and will you need delivery?”

The assistant addresses the actual enquiry and asks only what is missing. It should not deliver a long introduction or force a rigid questionnaire.

### B. Qualification and availability

Customer: “Friday to Sunday, delivered to my hotel in Dubai Marina.”

The system records the request and resolves exact dates and pickup/return times when needed. Ambiguous dates are clarified. It checks date-specific availability from the approved source. If the source is missing or unreliable, it states that availability needs confirmation.

Collect progressively:

- Preferred car or vehicle category.
- Rental start/end dates and times.
- Delivery or collection location.
- Budget, when useful for choosing options.
- Driver age, licence country and resident/tourist status when required by approved operator rules.
- Customer name and contact details only when needed and not already available.

Remember provided information and corrections. Avoid collecting identity documents at the opening of a casual enquiry.

### C. Options and pricing

Offer a small relevant selection, typically up to three cars, using approved records. Clearly state whether availability is verified or pending.

Before commitment, explain the rental amount, deposit, delivery charges, mileage allowance, insurance information and any other applicable approved charges. Do not treat a refundable deposit as rental revenue. Quote calculation should use explicit rules rather than model arithmetic alone.

If dates, duration or car change, invalidate the previous quote and availability result until rechecked.

### D. Human help

Escalate when the customer requests a person, asks for an unapproved discount or exception, presents unclear documents, has a complex request, or needs an answer the system cannot verify.

The assistant may acknowledge a handoff only after it has been successfully recorded. Do not claim a named salesperson was notified or promise a response time without evidence.

### E. Sales discussion and confirmation

The salesperson enters the same customer chat with context. AI replies pause. Staff resolve outstanding questions, verify eligibility and payment through approved processes, and confirm the booking through the system of record.

A customer saying “yes,” receiving a quote or sending a payment screenshot does not itself create a confirmed booking.

### F. Waiting, returning and closing

When a customer goes quiet, retain ownership and the next action. When they return later, preserve context but recheck time-sensitive information. Follow-up must stop after decline, opt-out, closure or booking where further sales follow-up is inappropriate.

Record Booked or Closed without booking with an outcome reason. Booking reminders and rental support are separate from sales follow-up.

## 7. Sales-team journey

The proposed primary workspace is a mobile-friendly shared inbox. This is a design recommendation, not a finalized build-versus-buy decision.

### Start of shift

The salesperson selects availability and sees:

- Needs attention: exceptions and customers waiting for people.
- My enquiries: conversations they own.
- AI assisting: qualification in progress.
- Waiting for customer: quotes and questions awaiting response.
- Booked / Closed: completed outcomes.

Each row should expose the customer, requested car, dates, last message, owner, waiting time and urgency where relevant.

### Review a handoff

Open the chat alongside a structured summary containing known details, missing details, latest quote, reason for escalation and next action. Staff can inspect the original messages behind the summary.

Example: “Roma · Friday–Sunday · Dubai Marina delivery · deposit exception requested · driver eligibility not yet confirmed.”

### Take over

Taking over must assign ownership, pause automated replies and prevent unsent AI replies from being delivered. Concurrent attempts by two staff must resolve to one owner. Other staff can see who is handling the conversation.

The salesperson replies from the business number through the supported workspace. Internal notes must be visually distinct from messages sent to the customer.

### Progress and handover

Staff record quote changes, phone-call agreements, pending approvals and follow-up tasks. Shift handover preserves context and assigns responsibility to the next person.

Silence, inactivity or a shift ending must not automatically return a chat to AI. The initial proposed control is an explicit “Return to AI” action.

### Manager oversight

Show unassigned handoffs, aging enquiries, busy staff, failed sends and overdue next actions. Notification thresholds and escalation recipients must be configured with the operator; no response-time target is yet agreed.

## 8. Separate the states

Avoid using one status field for unrelated concepts.

| Dimension | Proposed states |
| --- | --- |
| Active handler | AI, human, paused/pending assignment |
| Handoff | None, requested, assigned, resolved |
| Sales stage | New, qualifying, qualified, quote sent, awaiting requirements, booked, closed |
| Next action | Staff response, customer response, approval, verification, scheduled follow-up, none |
| Staff availability | Available, busy, off shift |
| Delivery state of a message | Pending, accepted by provider, delivered, read where available, failed, outcome unknown |

The inbox views are projections of these states, not necessarily separate database fields. Provider acceptance is not proof the customer received a message.

Quotes, timed holds and confirmed bookings require separate records and explicit rules. Do not introduce automatic holds until expiry, conflicts and operator authority are defined.

## 9. Owner and manager mode

The user wants owners to message the same business number from their personal WhatsApp to view inventory and eventually manage it.

Examples: “Show available cars this weekend,” “Block the Porsche tomorrow,” or “Show today’s bookings.”

This is planned, not implemented. The backend must enforce operator membership and permissions before any privileged data or action is exposed. A customer claiming to be the owner must never gain access through conversation alone.

Proposed mutation flow: identify the intended vehicle/date/change, show a clear confirmation, execute only within the user’s permissions, and record an audit event. Stronger verification may be needed for sensitive actions; phone identification alone is not a blanket authorization design.

## 10. WhatsApp Business app versus shared inbox

The integration developed so far uses Cloud API. A Business Account label in WhatsApp does not establish that mobile-app login or Coexistence is enabled.

Coexistence is under investigation. Do not assume this number is eligible, that history will sync completely, or that manual app replies will reliably stop AI. Validate the supported onboarding path and message events before choosing this workflow or changing registration.

The preferred first design is one primary staff workspace for replies, ownership and tracking. If the operator requires the Business app, reconcile this preference before implementation; do not force duplicate manual updates in two systems.

## 11. Reliability and experience principles

The user’s highest priority is a reliable assisting agent. “Apple-like” means a small, coherent, polished experience with predictable behaviour and clear feedback; it is not a claim about Apple’s engineering practices.

- Approved data determines facts; prompts alone are not an enforcement mechanism.
- The system says when it cannot verify something.
- Customer context survives sessions and worker restarts.
- Exactly one handler controls outbound replies at a time.
- Every handoff has accountable routing and a next action.
- Commercial commitments require explicit authority and verified records.
- Failed or uncertain operations are visible and recoverable.
- No claimed success without evidence of the relevant action.
- Reliability targets must be measurable; zero failures cannot be promised.

## 12. Essential edge cases

| Event | Required behaviour |
| --- | --- |
| Two customers want the same vehicle/dates | Revalidate before commitment and prevent conflicting confirmed reservations |
| Staff takes over during AI generation | Suppress the pending AI send and transfer ownership atomically |
| Several short messages arrive together | Preserve all messages and respond coherently without a reply storm |
| Duplicate webhook delivery | Deduplicate processing and side effects using durable identifiers |
| Out-of-order or batched events | Process every relevant event safely and preserve meaningful ordering |
| Dates/car change | Update the enquiry and mark prior quote/checks stale |
| Inventory service fails | State that confirmation is needed and create a visible staff task |
| Customer requests a person after hours | Record the request, disclose known coverage and route it without invented timing |
| Unsupported voice note or attachment | Explain supported options; preserve the event for staff |
| Customer returns after days | Resume context and recheck availability and pricing |
| Payment screenshot arrives | Record it for verification; do not confirm payment from the image alone |
| Customer reports an accident or breakdown | Stop sales flow and prioritize approved urgent-support routing |
| Cancellation/refund complaint | Route to authorized staff without an unsupported refund promise |
| Send times out after possible provider acceptance | Record an uncertain outcome; reconcile before blindly resending |
| Prompt asks for internal information or owner access | Enforce access boundaries outside the language model |
| Customer declines or opts out | Stop applicable follow-up and record the preference |

## 13. Proposed data and integration foundation

These are requirements for design, not a selected database schema or vendor commitment.

- Operator: business configuration, timezone, approved policies and escalation rules.
- Staff user: role, operator membership, availability and assignment permissions.
- Customer: channel identity, minimal contact information and communication preferences.
- Conversation/message: external IDs, timestamps, content, direction, handler and delivery status.
- Enquiry: rental requirements, stage, source, owner and next action.
- Vehicle/availability: approved details, rates, date blocks, source and freshness.
- Quote: inputs, line items, version, validity and approval evidence.
- Handoff/task: reason, assignment, age, escalation and resolution.
- Booking reference: authoritative status and linkage to the rental system.
- Audit event: actor, action, time, result and relevant before/after values.

Suggested processing sequence: authenticate incoming event → durably record it → acknowledge receipt → process idempotently → load context and permitted data → generate or route → recheck handler and business rules → send → track result.

Queue, persistence, retry and provider reconciliation choices remain to be designed. Multiple operators must have explicit data isolation before a multi-business rollout. Secrets belong in protected runtime configuration, never in documents or frontend code.

## 14. Current implementation and evidence

### Historical setup evidence from this conversation

- The Meta app reached a published state, shown by the Unpublish control.
- A registered number was selected and manual outbound test messages worked.
- Webhook verification and a dashboard messages-field test succeeded.
- The customer webhook prototype was deployed as Sites version 8 on 7 September 2026.
- At the last environment inspection in this conversation, only the webhook verification token was configured.

These are historical observations, not a fresh live verification. A successful Meta test does not establish the complete customer-to-AI-to-staff journey. Older notes about initial Meta registration blockers were superseded by later screenshots in this conversation, but production readiness remains unproven.

### Local source inspected on 9 September 2026

Implementation: [team-hub/app/api/webhook/route.ts](./team-hub/app/api/webhook/route.ts).

- GET verifies the Meta subscription challenge against an environment token.
- POST parses the payload, extracts a first text message and attempts a reply.
- Optional inventory JSON is loaded from an environment variable.
- An OpenAI Responses request is attempted when an API key exists.
- A generic qualification reply is used when the AI key is absent.
- WhatsApp sending depends on configured access token and phone-number ID.
- Existing pages remain a project/messaging hub and privacy page, not a shared sales inbox.

### Known gaps and risks visible in the source

- No incoming POST signature verification.
- No durable event storage, duplicate protection, conversation memory or ownership model.
- Only a first qualifying message is returned from extraction; batching is not comprehensively handled.
- AI/send work occurs inside the webhook request; there is no durable background processing.
- Failures are logged and acknowledged without a durable recovery workflow.
- Missing send credentials cause a skip, yet the caller can still log “reply sent.”
- Response text extraction and model/request compatibility need integration validation; build success does not prove either works.
- The available boolean in prototype inventory cannot establish availability for a requested date range.
- The prompt can suggest a handoff, but there is no actual handoff system.
- No staff interface, authenticated owner tools, booking verification or operator isolation.

The deployed code is a prototype, not a production-ready customer assistant. Earlier claims that it was complete were too broad. Do not activate it for unattended customer service merely by supplying credentials.

Existing technical notes: [team-hub/WHATSAPP-WEBHOOK.md](./team-hub/WHATSAPP-WEBHOOK.md). That file still describes the earlier acknowledgement-only scaffold and is stale relative to the inspected route.

Runtime variable names currently referenced: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `RENTAL_INVENTORY_JSON`. Values are intentionally omitted. Final AI model choice is not settled by the prototype default.

## 15. Proposed acceptance criteria

All items below are unverified release requirements, not passed tests.

- [ ] A valid customer event is durably recorded; invalid signatures are rejected before side effects.
- [ ] Batched and duplicate events do not lose messages or produce duplicate actions.
- [ ] Context survives restart and includes customer corrections.
- [ ] Unknown pricing/availability produces an honest fallback, not a fabricated fact.
- [ ] Date changes invalidate earlier checks and quotes.
- [ ] Quote totals are reproducible from approved rules and inputs.
- [ ] Concurrent takeovers resolve to one owner; a takeover suppresses pending AI output.
- [ ] Human-owned chats remain paused until explicitly returned to AI.
- [ ] Handoffs appear in a visible queue with routing, waiting time and next action.
- [ ] An unavailable salesperson does not leave a handoff silently stranded.
- [ ] Provider failures and uncertain sends are visible and recoverable without blind duplication.
- [ ] Payment screenshots and customer intent cannot automatically confirm bookings.
- [ ] Customers cannot retrieve staff notes or invoke privileged management actions.
- [ ] A full customer enquiry reaches a salesperson with accurate context on phone and desktop.
- [ ] Follow-up respects configured permissions, current platform rules and stop conditions.
- [ ] The operator has a tested pause/recovery procedure for automation failures.

Use representative test conversations, injected service failures and concurrency tests. Build validation alone is insufficient. Agree response-time and escalation targets with the pilot operator before measuring them as service commitments.

## 16. Metrics and economic exploration

Measure first useful response time, handoff waiting time, missed/unassigned enquiries, answer accuracy, correction rate, send failures, staff time per enquiry, qualification completion, quotes and confirmed bookings. Separate automated acknowledgements from useful answers.

Track customer complaints and incorrect commitments alongside conversion. Define a unique enquiry so repeated messages do not inflate lead counts.

The discussion used AED 5,000 monthly base salary per salesperson as an illustrative assumption, not a verified average or an AI price. Three staff at that assumption equal AED 15,000 monthly base payroll; commissions and other employment costs are excluded. Time saved is additional capacity unless staffing costs actually change.

Commercial pricing, willingness to pay, conversion uplift and financial return remain unvalidated. Compare incremental contribution after direct costs, not just gross rental revenue, when evaluating value.

## 17. Decisions, recommendations and unresolved choices

### User requirements

- Build for Dubai luxury/exotic rental businesses.
- Prioritize a reliable AI assisting experience.
- Explore both customer and sales-team journeys.
- Include customer sales and protected owner/manager use cases in the overall product.
- Preserve context in Markdown for transfer between chats and models.

### Recommended initial direction, awaiting detailed validation

- Start with WhatsApp text enquiries and human handoff.
- Use a shared inbox as the main staff workspace.
- Keep commercial exceptions and final confirmation human-controlled.
- Make AI resumption explicit.
- Defer voice and broader owner mutations until the core workflow is dependable.

### Open choices

1. Which operator and real fleet data will be used for the pilot?
2. Do staff require the Business app, and is supported Coexistence available?
3. Build a shared inbox or integrate an existing one?
4. Which system is authoritative for availability, rates and confirmed bookings?
5. Who receives handoffs, on which shifts, with what escalation thresholds?
6. Which policies, eligibility rules, discounts and languages are approved?
7. Where are documents/payment handled, and what evidence confirms success?
8. What retention, access, deletion and audit requirements apply?
9. Which AI model passes the actual rental-conversation evaluation set?
10. What measurable criteria make a pilot safe to launch and successful to retain?

## 18. Next work and handoff instructions

Immediate next design task: specify one complete journey from incoming enquiry to staff takeover, including unavailable staff, stale inventory, duplicate events and AI interruption. Resolve the staff workspace and approved data source before committing to a broad implementation.

Then implement durable ingestion/context, permitted data access, ownership and handoff; verify with simulated traffic before a supervised pilot. Add later modules only after this path meets acceptance criteria.

For a new chat/model:

> Read WHATSAPP-AGENT-BRIEF.md and PROJECT-CONTEXT.md. Treat the brief’s UX as proposed requirements and its implementation section as a dated source inspection. Verify relevant current files before changing code. Do not assume the prototype is production-ready or that Coexistence, inventory, a staff inbox, or owner controls exist. Identify the exact next task and preserve approved-data, ownership and handoff requirements.

Maintain this brief after meaningful work or confirmed decisions, not after every message. Record verification dates and evidence; keep proposals separate from completed work. Present document changes for review before committing. A documentation request does not authorize deployment or external account changes.

Suggested future companion files are CURRENT-STATE.md, DECISIONS.md and ACCEPTANCE-CRITERIA.md. They were discussed but were not present in the file inventory for this brief; do not assume they already exist. This document carries those sections until they are deliberately split out.
