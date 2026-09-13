# Vyra — Technology Stack

Analysis and recommendation · September 2026

This document reviews the stack proposed in section 18 of the [Sales Agent specification](../Whatsapp%20Agents/Sales%20Agent/chat%20sales%20agent.md), compares it against what actually exists, and records a recommendation for a solo build. The specification remains authoritative; this is commentary on it.

## 0. The proposed architecture

![Proposed Vyra Sales Agent architecture: a customer on WhatsApp reaches a Next.js webhook through Meta's Cloud API; the message is stored before acknowledgement and picked up by a graphile-worker process, which runs the AI turn, requests availability from Operations, and dispatches the reply back through Meta. Supabase provides the single PostgreSQL datastore, holding records, the job queue and the outbox.](../dashboard/assets/architecture.svg)

Two processes and one datastore. Solid arrows carry a request, grey arrows carry a result or status back. The green channel at the top is the only path to the customer, and the worker is the only component that uses it — including for messages a salesperson types by hand.

Every component in the diagram is marked **Proposed**. None of it is built.

## 1. What exists today

The prototype is a **single Next.js route handler** — `team-hub/app/api/webhook/route.ts`, in a separate project from this repository.

It does:

- GET verifies the Meta subscription challenge against an environment token.
- POST parses the payload, extracts the *first* text message, and attempts a reply.
- Calls the OpenAI Responses API when an API key is present.
- Falls back to a generic qualification reply when no key is configured.
- Reads inventory from a JSON environment variable (`RENTAL_INVENTORY_JSON`).

Everything — model call and send — happens **inside the webhook request**.

Known gaps, as recorded in the brief:

- No incoming POST signature verification.
- No durable event storage, duplicate protection, conversation memory or ownership model.
- Only the first qualifying message is extracted; batching is not handled.
- No durable background processing; failures are logged and acknowledged without recovery.
- Missing send credentials cause a skip, yet the caller can still log "reply sent."
- The `available` boolean in prototype inventory cannot establish availability for a date range.
- No staff interface, authenticated owner tools, booking verification or operator isolation.

Environment variables currently referenced: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `RENTAL_INVENTORY_JSON`.

**The proposed stack is therefore a rewrite**, not a greenfield plan: roughly one file becoming three processes and twenty tables.

## 2. The proposed stack, layer by layer

| Layer | Specification's choice | Assessment |
|---|---|---|
| Language | TypeScript, Node LTS | Uncontroversial. Shared contracts across processes is the real benefit |
| Sales inbox | Next.js + React | Already what the prototype uses. SSR and RSC buy little for a logged-in internal tool, but switching costs more than it saves |
| HTTP API | Fastify, as a separate service | Questionable for a solo build — see section 4 |
| Database | Supabase-managed PostgreSQL | Strong. Auth, row-level security and storage from one vendor is significant value for one person |
| Staff identity | Supabase Auth | Sound, with an important caveat — see section 5 |
| Files | Supabase Storage, private | Fine. Keep document access separate from ordinary inbox access |
| Background jobs | BullMQ with Redis | The largest available simplification — see section 4 |
| AI | OpenAI Responses API | Model deliberately unpinned until evaluated. Correct |
| Channel | Meta WhatsApp Cloud API, direct | Cheaper and fully controllable; you own onboarding and template lifecycle |
| Hosting | Render services plus Supabase | Two vendors and cross-network query latency. Acceptable for a pilot |
| CI | GitHub Actions | Fine |
| Monitoring | "structured logs, error tracking, metrics" | Underspecified — nothing is actually named |

## 3. What the architecture gets right

The stack matters less than the architecture, and three ideas in the message path are unusually well specified.

**The transactional outbox.** The inbound event, the deduplication record and an outbox row are written in one transaction, and the webhook acknowledges only after that commits. A relay publishes the job afterwards. This solves the dual-write problem — database write succeeds, queue publish fails, message lost. The current prototype does the opposite by working inside the request.

**Revision-based staleness rejection.** Model output is discarded if the customer corrected something, a salesperson took over, or a policy changed during generation. A short transaction checks the conversation revision before accepting output that a long model call produced outside any transaction. This is what makes human takeover a guarantee rather than a UI state.

**It refuses to promise exactly-once delivery.** If Meta accepted a send but the response was lost, a retry may duplicate it; the specification says to mark the outcome unknown and reconcile against provider events rather than pretend the ambiguity away.

A fourth, from the AI section: **commercial values are rendered from validated database fields and the model only phrases the language around them.** This makes a hallucinated price structurally impossible for the fields that carry money — far stronger than instructing a model not to invent numbers.

## 4. Recommended changes for a solo build

The individual choices are defensible. The aggregate — three services, two datastores, eight packages — is more surface area than one builder should carry to a pilot.

**Drop Redis; use `graphile-worker` on PostgreSQL.** An outbox table is already required. `SELECT … FOR UPDATE SKIP LOCKED` is a real queue, and graphile-worker wraps it with retries, backoff and cron. BullMQ's features are genuine but replicable, and Redis costs a service to provision, a second place where state lives, and another failure mode. The specification explicitly permits this: *"If the team already runs a reliable database-backed queue, it can replace BullMQ/Redis."* Job keys also give per-conversation serialisation, which is a documented requirement.

**Two processes, not three.** The worker must be separate — it runs continuously. But the webhook already lives in Next.js and works there. A separate Fastify service on day one is a third deployment to configure and monitor for little gain at pilot scale.

**Flatten the monorepo.** Section 18.14 proposes three apps and five packages. Two apps and two packages is enough until a second application needs to share something.

**Add an eval set as a first-class stack component.** For an AI product this is the test suite — the only way to tell whether a prompt change improved anything. The specification mentions evaluation fixtures but buries them in a directory listing.

**Name the monitoring.** "Error tracking" unnamed means it will not exist.

Net effect: three services and two datastores become two services and one.

## 5. Traps that will bite

**Raw body for signature verification.** The specification says verify *against the untouched request body*. Any parser that touches it first breaks the HMAC. Read the body as text before parsing. The prototype has no signature verification at all, so this is entirely unbuilt.

**Per-conversation serialisation.** *"Do not assume a global queue concurrency setting serializes each conversation."* Two rapid messages from one customer processed concurrently produce interleaved replies and conflicting state. This needs a per-conversation lock or job key, not a global concurrency limit.

**The service key bypasses row-level security.** The worker has no user session, so it runs privileged — RLS protects the browser path and not the worker path. Every worker query needs explicit operator scoping. This is the most likely place for a cross-operator leak, and it will not appear in testing through the UI.

**Money as floating point.** AED has fils. Use integer minor units or exact decimals.

**The 24-hour window at dispatch.** A job queued at hour 23 and dispatched at hour 25 needs an approved template. Evaluate eligibility when the message is actually sent, including for messages salespeople write.

**Inventory as an environment variable** must die first. A boolean flag cannot answer a question about a date range.

## 6. Missing from the specification

- No local development story for webhooks — Meta cannot reach `localhost`, so a tunnel and Meta test numbers are required.
- No migration tool named.
- No error-tracking service named.
- Nothing on Meta API rate limits.
- No stated threshold for when approved knowledge outgrows the prompt. The specification is right that a vector database is unnecessary now; it does not say when that changes.

## 7. On the model choice

The specification selected the OpenAI Responses API but deliberately refused to pin a model before evaluation. That is the right posture, and because the architecture puts the model behind a narrow tool boundary with backend-rendered commercial values, **swapping providers is cheap**. Treat it as reversible.

When the evaluation runs, the criteria that matter for this market:

- **Arabic and mixed-language handling.** This is where models genuinely diverge for Dubai, and it matters more than benchmark scores.
- **Latency.** The specification targets p95 under 15 seconds for an ordinary reply. On WhatsApp that reads as nobody being there; under five seconds is the target worth designing for. The 1–2 second batching window and tool round-trips both consume that budget.
- **Cost, last.** At pilot volume — roughly a thousand enquiries a month — token cost is rounding error against the builder's own time. Optimise for quality and speed.

Include several providers in that evaluation, Claude among them, and decide on measured results rather than reputation.

## 8. Caveat

This analysis was written against knowledge current to May 2026. Verify the current Meta Cloud API version, library versions and provider API shapes before relying on any specific detail here.
