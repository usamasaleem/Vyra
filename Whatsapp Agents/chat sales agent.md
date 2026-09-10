# Vyra Chat Sales Agent

## 1. Product definition

The Vyra Chat Sales Agent is a WhatsApp-based AI sales assistant for Dubai luxury and exotic car-rental operators. It handles the first part of the customer journey: understanding an enquiry, collecting the facts needed to evaluate it, answering verified questions, presenting suitable options, and creating a controlled handoff to a salesperson.

The agent is a sales coordinator, not the final commercial authority. It may explain approved prices, deposits, requirements, delivery rules, and vehicle availability when those facts come from trusted sources. It must not invent facts, approve exceptions, verify payments, or confirm a booking unless the configured business workflow explicitly authorizes that action.

The intended journey is:

`Customer enquiry → AI qualification → verified options/quote → human sales handoff → confirmed booking`

This reflects Vyra's product context and WhatsApp brief:

- [Project context](https://github.com/usamasaleem/Vyra/blob/main/docs/PROJECT-CONTEXT.md)
- [WhatsApp agent brief](https://github.com/usamasaleem/Vyra/blob/main/docs/WHATSAPP-AGENT-BRIEF.md)
- [Current state](https://github.com/usamasaleem/Vyra/blob/main/docs/CURRENT-STATE.md)

## 2. Outcomes

### Customer outcomes

- Receive a fast first response on WhatsApp.
- Explain what they need in natural language instead of completing a long form.
- See relevant vehicles and transparent, verified terms.
- Know which details are still missing.
- Understand when a human must review or confirm something.
- Avoid repeating information after handoff.
- Receive clear next steps and realistic response expectations.

### Operator outcomes

- Reduce repetitive questions handled manually.
- Capture more complete enquiries.
- Respond consistently across shifts and salespeople.
- Prevent unsupported promises about availability, price, deposits, or delivery.
- Route high-intent or sensitive conversations to the right person.
- Preserve customer context and ownership.
- Measure enquiry volume, response speed, conversion, and lost opportunities.

### Business outcomes

- Increase qualified enquiries reaching salespeople.
- Improve speed-to-lead without surrendering commercial control.
- Create an auditable record of what was asked, answered, quoted, and approved.
- Build a reliable foundation for inventory, booking, and sales analytics integrations.

## 3. Users and actors

| Actor | Needs | Authority |
|---|---|---|
| Customer / renter | Vehicle, date, price, requirements, delivery, and booking guidance | Can provide or correct their own details |
| AI sales agent | Qualify, answer, recommend, summarize, and route | Only uses approved data and configured actions |
| Salesperson | Continue conversation, negotiate within policy, and close booking | Can approve commercial actions assigned to their role |
| Sales manager | Monitor queue, reassign ownership, approve exceptions, review performance | Can override assignments and policies |
| Operations / fleet staff | Maintain vehicles, status, delivery, and rental conditions | Authoritative source for operational facts |
| System administrator | Configure businesses, users, policies, prompts, integrations, and retention | Full configuration authority |
| External systems | WhatsApp, CRM, inventory, calendar, payments, identity/document tools | Provide machine-readable events or records |

## 4. Core principles

1. **Approved data determines facts.** The agent should answer from the operator's current knowledge and inventory sources.
2. **Verification before commitment.** Availability, price, deposit, delivery timing, and eligibility must be checked at the appropriate point.
3. **Human control over consequential decisions.** Discounts, exceptions, payment verification, and final booking confirmation remain human-controlled in the initial product.
4. **Honest uncertainty.** If the agent cannot verify an answer, it says so and creates a next action.
5. **One conversation, one owner.** The system must make it clear whether the AI or a salesperson is responsible for the next reply.
6. **Context survives handoff.** The salesperson receives a concise, structured summary and the original conversation.
7. **Minimum necessary data.** Collect only what is needed for qualification, fulfillment, compliance, or support.
8. **Every important action is traceable.** Record source, timestamp, actor, decision, and status for material claims and state changes.

## 5. Feature map

### A. WhatsApp conversation layer

- Receive inbound WhatsApp text messages and webhook events.
- Send replies, option lists, structured questions, confirmations, and human-handoff notices.
- Support free-form language, common spelling errors, and incomplete answers.
- Detect language and respond in the configured language; initial launch can prioritize English with Arabic support planned.
- Recognize returning customers and resume an open enquiry when identity can be matched safely.
- Handle out-of-hours messages with an honest service-hours response and a queued follow-up.
- Protect against duplicate webhook events and repeated outbound messages.
- Track delivery, failure, read, and response events where available.
- Use approved WhatsApp templates for business-initiated follow-ups, subject to the channel's current rules and account configuration.

### B. Intent and qualification

The agent should identify the customer's primary intent:

- Rent a specific vehicle.
- Find a vehicle by category, make, budget, or experience.
- Compare several options.
- Ask for a price or quote.
- Ask about availability.
- Ask about deposit, insurance, kilometres, fuel, Salik, fines, or damage.
- Ask about delivery or collection.
- Ask about driver and document requirements.
- Modify, extend, or cancel an existing rental.
- Report an issue or request support.
- Speak to a human.
- Send a complaint or dispute.
- Ask an unrelated or unsafe question.

For a new rental enquiry, capture:

- Desired vehicle or category.
- Start date/time and end date/time.
- Rental duration.
- Delivery or collection location.
- Customer status: UAE resident, visitor, or unknown.
- Driver age and licence/document status when relevant.
- Number of drivers.
- Budget or price sensitivity, if volunteered or useful.
- Intended use when policy requires it.
- Contact identity and preferred follow-up channel.
- Special requirements such as child seat, airport delivery, chauffeur, event use, or cross-emirate travel.

The agent should ask one or two high-value questions at a time, acknowledge already supplied information, and avoid making the customer repeat themselves.

### C. Vehicle discovery and recommendation

The recommendation layer can:

- Search trusted inventory by dates, vehicle, category, price band, seats, transmission, location, and delivery capability.
- Explain why an option matches the request.
- Present a small set of suitable options rather than an unfiltered catalogue.
- Offer alternatives when the requested vehicle is unavailable.
- Distinguish between “available now,” “needs operator confirmation,” “unavailable,” and “unknown.”
- Show the last verified time for availability when useful.
- Explain included kilometres, extra-kilometre charges, deposit, insurance, delivery, fuel, Salik, and fines from the vehicle or operator policy.
- Never imply that a displayed option is reserved.

### D. Pricing and quote support

Pricing must be explicit about what is known and what is conditional. The agent can:

- Calculate a draft total from approved rate cards and rental dates.
- Separate rental price from deposit, VAT, delivery, extras, and potential post-rental charges.
- Show daily, weekly, monthly, or event packages when configured.
- Explain included kilometres and extra-kilometre rates.
- State whether the quote is an estimate, a pending quote, or an approved quote.
- Record quote version, source, timestamp, currency, and expiry.
- Ask a salesperson to approve discounts or non-standard terms.
- Send a quote summary for human approval before it becomes a commercial commitment.

The agent must not conceal fees, change a price because the customer is uncertain, or claim that a payment or deposit has been received without a trusted payment event.

### E. Requirements and eligibility guidance

The agent can explain operator-configured requirements such as age, driving licence, passport, visa or entry documentation, Emirates ID, international driving permit, authorized-driver rules, and payment instrument requirements.

Requirements may vary by customer nationality, residency, vehicle category, age, rental duration, and operator policy. The agent should ask for the minimum information needed and escalate uncertain cases rather than making a legal determination.

For example, a high-performance or exotic vehicle may have a higher minimum age or stricter deposit policy than a standard luxury vehicle. The salesperson or operator system must make the final eligibility decision.

### F. Delivery, collection, and rental logistics

Support questions about:

- Delivery to hotels, residences, offices, airports, and other permitted locations.
- Collection location and time windows.
- Delivery fees or free-delivery zones.
- Traffic, weather, road closure, or availability-related delays.
- Handover requirements and inspection.
- Fuel and mileage expectations.
- Cross-emirate delivery or travel.
- Extension requests and late returns.
- Roadside assistance and emergency escalation.

The agent should create a logistics task when a location, time, or service requirement needs operational confirmation.

### G. Human handoff and shared ownership

Handoff is a first-class product capability. A handoff should include:

- Customer identity and WhatsApp number.
- Conversation link and full transcript.
- Intent and qualification stage.
- Requested dates, vehicle, location, and budget.
- Facts already verified.
- Open questions and unresolved risks.
- Quote or options already shown.
- Customer sentiment and urgency.
- Recommended next action.
- Reason for handoff.
- Assigned salesperson, queue, priority, and SLA.

Typical handoff triggers:

- Customer explicitly asks for a person.
- Final availability or booking confirmation is required.
- Discount or exception is requested.
- Payment, deposit, refund, dispute, or identity verification is involved.
- The customer is angry, confused, vulnerable, or reports a safety issue.
- The agent cannot verify a material fact.
- The customer has a complex multi-vehicle, long-term, corporate, event, or cross-emirate request.
- The conversation enters an unsupported intent.

After handoff, the AI should pause or operate in a clearly configured assistive mode. It must not compete with the assigned salesperson. Ownership changes must be visible and auditable.

### H. Follow-up and pipeline management

The agent can create structured stages:

`New → Qualifying → Options sent → Quote requested → Quote sent → Awaiting customer → Human review → Booking pending → Confirmed → Rental active → Completed / Lost`

Follow-up features:

- Remind the salesperson about unanswered or ageing enquiries.
- Send approved follow-ups when the customer has consented and the channel rules allow it.
- Stop automated follow-up after opt-out, complaint, handoff, or booking completion.
- Record why an enquiry was lost: unavailable vehicle, price, eligibility, no response, timing, competitor, or unknown.
- Reopen an enquiry when the customer replies.

### I. Operator console and administration

The sales team needs:

- Shared inbox with filters by stage, owner, priority, SLA, and vehicle.
- Conversation search.
- Manual assignment and reassignment.
- AI pause/resume controls.
- Internal notes separate from customer-visible messages.
- Approved knowledge and policy management.
- Inventory and rate-card management or integration.
- User roles and permissions.
- Audit log.
- Reporting dashboard.
- Test/simulation mode before publishing changes.

## 6. End-to-end use cases

### Use case 1: New customer asks for a Lamborghini

1. Customer sends “I need a Lamborghini from Friday to Sunday.”
2. Agent confirms dates and asks for delivery/collection location.
3. Agent asks whether the customer has a specific model or budget.
4. Inventory service returns matching vehicles and status.
5. Agent presents two or three verified options with clear terms.
6. Customer selects one and asks for the total.
7. Agent prepares a draft quote or requests human approval.
8. Salesperson receives the summary and confirms availability.
9. Customer receives a human-approved quote and next steps.

### Use case 2: Requested vehicle is unavailable

The agent states that it cannot confirm the requested vehicle for the dates, offers verified alternatives, and asks whether the customer is flexible on model, dates, or budget. It creates a follow-up task if the operator should check partner inventory.

### Use case 3: Discount request

The agent acknowledges the request, collects the commercial context, and routes it to an authorized salesperson. It must not promise that the discount will be accepted.

### Use case 4: Tourist with document questions

The agent explains the operator's configured document checklist, marks eligibility as pending if any factor is uncertain, and routes the case to a salesperson or compliance workflow. It should not provide a definitive legal opinion.

### Use case 5: Same-day delivery

The agent collects vehicle, location, timing, and customer readiness. It checks current inventory and creates an urgent logistics or sales task. It says “pending confirmation” until an authorized person or system confirms delivery.

### Use case 6: Existing renter wants an extension

The agent identifies the rental, captures the requested extension, checks whether the vehicle remains available, and routes pricing and approval to the assigned salesperson or operations team.

### Use case 7: Payment or deposit dispute

The agent acknowledges the issue, avoids arguing or assigning blame, captures the rental and transaction reference, pauses sales automation, and escalates to a human with high priority.

### Use case 8: Customer asks for a human

The agent immediately explains that it will connect them, captures the reason if possible, assigns or queues the conversation, and tells the customer what to expect next.

### Use case 9: Customer stops responding

The system marks the enquiry as awaiting customer, schedules only approved follow-ups, and closes or archives it according to operator policy. A late reply must reopen the conversation with its prior context.

### Use case 10: Returning customer

When identity is matched safely, the agent can reference an open enquiry or prior preference, but it should confirm critical details rather than relying on stale memory.

## 7. Conversation state and data model

A conversation record should include:

- Conversation ID, business ID, WhatsApp number, and customer identity.
- Current stage, intent, priority, owner, and AI mode.
- Structured rental request.
- Vehicle/options shown and their source timestamps.
- Quote records and approval state.
- Required documents and eligibility state.
- Handoff reason, owner, SLA, and next action.
- Consent, opt-out, and communication preferences.
- Message IDs, delivery status, and webhook event IDs.
- Audit events and source references.
- Created, updated, last customer message, and last staff response timestamps.

Every extracted field should carry confidence or provenance where practical:

`value + source message + extracted time + confidence + verification state`

Suggested verification states:

- `unknown`
- `customer-stated`
- `system-verified`
- `human-confirmed`
- `expired`
- `conflicting`

## 8. Safety, trust, and operational controls

The initial product needs:

- Duplicate-event protection and idempotent message handling.
- Retry and recovery for failed outbound messages and background jobs.
- Rate limits and abuse protection.
- Prompt and tool boundaries so the model cannot call unauthorized actions.
- Redaction and access controls for identity documents and payment information.
- Tenant isolation between rental operators.
- Role-based permissions.
- Audit logs for quotes, assignments, policy changes, and human overrides.
- Clear opt-out and deletion handling.
- Retention rules for conversations and documents.
- Human escalation for complaints, threats, accidents, safety issues, payment disputes, and suspected fraud.

UAE personal-data handling should be designed with the Federal Decree Law No. 45 of 2021 in mind. The official UAE government summary highlights confidentiality, lawful processing, data-subject rights, and controls for cross-border transfer and sharing: [UAE data protection laws](https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws). This document is a product design reference, not legal advice; the operator should validate its notices, consent, retention, processor arrangements, and regional requirements.

Rental policies are operator-specific. Public Dubai rental terms commonly vary on deposits, included kilometres, delivery, documents, driver age, and post-rental charges. The agent therefore must treat each operator's published and internal policy as authoritative rather than generalizing from another rental company. Examples of market variation include [Luxury Cars of Dubai terms](https://luxurycarsofdubai.com/terms/), [NCK delivery and deposit information](https://www.nckcarrental.com/services/luxury-car-rental-service/), and [Lux Motors requirements](https://luxmotorsdxb.com/terms-and-conditions/).

## 9. Metrics

### Customer experience

- First-response time.
- Time to first useful answer.
- Qualification completion rate.
- Customer effort: messages or turns to a qualified enquiry.
- Handoff acceptance rate.
- Customer opt-out and complaint rate.

### Sales performance

- Qualified enquiries per day.
- Enquiry-to-quote rate.
- Quote-to-booking rate.
- Time from enquiry to human response.
- Time from quote to booking.
- Lost-enquiry reasons.
- Revenue or booking value influenced by the agent.
- Repeat-customer rate.

### Reliability and control

- Verified-answer rate.
- Unsupported-claim rate.
- Availability freshness and mismatch rate.
- Duplicate-message rate.
- Webhook processing success rate.
- Handoff SLA breaches.
- AI-to-human takeover accuracy.
- Percentage of conversations with complete audit trails.

## 10. Recommended delivery phases

### Phase 1: Reliable text qualification

- Inbound and outbound WhatsApp text.
- Intent detection.
- Structured rental requirements.
- Approved FAQ and policy answers.
- Basic conversation memory.
- Human request and manual handoff.
- Message deduplication, retries, logging, and operator isolation.

### Phase 2: Sales workspace

- Shared inbox.
- Assignment and ownership.
- Queue and SLA controls.
- Internal notes.
- Conversation search.
- Follow-up tasks.
- Basic funnel reporting.
- AI pause/resume.

### Phase 3: Trusted inventory and quote support

- Inventory integration.
- Availability freshness.
- Vehicle recommendations.
- Rate cards and draft quotes.
- Quote approval workflow.
- Delivery and logistics tasks.
- Alternative-vehicle suggestions.

### Phase 4: Booking and lifecycle integrations

- Booking record creation after human approval.
- Payment and deposit status from a trusted provider.
- Document collection and verification workflows.
- Rental extensions, returns, and support.
- Customer history and repeat-renter preferences.
- Operational notifications.

### Phase 5: Optimization

- Multilingual quality improvements.
- Lead scoring and prioritization.
- Sales coaching and conversation analytics.
- Experimentation on approved messaging.
- Partner inventory and marketplace integrations.
- Forecasting and operator-level insights.

## 11. Definition of done for the first production-worthy version

The first version should not be considered ready until it can:

- Receive and process duplicate or delayed WhatsApp events safely.
- Preserve conversation context across restarts and handoffs.
- Answer approved FAQs with source-backed content.
- State uncertainty when a fact is not verified.
- Capture a complete rental enquiry.
- Stop or escalate when a human decision is required.
- Assign one clear owner to every active conversation.
- Produce a useful handoff summary.
- Prevent unauthorized discounts, payment claims, and final booking confirmations.
- Record audit events for material decisions.
- Protect data across operators and roles.
- Recover from failed messages and background jobs.
- Demonstrate performance with simulated traffic and representative conversations.

## 12. Product boundary

The sales agent should be excellent at qualification, explanation, recommendation, and coordination before it attempts autonomous booking. The highest-value early capability is dependable context and handoff: every customer should reach a salesperson with the right facts, the right urgency, and no invented promises.

## Sources

1. [Vyra Project Context](https://github.com/usamasaleem/Vyra/blob/main/docs/PROJECT-CONTEXT.md).
2. [Vyra WhatsApp Agent Brief](https://github.com/usamasaleem/Vyra/blob/main/docs/WHATSAPP-AGENT-BRIEF.md).
3. [Vyra Current State](https://github.com/usamasaleem/Vyra/blob/main/docs/CURRENT-STATE.md).
4. [UAE Government — Data protection laws](https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws).
5. [Luxury Cars of Dubai — Terms](https://luxurycarsofdubai.com/terms/).
6. [NCK — Luxury car rental and delivery](https://www.nckcarrental.com/services/luxury-car-rental-service/).
7. [Lux Motors DXB — Terms and conditions](https://luxmotorsdxb.com/terms-and-conditions/).
