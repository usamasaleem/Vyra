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
- Ask the Operations Agent or a human operator for availability.
- Receive an approved status: available, unavailable, pending confirmation, or unknown.
- Communicate that status accurately to the customer.
- Request approved pricing or quote details.
- Never change vehicle status, create a booking, verify payment, or approve documents.

## 7. Sales lead stages

Use these stages:

- New.
- Qualifying.
- Qualified.
- Waiting for customer.
- Waiting for Operations.
- Human handoff.
- Quote pending.
- Booking pending.
- Won.
- Lost.

Each lead should have:

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

## 16. MVP acceptance checklist

The MVP is ready for a supervised pilot when:

- [ ] A real WhatsApp customer can send and receive messages.
- [ ] Duplicate events do not create duplicate replies.
- [ ] Conversation history survives a restart.
- [ ] The agent captures the required rental details.
- [ ] Ambiguous dates and conflicting information are clarified.
- [ ] Approved FAQs are answered without inventing facts.
- [ ] Unknown availability or pricing creates an Operations request or human handoff.
- [ ] A customer can request a person at any time.
- [ ] A salesperson receives a complete handoff summary.
- [ ] Human takeover prevents competing AI replies.
- [ ] Staff can reply, assign, follow up, and mark the outcome.
- [ ] Opt-outs and sensitive cases stop automated follow-up.
- [ ] Failed processing is visible and recoverable.
- [ ] Sales data from one rental operator cannot be accessed by another.
- [ ] The team has tested the main journeys and edge cases before using real customer traffic.

## MVP boundary

The MVP ends when a qualified enquiry reaches the correct salesperson with complete context and the salesperson can continue the WhatsApp conversation.

Inventory control, fleet management, booking operations, payment verification, document approval, delivery execution, maintenance, active-rental support, and operational reporting are owned by the [Operations Agent](../Operations%20Agent/operations%20agent.md).
