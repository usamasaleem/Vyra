# Vyra Sales Agent MVP

## MVP goal

Turn an incoming WhatsApp message into a qualified sales opportunity that a salesperson can take over without asking the customer to repeat information.

## 1. WhatsApp messaging

- Receive customer text messages through the operator's WhatsApp number.
- Send text replies.
- Record sent, delivered, failed, and received message states when available.
- Prevent duplicate replies when the same message event is received more than once.
- Support approved follow-up templates when required by WhatsApp.
- Stop follow-ups when a customer opts out.

### Non-text messages

Customers send voice notes, photos, and documents without warning. The MVP does not interpret them, but it must never drop them silently.

- Store the message and record its type.
- Acknowledge receipt and say that the message cannot be read automatically.
- Route the conversation to a human when a non-text message carries the customer's request.
- Never treat an unreadable message as though the customer said nothing.

### Sending eligibility

WhatsApp allows ordinary replies within 24 hours of the last customer message and requires an approved template outside that window.

- Check eligibility at the moment of sending, not when the reply is scheduled. A delayed job can cross the window boundary.
- Apply the same check to messages written by salespeople.
- Create an internal task when a template is rejected or paused, rather than retrying the send.

### Out of hours

- Reply with the operator's real service expectation rather than an invented callback time.
- Capture the enquiry and queue it for the next working period.
- Raise priority when the customer states same-day urgency.

### Language

The MVP supports English. Another language is enabled only after its answers have been reviewed against the same acceptance checks.

## 2. Customer and conversation records

- Create or match a customer using their WhatsApp number.
- Store every incoming and outgoing message.
- Preserve conversation history across sessions and system restarts.
- Reopen the existing conversation when a customer replies later.
- Keep separate conversations and data for each rental operator.
- Record whether the AI or a salesperson currently owns the next reply.

## 3. Rental enquiry qualification

Collect and maintain:

- Requested vehicle or vehicle category.
- Start date and time.
- End date and time or rental duration.
- Delivery or collection preference.
- Delivery or collection location.
- Customer residency or visitor status when relevant.
- Driver age when relevant.
- Budget when useful.
- Special requirements.
- Missing information and unresolved questions.

The agent should:

- Ask one or two questions at a time.
- Use information the customer already provided.
- Confirm ambiguous dates such as “tomorrow” or “this weekend.”
- Handle customer corrections without losing the earlier context.
- Save an incomplete enquiry if the customer stops responding.
- Resolve relative dates against the operator's timezone, using the time the message was sent, and confirm the calendar date before it is used.
- Keep the customer's original wording alongside the normalised value.

### When an enquiry counts as qualified

An enquiry is qualified when all of the following are present and confirmed:

- Vehicle or vehicle category.
- Start date and time.
- End date and time, or duration.
- Delivery or collection preference, with a location when delivery is requested.
- A contactable customer. The WhatsApp number is sufficient.

Residency, driver age, budget, and special requirements are captured when the customer offers them or when operator policy requires them for the requested vehicle. Their absence does not block qualification; it is carried forward as an open question in the handoff.

This definition is what the qualification completion rate in section 15 measures.

## 4. Intent recognition

Recognize the essential MVP intents:

- New rental enquiry.
- Vehicle or category request.
- Price or quote question.
- Availability question.
- Deposit, insurance, kilometre, delivery, or requirement question.
- Discount or exception request.
- Request to speak with a person.
- Complaint, dispute, payment, accident, or urgent support issue.
- Unclear or unsupported request.

## 5. Approved sales knowledge

- Answer common questions using operator-approved content.
- Cover the rental process, deposits, included kilometres, insurance, delivery areas, driver requirements, documents, business hours, and contact options.
- Show uncertainty when approved information is missing or outdated.
- Record which approved information supported an important answer.
- Allow an authorised staff member to update and publish sales knowledge.

## 6. Operations information requests

The Sales Agent does not manage inventory or operational records.

For the MVP it should:

- Capture the customer's requested vehicle and dates.
- Send a structured request to the Operations request queue.
- Receive an approved status: available, unavailable, pending confirmation, or unknown.
- Communicate that status accurately to the customer.
- Request approved pricing or quote details.
- Never change vehicle status, create a booking, verify payment, or approve documents.

For the MVP an authorised person answers these requests in the Operations console. There is no automated availability lookup, and none should be assumed. See the [Operations Agent MVP](../Operations%20Agent/operations%20agent%20mvp.md).

Rules for using an answer:

- An answer carries its source and the time it was checked. An answer without a time checked cannot be given to a customer.
- An expired answer is rechecked before it is reused.
- An unknown answer is communicated as unknown, with a next action. It is never softened into a maybe.

## 7. Lead state

Lead state is four independent fields. They must not be collapsed into a single status list, because they change for different reasons and can hold any combination.

**Sales stage** — new, qualifying, qualified, options sent, quote sent, won, lost.

**Reply ownership** — AI or salesperson. Exactly one at a time.

**Waiting reason** — none, waiting for customer, waiting for Operations, waiting for internal approval.

**Booking status** — none, pending, confirmed, cancelled.

A single lead can be qualified, owned by a salesperson, waiting for Operations, and have no booking yet. That combination is ordinary, and a single flat status list cannot express it.

These four fields mirror the state separation in the [Operations Agent MVP](../Operations%20Agent/operations%20agent%20mvp.md) section 6.

Each lead should also have:

- Current stage.
- Assigned salesperson or queue.
- Priority.
- Last customer message.
- Next action.
- Follow-up due time.
- Lost reason when applicable.

