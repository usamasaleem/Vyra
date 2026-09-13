# Vyra Sales Agent Build Plan

Thirty-six development steps in six phases, ordered by dependency — each phase needs the one before it to exist.

Scope follows the [Sales Agent MVP](./sales%20agent%20mvp.md) and the build order in section 18.16 of the [full specification](./chat%20sales%20agent.md), which remain authoritative. The phases line up with the gates in [BUILD-ROADMAP.md](../../docs/BUILD-ROADMAP.md). Stack decisions referenced here are argued in [TECH-STACK.md](../../docs/TECH-STACK.md).

Two steps carry more weight than their position suggests. **Step 8** makes everything after it recoverable — skip the outbox and every later phase inherits message loss. **Step 25** is what makes step 17 real: without the revision check, takeover is a UI state rather than a guarantee.

---

## Phase 1 — Before any code

1. **Start Meta business verification.** Calendar time you cannot compress. Begin it before the first migration, and demo on a test number while it clears.
2. **Audit the prototype.** What is reusable in `team-hub/app/api/webhook/route.ts`, what the Meta app config actually is, and who owns the number. The estimate most likely to move.
3. **Write the eval set.** Twenty real enquiries with the reply you would want, before any prompt exists. This is the test suite for everything downstream.
4. **Provision services.** Supabase project, Render web and worker services, error tracking, and a tunnel so Meta can reach your machine in development.

**Done when** you know what is reusable, and the clock on Meta verification is already running.

## Phase 2 — Durable transport

5. **Schema v1 and migrations.** `operators`, `whatsapp_accounts`, `memberships`, `contacts`, `conversations`, `messages`, `inbound_events`, `outbox`, `audit_events`. Put `operator_id` on every table now — retrofitting tenancy is the most expensive change on this list.
6. **Webhook GET.** Verify the Meta subscription challenge against the configured token.
7. **Webhook POST with signature verification.** Verify against the raw, untouched body. Read it as text before parsing, or the HMAC will not match.
8. **Save before acknowledging.** One transaction: the inbound event, the deduplication record, and an outbox row. Return success only after that commits.
9. **Outbox relay to the job queue.** A relay publishes the job after the transaction. Publishing the same job twice must be harmless.
10. **Worker skeleton.** Loads operator policy, conversation, ownership and recent messages. Replies with nothing yet.
11. **Outbound dispatcher.** The single component that calls Meta — including for messages salespeople write by hand. Records the provider message id and later delivery states.
12. **Retries and visible failures.** Bounded exponential backoff with jitter. Terminal failures land somewhere a human can see and retry them.

**Done when** a restart mid-processing and a duplicate webhook event each leave exactly one logical message and one reply.

## Phase 3 — The inbox

13. **Auth and memberships.** Supabase Auth plus a membership table, with the role checked on every API call. A browser-supplied operator id is a requested scope, not proof of permission.
14. **Tenant isolation.** Row-level security on exposed tables, plus explicit operator scoping inside the worker — which bypasses RLS because it runs on a service key. This is where a cross-operator leak is most likely to appear.
15. **Conversation list and thread view.** The salesperson's working surface: who is waiting, what was said, what state the enquiry is in.
16. **Manual reply through the dispatcher.** Staff messages take the same path as AI messages. Never build a second way to send.
17. **Takeover.** One transaction: verify the role, flip handler mode, assign the owner, increment the revision, invalidate pending AI sends.
18. **Notes, assignment and filters.** Internal notes, reassignment, and filtering by stage, owner and priority.
19. **The AI kill switch.** Stops AI sending instantly while ingestion and staff access keep working.

**Done when** two operators cannot reach each other's data by any path, and takeover suppresses an unsent AI draft.

## Phase 4 — AI qualification

20. **Approved knowledge storage.** Versioned operator content with effective dates and an explicit publish step, so an answer can be traced to its source.
21. **Field extraction with evidence.** Every extracted value carries its source message, extraction time and verification state.
22. **Date normalisation.** Relative dates resolved against the operator's timezone using the message time, confirmed with the customer, with the original wording kept alongside.
23. **Intent recognition.** The nine MVP intents, including the ones that must stop automation rather than continue it.
24. **The tool boundary.** Six tools, each with its mandatory backend check. No unrestricted SQL, no arbitrary URLs, no refunds or booking confirmation exposed to the model.
25. **Revision check before accepting output.** A short transaction rejects model output if the customer corrected something or a salesperson took over while the model was generating.
26. **Message batching window.** One to two seconds, so "hi", "Ferrari" and "tomorrow" arrive as a single turn instead of three.
27. **Non-text messages.** Voice notes and photos stored, acknowledged honestly, and routed to a person. Never silently dropped.
28. **Bounded failure.** Refusals, timeouts and exhausted tool budgets create a visible human task rather than silence.

**Done when** the eval set passes, including corrections, ambiguous dates and requests for a human.

## Phase 5 — Handoff and the Operations queue

29. **The handoff packet.** Transcript, verified facts, unresolved questions, reason, owner, priority, SLA and next action — plus escalation to a fallback when nobody accepts.
30. **Operations request queue and console.** Vehicle records, rates, and a way for a person to answer with a source and the time it was checked.
31. **Follow-ups and sending eligibility.** Opt-out handling, and the 24-hour window checked at the moment of dispatch rather than when the reply was scheduled.
32. **The ten MVP metrics.** Enquiries, first-response time, qualification rate, handoffs, quote requests, outcomes and lost reasons.

**Done when** an unaccepted handoff reaches the fallback owner without duplicate replies, and an answer with no time checked cannot reach a customer.

## Phase 6 — Shadow to live

33. **Shadow mode.** The AI drafts every reply and a salesperson sends each one. No customer receives a message the AI sent.
34. **Limited automation.** Clarifying questions and approved FAQ answers sent automatically, once the eval set passes. Everything else still drafts for a human.
35. **Supervised live.** Qualification handled end to end, with staff watching the inbox and able to stop replies instantly.
36. **Harden and onboard.** Tenant isolation tested against a second operator's data, admin configuration, and an onboarding path that does not need you in the database.

**Done when** staff can stop the AI instantly, and every failed task is visible and recoverable.

---

An interactive version of this checklist, with progress that persists, is published in the [knowledge dashboard](../../dashboard/README.md).
