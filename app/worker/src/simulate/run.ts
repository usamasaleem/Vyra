import { meaningOfButton } from '@vyra/contracts'
import { bookingChecklist, type QueryRunner } from '@vyra/db'
import type { ModelAdapter } from '@vyra/agent'
import { sendDueFollowUps } from '../follow-ups.js'
import { processInboundMessage } from '../tasks/process-inbound-message.js'
import {
  acknowledgeWaiting, fileDocumentIfBooked, greetIfNew, handleNonTextMessage, handleUrgentMessage,
  runConversationTurn, type TurnDependencies,
} from '../turn.js'
import { nextAction, type CustomerAction, type Line } from './customer.js'
import type { Persona } from './personas.js'
import { createSimWorld, MEMBER, newCustomer, OPERATOR, type SimWorld } from './world.js'

/**
 * One customer, played through the real pipeline.
 *
 * Every message goes in the way the webhook puts it in — a row in messages, the
 * conversation's revision moved — and out through the same functions the
 * worker calls: processInboundMessage decides, the turn answers, photos are
 * filed, follow-ups are swept. Only WhatsApp itself is missing: what would have
 * been sent is read back from the messages table.
 */
export type Played = {
  persona: Persona
  lines: Line[]
  facts: RunFacts
  errors: string[]
  turnMs: number[]
}

export type RunFacts = {
  bookings: Array<{ state: string; vehicle: string | null; days: number | null; handover: string | null;
    deliveryAddress: string | null; deliveryTime: string | null; documents: number; paymentPlan: string | null;
    addOns: string[] }>
  latestQuote: { vehicle: string | null; days: number; totalMinor: number; discounted: boolean } | null
  held: boolean
  handoffs: Array<{ reason: string; summary: string }>
  runs: Array<{ state: string; ms: number; tools: string }>
  outbound: Array<{ body: string; buttons: string[] }>
  nextAction: string | null
  /** Every amount the record can account for, in whole currency, as plain number strings. */
  knownAmounts: string[]
  /** What the record says, as text: answers, quotes, holds, what the customer wrote. */
  truth: string[]
  /** Today in the operator's clock. */
  today: string
}

export async function playPersona(input: {
  persona: Persona
  model: ModelAdapter
  customerModel: { apiKey: string; model: string }
  withAnswers: boolean
}): Promise<Played> {
  const world = await createSimWorld({ withAnswers: input.withAnswers })
  try {
    return await play(world, input)
  } finally {
    await world.close()
  }
}

