# Ideal conversation flow

What a booking should look like when everything works: a customer goes from their first message to a confirmed, paid-for car on WhatsApp, and the only person involved is the salesperson who checks the work afterwards.

This is the standard for reviewing live conversations. When a real transcript differs from this, either the agent is wrong or this page needs updating. Don't leave the difference unexplained.

## What "ideal" means

- **The agent books.** The operator has auto-confirm on and a complete calendar, so the agent confirms and holds the car itself. It never offers to "send it to the team" and never says a colleague will confirm.
- **One question per message.** It answers what the customer asked first, then asks the one thing it still needs. It never sends a list of questions.
- **No repeated questions.** Anything the customer has already said is saved to the enquiry and not asked again.
- **The record is the truth.** Whether the car is free, booked, paid for or checked comes from the database, not from what was said earlier in the chat.
- **Staff check the work instead of chasing the customer.** They open `/bookings`, check the documents and the account, and click. They don't need to message the customer.
- **It never claims something it can't know.** It doesn't say it has seen a document, that a payment has arrived, or that a car is free unless the calendar says so.

Target: **about 10 customer messages** from "hi" to "paid", with **no hand-off to a person**.

---

## The main path

In the examples, the operator's example fleet and rules are:
- Ferrari 488 Spider, AED 5,000 a day. The deposit is one day's rate, so AED 5,000.
- Drivers must be at least 25 and have held their licence for at least a year.

### 1. First message

The operator's written greeting is sent only when the first message is just a hello ("hi", "salam"). When the customer opens with a question, as here, the answer is the welcome.

> **Customer:** Hi, do you have a Ferrari available this weekend?
>
> **Vyra:** Hi Usama! Yes, the Ferrari 488 Spider. It's AED 5,000 a day. Which days do you need it, Saturday to Sunday?