## 8. Human handoff

Trigger a handoff when:

- The customer asks for a person.
- The enquiry has enough information for a salesperson.
- A discount or exception is requested.
- Availability, pricing, or eligibility cannot be verified.
- The customer reports a payment, refund, deposit, accident, complaint, dispute, or safety issue.
- The agent is uncertain or cannot support the request.

The handoff should include:

- Customer name and WhatsApp number.
- Conversation history.
- Vehicle or category.
- Dates and duration.
- Location.
- Budget and special requirements.
- Information already provided.
- Questions still unresolved.
- Reason for handoff.
- Priority.
- Recommended next action.

## 9. Salesperson inbox

Provide a basic shared inbox where staff can:

- View new and active conversations.
- Read the full message history.
- See the structured enquiry summary.
- Filter by stage, owner, and priority.
- Assign or reassign a conversation.
- Accept a handoff.
- Send a manual WhatsApp reply.
- Add an internal note.
- Set the next action and follow-up date.
- Mark a lead won or lost.
- Pause or resume AI replies.

## 10. Human takeover rules

- Only one handler sends customer replies at a time.
- Taking over immediately assigns the conversation to the salesperson.
- Pending AI drafts are cancelled when a human takes over.
- The AI does not send customer replies while human ownership is active.
- Returning control to the AI requires an explicit staff action.
- Every ownership change is recorded.

## 11. Follow-up management

- Create a follow-up task for qualified or unanswered enquiries.
- Show overdue follow-ups in the salesperson inbox.
- Send only approved automated follow-ups.
- Stop automation after human takeover, opt-out, complaint, win, or loss.
- Reopen a lead when the customer replies.

## 12. Essential safety rules

The Sales Agent must never independently:

- Promise unverified vehicle availability.
- Confirm a booking.
- Approve a discount or exception.
- Verify a payment or deposit.
- Approve customer documents.
- Promise a refund.
- Change inventory, delivery, maintenance, or booking records.
- Provide a confident answer when the source is missing or conflicting.

Urgent, sensitive, or disputed situations must be passed to a human.

## 13. Basic administration

An authorised user can configure:

- Rental operator profile.
- Business hours and timezone.
- Sales users and roles.
- Handoff queue and fallback owner.
- Response expectations.
- Approved sales knowledge.
- Enabled languages.
- AI on/off switch.
- Default reply ownership for a new conversation.
- Data retention period for conversations, customer records, and uploaded files.
- Handling of a customer request to delete their data.

## 14. Reliability and visibility

- Save incoming messages before processing them.
- Retry temporary message-processing failures.
- Show failed or stuck messages to staff.
- Log important actions and ownership changes.
- Keep an audit record for quotes, handoffs, and customer-facing commitments.
- Provide a system-wide switch that stops AI replies while preserving incoming messages and manual staff access.

## 15. MVP reporting

Track only the essential sales measures:

- Number of incoming enquiries.
- First-response time.
- Qualification completion rate.
- Qualified leads.
- Human handoffs.
- Time to salesperson response.
- Quote requests.
- Won and lost leads.
- Lost reasons.
- Incorrect-answer and complaint count.

Fleet, availability, vehicle utilisation, delivery, maintenance, payment, deposit, document, and operational reports belong to the Operations Agent.

## 16. Pilot rollout

Capability is added one step at a time. Each step must hold before the next begins.

### Step 1: Shadow

The AI drafts every reply and a salesperson reviews and sends it. No customer receives a message the AI sent. Measure draft quality against the acceptance checklist before moving on.

### Step 2: Limited automation

The AI sends clarifying questions and approved FAQ answers by itself. Everything else is drafted for a human.

### Step 3: Supervised live

The AI handles qualification end to end. Staff watch the inbox and can stop AI replies instantly.

A capability that produces an unsupported claim returns to the previous step rather than being patched in place.

## 17. MVP acceptance checklist

The MVP is ready for a supervised pilot when:

- [ ] A real WhatsApp customer can send and receive messages.
- [ ] Duplicate events do not create duplicate replies.
- [ ] Conversation history survives a restart.
- [ ] The agent captures the required rental details.
- [ ] Ambiguous dates and conflicting information are clarified.
- [ ] Approved FAQs are answered without inventing facts.
- [ ] A voice note or photo is acknowledged and routed, never silently dropped.
- [ ] Relative dates resolve against the operator's timezone and are confirmed with the customer.
- [ ] An Operations answer with no time checked cannot reach a customer.
- [ ] A follow-up crossing the 24-hour window uses an approved template or does not send.
- [ ] Unknown availability or pricing creates an Operations request or human handoff.
- [ ] A customer can request a person at any time.
- [ ] A salesperson receives a complete handoff summary.
- [ ] Human takeover prevents competing AI replies.
- [ ] Staff can reply, assign, follow up, and mark the outcome.
- [ ] Opt-outs and sensitive cases stop automated follow-up.
- [ ] Failed processing is visible and recoverable.
- [ ] Sales data from one rental operator cannot be accessed by another.
- [ ] The team has tested the main journeys and edge cases before using real customer traffic.
- [ ] The AI ran in shadow mode and its drafts were reviewed before it sent anything to a customer.

## MVP boundary

The MVP ends when a qualified enquiry reaches the correct salesperson with complete context and the salesperson can continue the WhatsApp conversation.

Inventory control, fleet management, booking operations, payment verification, document approval, delivery execution, maintenance, active-rental support, and operational reporting are owned by the [Operations Agent](../Operations%20Agent/operations%20agent.md).
