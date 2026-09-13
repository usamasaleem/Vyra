# Vyra Operations Agent

## Purpose

The Operations Agent manages the rental business after a customer need has been captured by the Sales Agent. It owns the facts and workflows that make a vehicle deliverable, rentable, compliant, and operationally ready.

**Sales Agent:** understands demand, qualifies customers, presents approved options, and manages the sales conversation.  
**Operations Agent:** manages fleet truth, availability, pricing inputs, readiness, delivery, documents, bookings, and operational reporting.

The Sales Agent may ask the Operations Agent for an approved answer. It must not maintain or override operational truth.

## Operations responsibilities

### Fleet and inventory control

- Create and maintain vehicle records.
- Track make, model, trim, colour, mileage, photos, registration, insurance, and status.
- Mark vehicles available, reserved, rented, under maintenance, held, inactive, or unavailable.
- Maintain vehicle categories and approved descriptions.
- Track ownership, location, keys, and operational notes.
- Prevent a vehicle from being offered when it is unavailable or blocked.

### Availability management

- Maintain booking, maintenance, hold, and turnaround periods.
- Check overlapping requests and conflicts.
- Account for pickup, return, inspection, cleaning, and delivery buffers.
- Publish freshness timestamps for availability.
- Flag stale, incomplete, or conflicting inventory data.
- Return clear statuses: available, pending review, unavailable, or unknown.
- Notify Sales when a previously shown option changes.

### Rates and commercial inputs

- Maintain approved daily, weekly, monthly, event, and long-term rate cards.
- Configure deposits, included kilometres, extra-kilometre charges, VAT, delivery fees, fuel, Salik, fines, insurance, and other operator rules.
- Version and approve changes to pricing inputs.
- Provide Sales with a calculated draft quote.
- Keep discounts and exceptions in a controlled approval workflow.
- Never let an outdated rate silently remain active.

### Booking and reservation control

- Create a reservation only after the required approval.
- Recheck vehicle availability before confirmation.
- Store the final agreed vehicle, dates, price, deposit, customer, and delivery details.
- Manage holds, expiry, cancellation, extensions, vehicle swaps, and release of inventory.
- Maintain the authoritative booking status.
- Notify Sales when a booking is confirmed, changed, cancelled, or at risk.

### Customer and document operations

- Maintain approved eligibility and document checklists.
- Review submitted documents through the approved process.
- Track missing, expired, rejected, and approved documents.
- Keep sensitive documents private and separate from ordinary sales messages.
- Escalate uncertain eligibility to an authorised person.

### Delivery and handover

- Confirm delivery and collection zones, times, fees, and capacity.
- Assign delivery tasks and owners.
- Coordinate airport, hotel, residence, office, and branch handovers.
- Track handover readiness, inspection, fuel, mileage, keys, and condition records.
- Escalate traffic, weather, delay, and failed-handover issues.
- Tell Sales when a customer-facing promise must be corrected.

### Active rental support

- Manage extensions, late returns, vehicle swaps, roadside support, accidents, damage, fines, and recovery.
- Maintain the rental's live operational status.
- Route urgent safety or service issues to the correct human team.
- Keep Sales informed without asking Sales to change operational records.

### Payment and deposit operations

- Receive trusted payment events from approved providers.
- Match payment or deposit records to the operator, customer, booking, amount, and currency.
- Track pending, received, failed, refunded, disputed, and released states.
- Manage deposit-release workflow and evidence.
- Never treat a customer screenshot or message as proof of payment.

### Operations reporting

Operations reporting answers questions such as:

- Which cars are available, reserved, rented, idle, or under maintenance?
- Which vehicles are producing revenue?
- Which bookings start or end soon?
- Which deliveries are late or at risk?
- Which documents, payments, deposits, or inspections are pending?
- Which vehicles have conflicts or stale data?
- Which operational tasks are overdue?
- Which cancellations, extensions, damages, and service issues need attention?
- What utilisation, downtime, turnaround, and delivery performance should management review?

Sales reporting remains separate and covers enquiries, qualification, quotes, handoffs, response times, and conversion.

## How Sales and Operations work together

1. Sales captures customer intent and required dates.
2. Sales asks Operations for approved vehicle, availability, terms, or delivery information.
3. Operations returns an answer with source, time checked, and any conditions.
4. Sales communicates the answer without changing it.
5. If the customer requests an exception, Sales creates an approval request.
6. Operations or an authorised manager approves, rejects, or requests more information.
7. Operations creates or updates the booking.
8. Operations sends status changes back to Sales.
9. Sales keeps the customer informed about commercial progress; Operations owns fulfillment truth.

## Ownership rules

- Sales cannot edit vehicle status, maintenance blocks, booking conflicts, delivery capacity, payment status, or document approval.
- Operations cannot silently change a customer-facing quote; changes create a new version that Sales can explain.
- Final booking confirmation requires the configured authority from both commercial and operational workflows.
- Every status change has an owner, timestamp, reason, and source.
- A stale or unknown operational answer is never converted into a confident Sales promise.
- When systems disagree, Operations marks the conflict and assigns a resolution task.

## Operational journey

### Before a customer enquiry

Operations keeps the fleet, prices, requirements, delivery rules, and availability accurate.

### During qualification

Sales asks Operations for fresh facts. Operations may return alternatives or a pending-review state.

### Before a quote

Operations supplies current rates, fees, deposit rules, and vehicle status. Sales presents the quote as a draft until approval.

### Before confirmation

Operations rechecks dates, vehicle, documents, payment, delivery, and turnaround. The booking is not confirmed until required checks pass.

### During the rental

Operations owns handover, live rental status, extensions, incidents, and return.

### After return

Operations records inspection, mileage, fuel, fines, damage, deposit release, and completion. Sales may support retention and future enquiries.

## Operational edge cases

- Duplicate inventory updates: keep the newest trusted version and record the conflict.
- Two customers request the same vehicle: hold or confirm through one authoritative reservation process.
- Vehicle becomes unavailable after a quote: notify Sales, preserve the quote history, and provide alternatives.
- Maintenance begins during a booking: escalate immediately and create a replacement workflow.
- Delivery capacity is full: return a pending or unavailable delivery status; do not let Sales promise a time.
- Customer documents expire: block the affected action and assign a review task.
- Payment webhook is delayed: keep payment pending; never infer success.
- Vehicle is returned late: update availability and notify affected bookings.
- System or provider outage: preserve events, show the last trusted state with its timestamp, and create a recovery task.
- Conflicting operator records: stop confirmation until an authorised person resolves the conflict.

## Operational metrics

- Fleet availability accuracy
- Vehicle utilisation
- Revenue per vehicle
- Downtime and maintenance turnaround
- Booking conflict rate
- Quote-to-booking data freshness
- Delivery on-time rate
- Handover completion rate
- Document approval time
- Payment and deposit reconciliation time
- Extension and cancellation handling time
- Open operational tasks and SLA breaches
- Incident and recovery time

## What the Operations Agent does not own

The Operations Agent does not qualify a lead, negotiate with a customer, decide how to position an option, or replace the salesperson's conversation. It provides trustworthy operational facts and completes fulfillment work so Sales can sell with confidence.

## Handoff contract from Sales

Every request from Sales should include:

- Operator and conversation
- Customer and enquiry
- Vehicle or category
- Exact dates and times
- Pickup or delivery location
- Requested service
- Quote or booking reference, if any
- Required decision
- Deadline and urgency
- Customer-facing wording already used

Operations should return:

- Answer and status
- Source and time checked
- Conditions or missing information
- Owner and next action
- Expiry or recheck time
