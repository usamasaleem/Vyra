# Keeping a customer inside the conversation

What is available for showing something richer than text without throwing the
customer out of WhatsApp. Written after testing each one on a real phone,
because the documentation was wrong or silent about all three.

## The finding

**There is no way to do this today.** The only surface that genuinely opens
over the chat is Flows, and Meta will not let this business use them.

| Surface | Stays in WhatsApp | Available here |
|---|---|---|
| Flows (formerly "Webviews") | Yes — a panel over the thread, and a structured reply comes back | No. `(#139000) Blocked by Integrity` |
| CTA URL button | **No.** Tested: opens the phone's default browser as a separate app | Yes, sends fine |
| Interactive list | Yes, but text only — no image anywhere on it | Yes, in use |
| Product / catalog message | Yes, an in-app product view | Needs a catalog, which forces a price, a stock flag and a condition of new/refurbished/used onto every car |

"Webviews" and "Flows" are the same feature. Meta shipped webviews, developers
named them, and Meta has since standardised on Flows — so there is no separate
un-gated webview API to reach for. That was worth checking and is not true.

## CTA URL is a redirect wearing a button

The hope was that it opened WhatsApp's in-app browser over the thread. It does
not — on a real device it launched the default browser app. Whether it ever
behaves otherwise is a client and OS decision rather than an API guarantee,
which makes it something that cannot be designed around even where it happens
to be nicer.

So a link is an exit. Not a worse message: an exit. Everything the customer had
on screen — the photographs, the prices, the question they were halfway through
answering — is behind an app switch and a back gesture they may not make.

## What follows for the product

**Keep the answer in the thread.** For a fleet too large to list, that means
narrowing by conversation — a category, a budget, how many seats — rather than
linking out to a catalogue. Which is the thing a model can do and a list,
a catalog and a website cannot.

A link is a last resort for the customer who genuinely wants to browse
everything, offered once they have said so. It is not a shortcut for us.

## And it makes verification a blocker rather than a box

Meta business verification has been the first unticked step in the build plan
since the beginning, on the reasoning that it is calendar time somebody should
start early. It now gates:

- Flows, and therefore any tappable list with photographs in it
- Any in-chat surface richer than text
- The Flow that is already built, valid, and sitting in DRAFT

Nothing in this repository can move those. It is a form and a wait.
