# Vyra modules and the line between them

Vyra has three modules: the **Sales Agent**, the **Operations Agent**, and **Inventory**. This page is the line between them. Where an older spec disagrees — "Operations Agent" in `Operations Agent/operations agent.md` includes fleet, availability and rates — this page wins: those now belong to Inventory.

Decided by Usama on 26 September 2026.

## The order we build in

1. **Sales Agent** — now.
2. **Inventory** — next. The Sales Agent is only as good as the car facts it quotes from, so these two must both be excellent before anything else.
3. **Operations Agent** — after that.
4. **Analytics** — the future, once the three are going well: trends, forecasting and pricing insight. Day-to-day reporting (today's revenue, bookings, cars out) stays with the Operations Agent; Analytics is the deeper data side.

## The bar: a premium product

Vyra is priced as a full end-to-end solution — around $500 to $1,000 a month per operator — not a cheap chatbot. Every module is built to that bar: it answers in seconds day and night, never invents a fact, never leaves a customer without a reply, handles a standard booking with nobody involved, and looks and feels as polished as the cars it rents.

## The one-sentence version

- **Sales Agent** talks to **customers**. It turns an enquiry into a confirmed, paid booking and keeps the customer informed about their own booking.
- **Operations Agent** talks to **your team**, on WhatsApp (text or voice notes) and on the dashboard. It runs the business: reports, today's work, approvals, drivers, returns, deposits and money.
- **Inventory** is **the facts about the cars**: which cars, their photos, specs, prices, deposits, availability and status. It has no conversation of its own; both agents read it, and only people or the Operations Agent change it.

## The rules that keep the line concrete

1. **Who is on the other end decides the module.** A message from or to a customer is Sales. A message from or to a team member is Operations. There is no message that is both.
2. **The Sales Agent never talks to the team, and the Operations Agent never talks to a customer.** When a decision a person makes must reach a customer — a booking approved, a refund sent, a delivery time moved — Operations records the decision and the Sales Agent tells the customer, in the customer's conversation.
3. **Anything beyond the Sales Agent's rules becomes an Operations request.** A booking over the ceiling, a discount above the tiers, a document problem, a refund, a customer who insists on a person: the Sales Agent says what happens next, and the Operations Agent puts it to the right person ("Approve the Huracán, 6 days, AED 33,000? Reply yes or no, or send a voice note").
4. **The booking changes hands at "confirmed".** Up to confirmation — and every customer message after it — is Sales. What happens to the booking in the real world is Operations: driver, handover, return, inspection, deposit, fines, and matching payments to the bank.
5. **Reporting is Operations.** Revenue, bookings, cars out today, utilisation, conversion, how the Sales Agent is performing — asked by voice ("how much did we make this week?") or read on the dashboard.
6. **Inventory is one copy of the truth.** The Sales Agent reads it to quote and answer availability. The Operations Agent reads it and changes it on your team's word ("the Cullinan is in the garage until Monday"). Neither agent keeps its own copy, and every change goes through Inventory's rules (no overlapping bookings, confirmed prices only).

## Where each piece belongs

| Piece | Module | Why |
|---|---|---|
| Enquiries, questions, quotes, holds, booking within limits | Sales | Customer conversation |
| Discounts within your tiers, extras at booking | Sales | Customer conversation, within rules you set |
| Collecting documents and the automatic check at booking | Sales | Asked of the customer as part of booking |
| Payment links and payment reminders to the customer | Sales | Customer message |
| Cancellations, date changes and extensions the customer asks for | Sales | Customer conversation; refunds are Operations |
| Day-before handover and return messages to the customer | Sales | Customer message |
| Follow-ups and WhatsApp templates to customers | Sales | Customer message |
| Policy answers (deposit, kilometres, cancellation…) | Sales | The rules the Sales Agent speaks from |
| Autonomous mode | Sales | How far the Sales Agent may go alone |
| Team alerts | Operations | The team's channel |
| Approvals: bookings over the ceiling, discounts, documents problems | Operations | A person decides |
| Handovers board, returns, inspections, drivers | Operations | Real-world work on a booking |
| Payments received, refunds, deposits, fines, Salik | Operations | Money, after the booking |
| Reports and the dashboard home screen | Operations | Running the business |
| Cars, photos, specs, rates, deposits | Inventory | Facts about the cars |
| Availability calendar and car status (service, garage, damage) | Inventory | Facts about the cars |

## Still to decide

- **How the team reaches the Operations Agent on WhatsApp.** Either the same business number, with team members recognised by their own phone numbers (anyone else is a customer), or a second number just for the team. The same number is simpler to set up; a second number keeps customers and staff apart completely.
- **Which team roles may approve what** by WhatsApp (for example, only the owner approves refunds).