**Behind it:** the enquiry is created and the car saved as the vehicle of interest. The agent answers the question (yes, here's the car and its rate) before asking the next thing.

**What doesn't happen:** no greeting menu, no "How can I help you today?", no four questions at once.

### 2. Dates and delivery

> **Customer:** Saturday to Monday
>
> **Vyra:** That's Saturday 26 to Monday 28 September, is that right? And should we deliver it, or will you collect it?
> *[Delivery] [Collection]*
>
> **Customer:** *taps Delivery*

**Behind it:** `record_enquiry_fields` saves the dates and the delivery preference. The agent reads relative dates back as real dates once, because a wrong day costs a rental. Buttons appear only when the question has a fixed set of answers.

### 3. The quote

> **Vyra:** The Ferrari 488 Spider is free Saturday 26 to Monday 28 September. For 2 days it's AED 10,000, plus a refundable AED 5,000 deposit. Shall I book it for you?
> *[Yes, book it] [Not just yet]*

**Behind it:** `prepare_quote` checks the calendar (`free`) and prices the rental using the return-day rule (26 → 28 is 2 days). It returns a `quoteId`, and the quote message includes the deposit. The offer is "shall I book it", not "shall I send it to the team".

**Salesperson sees:** the quote on the conversation, with a way to discount it if they choose. They don't need to do anything.

### 4. Yes: booked, and what to bring

> **Customer:** *taps Yes, book it*
>
> **Vyra:** Ferrari 488 Spider, Saturday 26 to Monday 28 September, delivered, AED 10,000 plus AED 5,000 deposit. Booked, it's confirmed and held for you.
>
> For the handover, bring your passport with your entry stamp or visa, your driving licence, and an International Driving Permit if your licence isn't from a recognised country. The driver needs to be 25 or older and to have held their licence for at least a year.

**Behind it:** `request_booking_review` with that exact `quoteId` confirms the booking and places a hold on the calendar straight away. It then marks the enquiry won, records the rental and deposit as owed, and cancels any scheduled follow-ups. The one-line summary is there so a wrong detail gets caught now, not later on the phone. The list of what to bring is the operator's published wording, not the model's.

**Salesperson sees:** the booking under `/bookings` → confirmed, marked *confirmed automatically*, with a checklist of Delivery, Payment and Documents.

### 5. Where and when

> **Vyra:** Where should we deliver it?
>
> **Customer:** Address Downtown, Sheikh Mohammed bin Rashid Blvd
>
> **Vyra:** Got it. What time on Saturday would you like it?
>
> **Customer:** 10am
>
> **Vyra:** 10:00 on Saturday at Address Downtown. Could you send me a photo of your licence and passport here?

**If they're collecting instead:** there's no address to ask for, but there is still a time. "What time on Saturday will you come to collect it?" Once they give it, the agent says where to come, using the operator's published *collection point* answer word for word.

**Behind it:** `record_booking_progress` saves the address, then the time, as soon as each is given. The checklist decides what to ask next, in this order: address, time (or collection time), documents, payment. The agent asks for the first missing item only, and only asks about delivery if the customer chose delivery.

### 6. Documents

> **Customer:** *sends two photos*
>
> **Vyra:** Thanks, I've got both photos and they're on your booking. The team will check them before delivery.

**Behind it:** each photo is saved against the booking automatically (`fileDocumentIfBooked`) and acknowledged, so it doesn't count as an "unreadable message" or go to a person. The agent never says it can read, see or approve a document.

**Salesperson sees:** Documents 2 of 2 on the booking, with the images. They check them and click **Mark checked**, which records who checked them and when.

### 7. Payment

> **Vyra:** To pay the AED 15,000 (rental and deposit): *[the operator's published payment answer, word for word: bank transfer to ___ IBAN ___, the payment link, or card/cash on delivery]*. Which suits you?
>
> **Customer:** I'll transfer now
>
> **Customer:** Done, sent
>
> **Vyra:** Thank you. The team will confirm it's arrived and you're all set for Saturday at 10:00.

**Behind it:** `record_booking_progress` saves the payment plan (for example, transfer), then `saysPaid`. If the plan is on delivery, payment counts as settled at once. The agent never says the money has arrived.

**Salesperson sees:** Payment shows *customer says paid — check the account*. They check the bank and click **Record** (paid). If the customer chose a link, they attach it there instead and the agent sends it.

### 8. Done

The checklist is complete, so the agent stops asking. It doesn't send a sign-off or a "let me know if you need anything!" just to fill space. If the customer writes again, the agent answers using what the booking record says.

**Staff clicks, from enquiry to paid booking: 2.** Mark documents checked and record the payment.

---

## Branches

Each branch should rejoin the main path. None of them should end at "someone will get back to you" unless a person really is needed.

| Situation | What the ideal reply does |
|---|---|
| **Car is taken for those dates** | Says so plainly and offers the closest alternative that is free for the same dates, with its price. Never says the car is "being checked with the team". |
| **Car is already theirs** (`already_theirs`) | Tells them it's already booked for them, and doesn't call it taken. |
| **They ask for a discount** | Doesn't make one up. A discount is the salesperson's decision: the quote shows up for them to reduce, and the agent tells the customer it will check. This is the one planned hand-off on the price. |
| **Two cars** | Keeps a separate quote and booking for each car, and names the car whenever it asks something ("the delivery time for the Huracán"). |
| **Comparing cars** | Gives the reason to pick one (what each car is for, and what it costs for their dates) instead of listing both back and asking which. |
| **"Can I keep it another day?"** | `extend_booking` extends from the end of the current hold, charges only the extra rental (no second deposit), and confirms it. |
| **Asks again after a timeout, or quotes again** | The existing booking for the same car and start date is returned (`alreadyRequested`), so no duplicate booking is created. |
| **Booking was cancelled** | The agent goes by the booking record, not the old messages, and doesn't tell them they're still booked. |
| **Arabic** | The whole flow happens in Arabic, including the buttons, and the Arabic "yes" and opt-out phrases are understood. |
| **Voice note** | Answered as normal, but names, dates and numbers are repeated back, because transcription can get them wrong. |
| **Photo before any booking** | Acknowledged. It can't be read automatically, so it goes to a person if the request depends on it. |
| **Silence after the quote** | Scheduled follow-ups run. They stop the moment a booking exists, and never chase a customer who has already booked. |
| **Driver is under 25, or their licence is too new** | Quotes the operator's rule as published. It doesn't argue it or make an exception, and goes to a person if the customer insists. |
| **"Stop" / opt-out** | Nothing more is sent, including follow-ups. |
| **Wants a person** | `request_handoff`. The AI pauses and the salesperson picks it up in the inbox. |

---

## Never

- "Shall I send this to the team for confirmation?"
- "A colleague will confirm your booking." It is already confirmed.
- "I can see your licence is valid" or "Your documents are approved."
- "Payment received."
- A car described as booked when the record says otherwise.
- A deposit, rule, account number or document requirement that isn't in the operator's published answers.
- The same question asked a third time.

---

## What stops this flow working end to end today

The code supports every step above. What's missing is operator content and setup:

| Gap | Effect on the flow | Who fixes it |
|---|---|---|
| **Payment answer unpublished** (bank name / IBAN blanks) | At step 7 the agent says "a colleague will send the payment details", and a person has to step in. **This is the biggest break in the flow.** | Operator: Knowledge → Payment |
| Collection point answer unpublished | A collecting customer isn't told where to come; the agent says it will send the pickup point, and that becomes a task | Operator: Knowledge → Collection point |
| Kilometres, delivery areas and business hours answers unpublished | The agent can't answer those questions and hands off | Operator: Knowledge |
| Service hours not set | Out-of-hours handling can't tell customers when a person will be available | Operator settings |
| `ai_resumes_after_minutes = 5` | After a hand-off, the AI comes back in 5 minutes and may pick up a thread a person is still working on | Decision pending |
| Meta business verification | No templates, so no delivery-day reminder and no follow-up outside the 24-hour window | Operator with Meta |
| Delivery-day reminder | Not built. Step 8 ends in silence until the car arrives | Build once templates are approved |