async function play(
  world: SimWorld,
  input: { persona: Persona; model: ModelAdapter; customerModel: { apiKey: string; model: string } },
): Promise<Played> {
  const { persona } = input
  const { conversationId } = await newCustomer(world, persona.brief.match(/You are ([^,.]+)/)?.[1] ?? 'Customer')
  const deps: TurnDependencies = {
    run: world.run, transact: world.transact, model: input.model, destination: 'send',
  }

  if (persona.before === 'ferrari_taken') {
    // Somebody else has the Ferrari for the next fortnight.
    await world.run(
      `insert into vehicle_availability (operator_id, vehicle_id, start_date, end_date, reason, recorded_by)
       values ($1, $2, to_char(now(), 'YYYY-MM-DD'), to_char(now() + interval '14 days', 'YYYY-MM-DD'),
               'booked', 'another customer')`,
      [OPERATOR, world.vehicles.ferrari],
    )
  }

  if (persona.before === 'rented_before') {
    // Their Ferrari in March, delivered, documents checked by a person.
    const [e] = await world.run(
      `insert into enquiries (operator_id, conversation_id) values ($1, $2) returning id`, [OPERATOR, conversationId])
    await world.run(
      `insert into field_evidence (operator_id, enquiry_id, field, value) values
         ($1, $2, 'residency', 'UAE resident'), ($1, $2, 'delivery_preference', 'delivery')`,
      [OPERATOR, e!['id']])
    const [q] = await world.run(
      `insert into quotes (operator_id, conversation_id, enquiry_id, vehicle_id, revision, state, total_minor,
                           deposit_minor, lines, start_date, end_date, days, valid_until)
       values ($1, $2, $3, $4, 1, 'superseded', 1000000, 500000, '[]'::jsonb, '2026-03-06', '2026-03-08', 2,
               '2026-03-10')
       returning id`,
      [OPERATOR, conversationId, e!['id'], world.vehicles.ferrari])
    await world.run(
      `insert into bookings (operator_id, conversation_id, enquiry_id, quote_id, state, decided_at,
                             decided_automatically, delivery_address, delivery_time, returned_at,
                             returned_by_membership_id, documents_checked_at, documents_checked_by_membership_id)
       values ($1, $2, $3, $4, 'confirmed', '2026-03-01', true, 'Jumeirah Bay, Villa 12', '11:00',
               '2026-03-08', $5, '2026-03-05', $5)`,
      [OPERATOR, conversationId, e!['id'], q!['id'], MEMBER])
  }

  const lines: Line[] = []
  const errors: string[] = []
  const turnMs: number[] = []
  let seen = new Date(0)

  /** What went out since last time, as the customer would see it. */
  const collect = async () => {
    const rows = await world.run(
      // Photos sent first share the reply's timestamp (one transaction); the
      // pictures go out before the words, as the dispatcher sends them.
      `select body, reply_buttons, reply_list, reply_image_url, created_at from messages
       where conversation_id = $1 and direction = 'outbound' and created_at > $2
       order by created_at, (reply_image_url is null)`,
      [conversationId, seen.toISOString()],
    )
    for (const r of rows) {
      seen = new Date(r['created_at'] as string)
      const buttons = (r['reply_buttons'] as Array<{ title: string }> | null)?.map((b) => b.title)
      const list = (r['reply_list'] as { rows: Array<{ title: string }> } | null)?.rows.map((x) => x.title)
      lines.push({
        from: 'business',
        text: String(r['body'] ?? ''),
        ...(buttons === undefined ? {} : { buttons }),
        ...(list === undefined ? {} : { list }),
        ...(r['reply_image_url'] == null ? {} : { photo: true }),
      })
    }
  }

  const insert = async (kind: 'text' | 'image', body: string | null): Promise<string> => {
    const [m] = await world.run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id, media)
       values ($1, $2, 'inbound', $3::message_kind, $4, $5, $6::jsonb) returning id`,
      [OPERATOR, conversationId, kind, body, `wamid.sim.${Math.random()}`,
        kind === 'image' ? JSON.stringify({ type: 'image', mediaId: 'sim', mimeType: 'image/jpeg' }) : null],
    )
    await world.run(
      `update conversations set last_customer_message_at = now(), revision = revision + 1,
         updated_at = now() where id = $1`,
      [conversationId],
    )
    return m!['id'] as string
  }

  /** The worker's process_inbound_message, minus WhatsApp. */
  const process = async (messageId: string) => {
    const started = Date.now()
    const result = await processInboundMessage(world.run, { message_id: messageId, operator_id: OPERATOR }, {
      systemAiSendingEnabled: true, dispatcherAvailable: true,
    })
    if (result.outcome !== 'processed') {
      errors.push(`message not processed: ${result.outcome}`)
      return
    }
    const { context, handling } = result
    if (handling.reason === 'urgent_needs_a_person' && handling.urgent !== undefined) {
      await handleUrgentMessage(deps, context, handling.urgent)
    } else if (handling.reason === 'non_text_needs_a_person') {
      const filed = await fileDocumentIfBooked(deps, context)
      if (filed === null) await handleNonTextMessage(deps, context)
    } else if (handling.reason === 'human_owns_the_conversation') {
      await acknowledgeWaiting(deps, context)
    } else if (handling.action === 'draft') {
      await greetIfNew(deps, context)
      const outcome = await runConversationTurn(deps, context)
      if (outcome.outcome === 'failed' || outcome.outcome === 'skipped') {
        errors.push(`turn ${outcome.outcome}: ${JSON.stringify(outcome).slice(0, 200)}`)
      }
    }
    turnMs.push(Date.now() - started)
  }

  const lastButtons = async (): Promise<Array<{ id: string; title: string }>> => {
    const [r] = await world.run(
      `select reply_buttons, reply_list from messages where conversation_id = $1 and direction = 'outbound'
       order by created_at desc, (reply_buttons is null and reply_list is null) limit 1`,
      [conversationId],
    )
    const buttons = (r?.['reply_buttons'] as Array<{ id: string; title: string }> | null) ?? []
    const rows = (r?.['reply_list'] as { rows: Array<{ id: string; title: string }> } | null)?.rows ?? []
    return [...buttons, ...rows]
  }

  const maxTurns = persona.maxTurns ?? 18
  for (let turn = 0; turn < maxTurns; turn++) {
    let action: CustomerAction
    try {
      action = await nextAction({ ...input.customerModel, brief: persona.brief, lines })
    } catch (error) {
      errors.push(`customer model: ${error instanceof Error ? error.message : String(error)}`)
      break
    }

    try {
      if ('done' in action) {
        lines.push({ from: 'customer', text: `[leaves: ${action.done}]` })
        break
      }
      if ('wait' in action) {
        lines.push({ from: 'customer', text: '[goes quiet]' })
        // Time passes: whatever chase was scheduled comes due now.
        await world.run(
          `update follow_ups set due_at = now() - interval '1 second'
           where conversation_id = $1 and state = 'scheduled'`, [conversationId])
        const swept = await sendDueFollowUps(world.run, () => undefined)
        if (swept.sent === 0) lines.push({ from: 'customer', text: '[nothing came — no follow-up was sent]' })
        await collect()
        continue
      }
      if ('tap' in action) {
        const options = await lastButtons()
        const chosen = options.find((o) => o.title.toLowerCase() === action.tap.toLowerCase())
        if (chosen === undefined) {
          errors.push(`customer tapped "${action.tap}", which was not offered`)
          lines.push({ from: 'customer', text: action.tap })
          await process(await insert('text', action.tap))
        } else {
          const body = meaningOfButton(chosen.id, chosen.title)
          lines.push({ from: 'customer', text: `[taps "${chosen.title}"]` })
          await process(await insert('text', body))
        }
      } else if ('photo' in action || 'photos' in action) {
        const photos = 'photos' in action ? action.photos : [action.photo]
        lines.push({ from: 'customer', text: `[sends ${photos.length} photo${photos.length === 1 ? '' : 's'}: ${photos.join(', ')}]` })
        // Sent together: like the webhook, only the newest is processed.
        let last = ''
        for (const _ of photos) last = await insert('image', null)
        await process(last)
      } else {
        lines.push({ from: 'customer', text: action.message })
        await process(await insert('text', action.message))
      }
    } catch (error) {
      errors.push(`turn threw: ${error instanceof Error ? error.message : String(error)}`)
    }
    await collect()
  }

  return { persona, lines, errors, turnMs, facts: await factsFor(world.run, conversationId) }
}

async function factsFor(run: QueryRunner, conversationId: string): Promise<RunFacts> {
  const bookingRows = await run(
    `select b.id, b.state::text as state, q.days,
            trim(v.make || ' ' || v.model) as vehicle
     from bookings b join quotes q on q.id = b.quote_id
     left join vehicles v on v.id = q.vehicle_id
     where b.conversation_id = $1 order by b.created_at`,
    [conversationId],
  )
  const bookings: RunFacts['bookings'] = []
  for (const b of bookingRows) {
    const list = b['state'] === 'confirmed'
      ? await bookingChecklist(run, { operatorId: OPERATOR, bookingId: b['id'] as string })
      : null
    bookings.push({
      state: b['state'] as string,
      vehicle: (b['vehicle'] as string) ?? null,
      days: b['days'] == null ? null : Number(b['days']),
      handover: list?.handover ?? null,
      deliveryAddress: list?.deliveryAddress ?? null,
      deliveryTime: list?.deliveryTime ?? null,
      documents: list?.documents ?? 0,
      paymentPlan: list?.paymentPlan ?? null,
      addOns: (list?.addOns ?? []).map((a) => a.label),
    })
  }
  const [quote] = await run(
    `select q.days, q.total_minor, q.discount_minor, trim(v.make || ' ' || v.model) as vehicle from quotes q
     left join vehicles v on v.id = q.vehicle_id
     where q.conversation_id = $1 and q.state <> 'superseded' order by q.revision desc limit 1`,
    [conversationId],
  )
  const held = await run(
    `select 1 from vehicle_availability where held_for_conversation_id = $1 and released_at is null
       and expires_at > now()`, [conversationId])
  const handoffs = await run(`select reason::text as reason, summary from handoffs where conversation_id = $1`, [conversationId])
  const runs = await run(
    `select result_state::text as state, duration_ms, tool_names from agent_runs where conversation_id = $1 order by created_at`,
    [conversationId])
  const outbound = await run(
    `select body, reply_buttons from messages where conversation_id = $1 and direction = 'outbound'
     order by created_at, (reply_image_url is null)`,
    [conversationId])
  /**
   * The truth to hold every figure against: rates and deposits, every quote
   * (and its lines and discount), every payment row and any combination of a
   * booking's rows (rental + deposit, + a chauffeur), extras, published
   * answers, and whatever the customer said themselves.
   */
  const amounts = new Set<string>()
  const addMinor = (minor: unknown) => { if (minor != null) amounts.add(String(Number(minor) / 100)) }
  for (const r of await run(`select daily_rate_minor, deposit_minor, delivery_fee_minor from vehicle_rates`, [])) {
    addMinor(r['daily_rate_minor']); addMinor(r['deposit_minor']); addMinor(r['delivery_fee_minor'])
  }
  for (const q of await run(`select total_minor, deposit_minor, discount_minor, lines from quotes where conversation_id = $1`, [conversationId])) {
    addMinor(q['total_minor']); addMinor(q['deposit_minor']); addMinor(q['discount_minor'])
    if (q['deposit_minor'] != null) addMinor(Number(q['total_minor']) + Number(q['deposit_minor']))
    for (const l of (q['lines'] as Array<{ amountMinor: number }>)) addMinor(Math.abs(l.amountMinor))
  }
  const byBooking = new Map<string, number[]>()
  for (const p of await run(`select booking_id, amount_minor from payments where conversation_id = $1`, [conversationId])) {
    const list = byBooking.get(p['booking_id'] as string) ?? []
    list.push(Number(p['amount_minor']))
    byBooking.set(p['booking_id'] as string, list)
  }
  for (const list of byBooking.values()) {
    for (let mask = 1; mask < 1 << Math.min(list.length, 6); mask++) {
      addMinor(list.reduce((sum, v, i) => (mask & (1 << i) ? sum + v : sum), 0))
    }
  }
  for (const o of await run(`select add_ons from operators`, [])) {
    for (const a of (o['add_ons'] as Array<{ priceMinor: number }> | null) ?? []) addMinor(a.priceMinor)
  }
  const texts = [
    ...(await run(`select answer from knowledge_entries`, [])).map((k) => String(k['answer'])),
    ...(await run(`select body from messages where conversation_id = $1 and direction = 'inbound'`, [conversationId]))
      .map((m) => String(m['body'] ?? '')),
  ]
  for (const t of texts) for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) amounts.add(String(Number(m[0].replace(/,/g, ''))))

  const truth = [
    ...texts,
    // Extras by name: "Extra 100 km" is a product, not a promise about kilometres.
    ...(await run(`select add_ons from operators`, []))
      .flatMap((o) => ((o['add_ons'] as Array<{ name: string }> | null) ?? []).map((a) => a.name)),
    ...(await run(`select start_date::date::text as s, end_date::date::text as e, valid_until::date::text as v
                   from quotes where conversation_id = $1`, [conversationId]))
      .map((q) => `${q['s']} ${q['e']} ${q['v']}`),
    ...(await run(`select start_date, end_date from vehicle_availability`, [])).map((a) => `${a['start_date']} ${a['end_date']}`),
    ...(await run(`select value from field_evidence fe join enquiries e on e.id = fe.enquiry_id
                   where e.conversation_id = $1`, [conversationId])).map((f) => String(f['value'])),
  ]
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())
  truth.push(today, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + 86_400_000)))

  const [conversation] = await run(`select next_action from conversations where id = $1`, [conversationId])
  return {
    bookings,
    latestQuote: quote === undefined ? null : {
      vehicle: (quote['vehicle'] as string) ?? null, days: Number(quote['days']), totalMinor: Number(quote['total_minor']),
      discounted: quote['discount_minor'] != null && Number(quote['discount_minor']) > 0,
    },
    held: held.length > 0,
    handoffs: handoffs.map((h) => ({ reason: h['reason'] as string, summary: String(h['summary'] ?? '') })),
    runs: runs.map((r) => ({
      state: r['state'] as string, ms: Number(r['duration_ms'] ?? 0), tools: String(r['tool_names'] ?? ''),
    })),
    outbound: outbound.map((o) => ({
      body: String(o['body'] ?? ''),
      buttons: ((o['reply_buttons'] as Array<{ title: string }> | null) ?? []).map((b) => b.title),
    })),
    nextAction: (conversation?.['next_action'] as string) ?? null,
    knownAmounts: [...amounts],
    truth,
    today,
  }
}
