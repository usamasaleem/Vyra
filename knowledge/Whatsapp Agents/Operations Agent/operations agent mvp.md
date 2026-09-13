# Vyra Operations Agent MVP

## MVP goal

Give the Sales Agent a trustworthy, time-stamped answer about vehicles, availability, rates, and requirements, and hold the authoritative booking record, so that no customer-facing promise rests on a stale, missing, or invented fact.

## What the MVP is, and what it is not

For the MVP the Operations Agent is a **system of record with a structured request queue answered by authorised staff**. It is not yet an automated agent.

This is deliberate. The Sales Agent's safety rules depend on Operations being right, so the records must be accurate and the answers consistently correct before any answer is generated automatically. Automation is earned, one answer type at a time, after the manual version is reliable.

What this means in practice:

- Sales sends a structured request. A human answers it in the Operations console.
- Every answer carries its source and the time it was checked.
- The fleet, rate, and requirement records are real and maintained, not placeholder data.
- Nothing is inferred. An unknown answer is returned as unknown.

## 1. Vehicle records

- Create and maintain a vehicle record per rentable vehicle.
- Store make, model, trim, year, colour, plate or reference, and category.
- Store approved customer-facing description and photos.
- Record current vehicle status.
- Record which operator owns the vehicle.
- Prevent a vehicle from being offered to Sales when its status does not permit hire.
- Record who last changed a vehicle record and when.

## 2. Availability

- Maintain booked, held, maintenance, and unavailable periods per vehicle.
- Detect overlapping periods and refuse to create a conflicting one silently.
- Apply the operator's configured turnaround buffer between rentals.
- Record the time availability was last checked or updated.
- Mark availability stale when it is older than the operator's configured freshness window.
- Return a clear availability answer to Sales rather than raw calendar data.

Availability is always answered for an explicit vehicle or category, start date and time, and end date and time, interpreted in the operator's timezone and stored in UTC.

## 3. Rates and commercial inputs

- Maintain approved daily, weekly, and monthly rates per vehicle or category.
- Maintain deposit amount, included kilometres, extra-kilometre rate, VAT treatment, and delivery fee.
- Record the effective date and version of each rate.
- Require an authorised user to publish a rate change.
- Keep superseded rate versions readable so an earlier quote can be explained.
- Calculate money using exact decimal or integer minor units, never floating point.

The MVP supplies rate inputs and a calculated draft total. It does not approve discounts, apply exceptions, or negotiate.

## 4. Requirements and eligibility reference

- Maintain the operator's configured driver age, licence, document, and payment-instrument requirements.
- Allow requirements to differ by vehicle category and by resident or visitor status.
- Return the applicable requirement list to Sales as reference information.
- Mark eligibility as pending when any factor is unclear.
- Route uncertain eligibility to an authorised person.

The MVP does not verify documents or make an eligibility decision. It states what the operator requires.

## 5. The Sales request queue

This is the core of the MVP. Sales cannot see operational records directly; it asks, and Operations answers.

A request from Sales contains:

- Operator and conversation reference.
- Customer and enquiry reference.
- Vehicle or category.
- Exact start and end date and time.
- Pickup or delivery location.
- Requested service: availability, rate, requirements, or draft quote.
- Required decision.
- Deadline and urgency.
- Customer-facing wording already used, when relevant.

An answer returned to Sales contains:

- Answer and status.
- Source record and version.
- Time checked.
- Conditions or missing information.
- Owner and next action.
- Expiry or recheck time.

Rules:

- Every request has exactly one authoritative answer at a time.
- An answer without a time checked is not a valid answer.
- An expired answer must be rechecked before Sales reuses it.
- Operations may return alternatives alongside an unavailable answer.
- Operations may decline to answer and return unknown with a next action.

## 6. Operations record states

These are four independent fields. They must not be collapsed into a single status enum, because they change for different reasons and can hold any combination.

**Vehicle status** — available for hire, reserved, on rent, maintenance, held, inactive.

**Availability answer** — available, unavailable, pending confirmation, unknown. These are the exact four states the [Sales Agent MVP](../Sales%20Agent/sales%20agent%20mvp.md) expects to receive.

**Request state** — new, in progress, answered, expired, cancelled.

**Booking state** — draft, pending approval, confirmed, cancelled, completed.

A vehicle can be "on rent" while a request about it is "answered" and a future booking is "pending approval". Storing these separately is what keeps that legible.

## 7. Booking record

- Create a booking only after the configured approval.
- Recheck availability immediately before confirming.
- Store the agreed vehicle, dates, price, deposit, customer reference, and delivery or collection detail.
- Hold the authoritative booking state.
- Record who confirmed the booking and when.
- Link the booking to the originating Sales conversation and quote version.
- Release held inventory when a booking is cancelled or expires.
- Notify Sales when a booking is created, changed, cancelled, or put at risk.

A booking is never created by the Sales Agent, by a customer message, or by a payment event alone.

## 8. Change notification back to Sales

- Notify Sales when a vehicle shown to a customer becomes unavailable.
- Notify Sales when a rate that supported a live quote changes.
- Notify Sales when a booking state changes.
- Include what changed, the new state, the time, and the reason.
- Never silently change a fact that a customer has already been told.

## 9. Operations console

Provide a basic console where authorised staff can:

- See incoming Sales requests, oldest and most urgent first.
- Open a request with its full context.
- Check availability for the requested vehicle and dates.
- Answer the request with a status, source, and conditions.
- Return an unknown answer with a next action.
- Add or edit vehicle records.
- Set maintenance, hold, and unavailable periods.
- View and publish rates.
- Create, confirm, and cancel bookings.
- See overdue requests and approaching deadlines.
- Add an internal note.

## 10. Authority rules

- Only an authorised user can publish a rate, confirm a booking, or change a vehicle's status.
- Sales cannot write to any operational record.
- An answer sent to Sales is attributed to the person or system that produced it.
- Changing a published rate creates a new version rather than editing the old one.
- Confirming a booking requires a current, unexpired availability check.
- Every authority-bearing action is recorded with actor, timestamp, and reason.

## 11. Essential safety rules

The Operations Agent must never:

- Report a vehicle as available without a current check.
- Present stale data as current.
- Infer that a payment succeeded from anything other than a trusted payment event.
- Treat a customer screenshot or message as proof of payment.
- Confirm a booking that conflicts with an existing one.
- Approve a document or make an eligibility decision.
- Let an unresolved record conflict pass through to a confirmation.
- Silently overwrite a conflicting update.

When records disagree, mark the conflict, stop the affected confirmation, and assign a resolution task.

## 12. Basic administration

An authorised user can configure:

- Rental operator profile.
- Timezone and service hours.
- Operations users and roles.
- Availability freshness window.
- Turnaround buffer.
- Vehicle categories.
- Requirement sets.
- Request deadline and escalation owner.
- Data retention period for operational records.

## 13. Reliability and visibility

- Save an incoming Sales request durably before processing it.
- Show unanswered requests that are approaching or past their deadline.
- Show requests that failed to deliver an answer back to Sales.
- Retry temporary failures with a bounded backoff.
- Log every record change and every answer sent.
- Keep an audit trail for rates, availability answers, and bookings.
- Keep operational data separated per rental operator.
- Ensure a restart loses no request, answer, or booking.

## 14. MVP reporting

Track only the essential operational measures:

- Open and overdue Sales requests.
- Median and worst time to answer a request.
- Share of answers returned as unknown.
- Availability answer accuracy, measured against what actually happened.
- Stale-record count.
- Booking conflicts detected.
- Bookings created, confirmed, and cancelled.
- Vehicles with incomplete records.

Enquiry volume, qualification, quotes, handoffs, and conversion belong to the [Sales Agent MVP](../Sales%20Agent/sales%20agent%20mvp.md).

## 15. MVP acceptance checklist

The MVP is ready for a supervised pilot when:

- [ ] Every rentable vehicle has a complete, current record.
- [ ] Availability reflects real bookings, holds, and maintenance.
- [ ] Overlapping periods are rejected rather than silently accepted.
- [ ] A Sales request reaches the Operations console with full context.
- [ ] An answer returns to Sales with a source and a time checked.
- [ ] An answer with no reliable basis returns unknown, not a guess.
- [ ] Stale availability is visibly marked and cannot support a confirmation.
- [ ] A rate change creates a new version and preserves the old one.
- [ ] Money totals are exact and reproducible.
- [ ] A booking cannot be confirmed without a current availability check.
- [ ] A vehicle becoming unavailable notifies Sales.
- [ ] Only authorised users can publish rates, confirm bookings, or change vehicle status.
- [ ] Overdue requests are visible and escalate to the configured owner.
- [ ] Operational data from one rental operator cannot be accessed by another.
- [ ] A restart loses no request, answer, or booking.
- [ ] The team has tested the main flows and conflict cases before real customer traffic depends on them.

## MVP boundary

The MVP ends when Sales can ask an operational question and receive a trustworthy, attributed, time-stamped answer, and when a confirmed booking exists as an authoritative record.

Out of MVP scope, in roughly the order they should follow: document collection and review, payment and deposit verification through a trusted provider, delivery scheduling and handover execution, active-rental support, maintenance scheduling, fines and damage handling, deposit release, and operational performance analytics. These are described in the full [Operations Agent](./operations%20agent.md) specification.

Customer conversation, qualification, quotes as a sales conversation, handoff, and sales follow-up are owned by the [Sales Agent](../Sales%20Agent/sales%20agent%20mvp.md).
