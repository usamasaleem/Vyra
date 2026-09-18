import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { scriptedModel, type ModelResponse } from '../../agent/src/turn/model.ts'
import { loadConversationContext, type ConversationContext } from '../src/context.ts'
import {
  acknowledgeWaiting, greetIfNew, handleNonTextMessage, handleUrgentMessage,
  noticeOutOfHours, runConversationTurn,
} from '../src/turn.ts'
import { draftKnowledge, publishKnowledge } from '../../db/src/queries/knowledge.ts'
import {
  acceptHandoff, raiseHandoff, resolveHandoff,
} from '../../db/src/queries/handoff-queue.ts'
import { ensureEnquiry, recordFields } from '../../db/src/queries/enquiry-fields.ts'
import type { QueryRunner, Transactor } from '../../db/src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '33333333-3333-3333-3333-333333333333'
const MEMBER = '44444444-4444-4444-4444-444444444444'
const CONTACT = '55555555-5555-5555-5555-555555555555'
const CONV = '66666666-6666-6666-6666-666666666666'

let db: PGlite
let run: QueryRunner
let transact: Transactor
let context: ConversationContext

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  transact = async (fn) => {
    let out: unknown
    await db.transaction(async (tx) => {
      out = await fn(async (text, params) => (await tx.query(text, params)).rows as Array<Record<string, unknown>>)
    })
    return out as never
  }
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone) values ('${OP}', 'Vyra Pilot', 'Asia/Dubai');
    insert into whatsapp_accounts (id, operator_id, provider_account_id, phone_number_id)
    values ('${ACCOUNT}', '${OP}', 'waba', '111');
    insert into memberships (id, operator_id, user_id, role)
    values ('${MEMBER}', '${OP}', '10000000-0000-0000-0000-000000000001', 'salesperson');
    insert into contacts (id, operator_id, channel_identifier)
    values ('${CONTACT}', '${OP}', '971500000001');
    insert into conversations (id, operator_id, contact_id, whatsapp_account_id)
    values ('${CONV}', '${OP}', '${CONTACT}', '${ACCOUNT}');
  `)
  const rows = await run(
    `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
     values ($1, $2, 'inbound', 'text', 'I need a Ferrari on Friday', 'wamid.1') returning id`,
    [OP, CONV],
  )
  context = (await loadConversationContext(run, rows[0]!['id'] as string))!
})

const REPLIES: ModelResponse[] = [
  {
    toolCalls: [{
      id: 't1', name: 'record_enquiry_fields',
      arguments: { fields: [{ field: 'vehicle', value: 'Ferrari', originalWording: null }] },
    }],
    reply: null,
  },
  { toolCalls: [], reply: 'Lovely — which Friday, and delivery or collection?' },
]

const turn = (script: ModelResponse[], destination: 'send' | 'draft' = 'send', ctx = context) =>
  runConversationTurn(
    { run, transact, model: scriptedModel('test', script), destination },
    ctx,
  )

describe('a turn that works', () => {
  it('queues the reply and records what the customer said', async () => {
    const result = await turn(REPLIES)
    expect(result).toMatchObject({ outcome: 'queued' })

    const [message] = await run(
      `select body, delivery_state::text as state from messages
       where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(message).toMatchObject({
      body: 'Lovely — which Friday, and delivery or collection?', state: 'pending',
    })

    // The tools ran against the real database, not a mock of one.
    const fields = await run(
      `select field::text as field, source_message_id from field_evidence where operator_id = $1`, [OP],
    )
    expect(fields[0]).toMatchObject({ field: 'vehicle', source_message_id: context.message.id })
  })

  it('is safe to retry — a repeated job does not reply twice', async () => {
    await turn(REPLIES)
    await turn(REPLIES)
    const messages = await run(
      `select id from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(1)
  })
})

describe('shadow mode', () => {
  /**
   * The reply becomes an internal note. Section 18.12 keeps notes away from the
   * dispatcher entirely, so a shadow draft is not merely unsent — it has no
   * route to a customer.
   */
  it('writes the reply where a person can read it and a customer cannot', async () => {
    const result = await turn(REPLIES, 'draft')
    expect(result).toMatchObject({ outcome: 'drafted' })

    const notes = await run(`select body, author_membership_id from conversation_notes`, [])
    expect(notes).toHaveLength(1)
    expect(notes[0]!['body']).toContain('which Friday')
    // Nobody wrote it, so nobody is credited with writing it.
    expect(notes[0]!['author_membership_id']).toBeNull()

    const messages = await run(
      `select id from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(0)
  })
})

describe('a turn overtaken while it was thinking', () => {
  it('is discarded when the customer corrects themselves', async () => {
    /**
     * The correction lands *during* the model call, which is the only moment
     * that matters: after the revision was captured and before the reply is
     * accepted. Awaited inside `complete`, so the ordering is guaranteed rather
     * than left to whichever promise settles first.
     */
    const overtaken = {
      label: 'overtaken',
      modelId: 'overtaken:1',
      complete: async () => {
        await db.query(`update conversations set revision = revision + 1 where id = '${CONV}'`)
        return { toolCalls: [], reply: 'Friday is fine!' }
      },
    }
    const result = await runConversationTurn(
      { run, transact, model: overtaken, destination: 'send' }, context,
    )
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'superseded' })

    const messages = await run(
      `select id from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(0)

    const [audit] = await run(
      `select action from audit_events where subject_id = $1 and action = 'turn.rejected'`, [CONV],
    )
    expect(audit).toBeDefined()
  })
})

/**
 * A reply that commits the operator to something the turn did not start.
 *
 * Taken from live traffic: the agent said "I'll get a salesperson to confirm
 * the highest-priced car and its exact rate for you", called no tool, and left
 * nothing behind. The customer waited on a sentence nobody had been told about.
 */
describe('a promise the turn did not keep', () => {
  const promiseWithoutAction = (reply: string): ModelResponse[] => [{ toolCalls: [], reply }]

  it('raises a handoff when the reply promised a person and no tool did', async () => {
    const result = await turn(promiseWithoutAction(
      'I’ll get a salesperson to confirm the highest-priced car and its exact rate for you.',
    ))
    expect(result).toMatchObject({ outcome: 'queued' })

    const [handoff] = await run(
      `select state::text as state, summary from handoffs where conversation_id = $1`, [CONV],
    )
    expect(handoff).toBeDefined()
    // The agent's own words, so whoever picks it up sees what was promised
    // rather than a generic task.
    expect(handoff!['summary']).toContain('salesperson to confirm the highest-priced car')
  })

  it('records outstanding work when the reply promised to check something', async () => {
    const result = await turn(promiseWithoutAction('I’ll check the deposit and come straight back.'))
    expect(result).toMatchObject({ outcome: 'queued' })

    const [conversation] = await run(
      `select next_action from conversations where id = $1`, [CONV],
    )
    expect(conversation!['next_action']).toContain('promised to check')

    // A promise to go and look is not a handoff. The conversation is still the
    // agent's; somebody just has to look something up.
    const handoffs = await run(`select id from handoffs where conversation_id = $1`, [CONV])
    expect(handoffs).toHaveLength(0)
  })

  it('leaves an ordinary reply alone', async () => {
    await turn(promiseWithoutAction('The Rolls-Royce Cullinan is AED 8,000 per day.'))

    const handoffs = await run(`select id from handoffs where conversation_id = $1`, [CONV])
    expect(handoffs).toHaveLength(0)
    const [conversation] = await run(`select next_action from conversations where id = $1`, [CONV])
    expect(conversation!['next_action']).toBeNull()
  })

  /**
   * A tool that already left work behind is the promise being kept. Adding a
   * second task for the same sentence is how a queue stops being read.
   */
  it('does not double up when a tool already recorded the work', async () => {
    const withTool: ModelResponse[] = [
      {
        toolCalls: [{
          id: 't1', name: 'search_vehicles',
          arguments: { vehicle: 'Ferrari', startDate: '2026-10-01', category: null, maxDayRateMinor: null, minSeats: null, order: null, endDate: '2026-10-03' },
        }],
        reply: null,
      },
      { toolCalls: [], reply: 'I’ll check with the team and come straight back.' },
    ]
    await turn(withTool)

    const [conversation] = await run(`select next_action from conversations where id = $1`, [CONV])
    expect(conversation!['next_action']).not.toContain('promised to check')
  })
})

/**
 * The commercial decision reaches a person even when the model does not send it
 * there. Taken from the eval run: asked "can you do 3000 for the weekend
 * instead?", the agent replied "I'll check what we can do for AED 3,000" and
 * called no tool — a negotiation opened with nobody informed.
 */
describe('a customer asking for a discount', () => {
  // Read `context` when called, not when the file loads: beforeEach builds it.
  const askForDiscount = async (body: string) => {
    const [message] = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.discount.${Math.random()}`],
    )
    return {
      ...context,
      message: { ...context.message, id: message!['id'] as string, body },
    }
  }

  it('raises a handoff even when the model called nothing', async () => {
    const ctx = await askForDiscount('can you do 3000 for the weekend instead?')
    const result = await turn(
      [{ toolCalls: [], reply: 'I’ll check what we can do for AED 3,000. Which car?' }],
      'send',
      ctx,
    )
    expect(result).toMatchObject({ outcome: 'queued' })

    const [handoff] = await run(
      `select reason::text as reason, priority::text as priority, summary
       from handoffs where conversation_id = $1`, [CONV],
    )
    // The enum value has existed since the queue was built and nothing wrote it.
    expect(handoff).toMatchObject({ reason: 'discount_requested', priority: 'high' })
    expect(handoff!['summary']).toContain('can you do 3000')
  })

  it('still lets the agent reply, because acknowledging is useful work', async () => {
    const ctx = await askForDiscount('any discount for a week?')
    await turn([{ toolCalls: [], reply: 'Let me put that to the team and come back to you.' }], 'send', ctx)

    const messages = await run(
      `select body from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(1)
  })

  /**
   * One ask, one handoff. The reply also promises a person, and two tasks for
   * one sentence is how a queue stops being read.
   */
  it('raises one handoff, not two, when the reply also promises a person', async () => {
    const ctx = await askForDiscount('can you do 3000 instead?')
    await turn(
      [{ toolCalls: [], reply: 'I’ll get a salesperson to confirm what we can do.' }],
      'send',
      ctx,
    )

    const handoffs = await run(`select id from handoffs where conversation_id = $1`, [CONV])
    expect(handoffs).toHaveLength(1)
  })

  it('leaves an ordinary price question alone', async () => {
    const ctx = await askForDiscount('what is your cheapest car?')
    await turn([{ toolCalls: [], reply: 'The Ferrari 488 Spider is AED 5,000 per day.' }], 'send', ctx)

    const handoffs = await run(`select id from handoffs where conversation_id = $1`, [CONV])
    expect(handoffs).toHaveLength(0)
  })
})

describe('handing over to a person', () => {
  const HANDOFF = [
    {
      toolCalls: [{ id: 't1', name: 'request_handoff', arguments: { reason: 'Customer asked for a person.' } }],
      reply: null,
    },
    { toolCalls: [], reply: "Of course — I'm passing you to a colleague, they'll be with you shortly." },
  ]

  /**
   * The bug the first live test found. The model handed over, which made the
   * conversation human-owned, and the revision check then discarded that same
   * turn's reply as superseded. A customer asked to speak to someone and got
   * silence — the one outcome section 17.6 rules out.
   */
  it('still sends the acknowledgement of the handoff it just performed', async () => {
    const result = await turn(HANDOFF)
    expect(result).toMatchObject({ outcome: 'queued' })

    const [message] = await run(
      `select body, delivery_state::text as state, revision_at_send from messages
       where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(message!['body']).toContain('colleague')
    // Queued at the post-handoff revision, which is what lets the dispatcher
    // tell it apart from a draft written before the handoff.
    expect(message).toMatchObject({ state: 'pending', revision_at_send: 1 })

    const [conversation] = await run(
      `select handler_mode::text as mode, owner_membership_id from conversations where id = $1`, [CONV],
    )
    // Human-owned, but owned by nobody yet: the AI stepped out, no salesperson
    // has stepped in.
    expect(conversation).toMatchObject({ mode: 'human', owner_membership_id: null })
  })

  /** The allowance is one revision wide. A customer message on top is not it. */
  it('is still discarded if the customer also said something meanwhile', async () => {
    const alsoCorrected = {
      label: 'raced', modelId: 'raced:1',
      calls: 0,
      async complete() {
        this.calls++
        if (this.calls === 1) return HANDOFF[0]!
        // A second revision bump, from something that is not this turn.
        await db.query(`update conversations set revision = revision + 1 where id = '${CONV}'`)
        return HANDOFF[1]!
      },
    }
    const result = await runConversationTurn(
      { run, transact, model: alsoCorrected, destination: 'send' }, context,
    )
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'superseded' })
  })
})

/**
 * The gap this closes: the agent told a customer "I'm confirming whether it's
 * available, and I'll also confirm the deposit", and nothing existed anywhere
 * to confirm either. next_action was null, no handoff, no audit event — a
 * salesperson saw an ordinary conversation with nothing marked as needing them.
 */
describe('work the agent promised a person would do', () => {
  const ASKS_POLICY = [
    { toolCalls: [{ id: 't1', name: 'get_operator_policy', arguments: { topic: 'deposit' } }], reply: null },
    { toolCalls: [], reply: "I'll confirm the deposit and come straight back to you." },
  ]

  it('records it where a salesperson will see it', async () => {
    const result = await turn(ASKS_POLICY)
    expect(result).toMatchObject({ outcome: 'queued' })

    const [conversation] = await run(
      `select handler_mode::text as mode, next_action from conversations where id = $1`, [CONV],
    )
    // Still the AI's conversation — it can carry on qualifying.
    expect(conversation).toMatchObject({ mode: 'ai' })
    expect(conversation!['next_action']).toContain('deposit')

    const [audit] = await run(
      `select action, data from audit_events where subject_id = $1
       and action = 'conversation.needs_operator_input'`, [CONV],
    )
    expect((audit!['data'] as Record<string, unknown>)['items']).toEqual([
      'publish an approved answer for "deposit"',
    ])
  })

  /** The point of this design: an unanswered question must not stop the agent. */
  it('does not take the conversation away from the AI', async () => {
    await turn(ASKS_POLICY)
    const [conversation] = await run(
      `select handler_mode::text as mode, owner_membership_id from conversations where id = $1`, [CONV],
    )
    expect(conversation).toMatchObject({ mode: 'ai', owner_membership_id: null })
  })

  it('is idempotent — a retried job leaves one audit event', async () => {
    await turn(ASKS_POLICY)
    await turn(ASKS_POLICY)
    const audits = await run(
      `select id from audit_events where subject_id = $1
       and action = 'conversation.needs_operator_input'`, [CONV],
    )
    expect(audits).toHaveLength(1)
  })

  /**
   * Read from the tool result, not the reply. A turn that forgets to mention
   * the callback leaves the same row behind as one that promises it.
   */
  it('records it even when the reply never mentions it', async () => {
    await turn([
      { toolCalls: [{ id: 't1', name: 'get_operator_policy', arguments: { topic: 'deposit' } }], reply: null },
      { toolCalls: [], reply: 'What dates were you thinking?' },
    ])
    const [conversation] = await run(`select next_action from conversations where id = $1`, [CONV])
    expect(conversation!['next_action']).toContain('deposit')
  })

  it('records nothing when every tool answered', async () => {
    await turn([
      {
        toolCalls: [{
          id: 't1', name: 'record_enquiry_fields',
          arguments: { fields: [{ field: 'vehicle', value: 'Ferrari', originalWording: null }] },
        }],
        reply: null,
      },
      { toolCalls: [], reply: 'Lovely — what dates?' },
    ])
    const [conversation] = await run(`select next_action from conversations where id = $1`, [CONV])
    expect(conversation!['next_action']).toBeNull()
  })

  /** A handoff already puts the whole conversation in front of a person. */
  it('leaves the handoff note alone when the turn handed over', async () => {
    await turn([
      { toolCalls: [{ id: 't1', name: 'get_operator_policy', arguments: { topic: 'deposit' } }], reply: null },
      { toolCalls: [{ id: 't2', name: 'request_handoff', arguments: { reason: 'Customer asked for a person.' } }], reply: null },
      { toolCalls: [], reply: "I'm passing you to a colleague." },
    ])
    const [conversation] = await run(`select next_action from conversations where id = $1`, [CONV])
    expect(conversation!['next_action']).toBe('Customer asked for a person.')
  })
})

describe('a turn that fails', () => {
  it('raises a visible task when the provider is down', async () => {
    const broken = { label: 'broken', modelId: 'broken:1', complete: async () => { throw new Error('503 upstream') } }
    const result = await runConversationTurn(
      { run, transact, model: broken, destination: 'send' }, context,
    )
    expect(result).toMatchObject({ outcome: 'failed', kind: 'provider_error' })

    const [conversation] = await run(
      `select handler_mode::text as mode, priority::text as priority, next_action
       from conversations where id = $1`, [CONV],
    )
    expect(conversation).toMatchObject({ mode: 'human', priority: 'high' })
    expect(conversation!['next_action']).toContain('reply manually')
  })

  it('raises a task when the model says nothing at all', async () => {
    const result = await turn([{ toolCalls: [], reply: null }])
    expect(result).toMatchObject({ outcome: 'failed', kind: 'no_output' })
  })

  /** The customer must not be left in silence because a tool call misfired. */
  it('still replies when its tools refused', async () => {
    const result = await turn([
      { toolCalls: [{ id: 't1', name: 'get_operator_policy', arguments: { topic: 'deposit' } }], reply: null },
      { toolCalls: [], reply: "I'll confirm the deposit and come back to you." },
    ])
    expect(result).toMatchObject({ outcome: 'queued' })
  })
})

/**
 * The customer says yes, and the button says what actually happens.
 *
 * Live: "i want too book this" got a reply asking them to confirm the dates
 * again, and nothing to tap. A "Book now" button would have been worse — it
 * leads to request_booking_review, which is a stub that refuses.
 */
describe('offering to have a booking confirmed', () => {
  const asking = async (body: string): Promise<ConversationContext> => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.${Math.random()}`],
    )
    return (await loadConversationContext(run, rows[0]!['id'] as string))!
  }

  /** Everything section 3 asks for, so there is nothing left to ask. */
  const qualified = async () => {
    const enquiryId = (await ensureEnquiry(run, OP, CONV))!
    await recordFields(transact, {
      operatorId: OP, enquiryId,
      observations: [
        { field: 'vehicle', value: 'Rolls-Royce Cullinan' },
        { field: 'start_at', value: '2026-09-25' },
        { field: 'end_at', value: '2026-09-27' },
        { field: 'delivery_preference', value: 'delivery' },
      ],
    })
  }

  const buttonsOn = async (body: string, reply: string) => {
    const ctx = await asking(body)
    await turn([{ toolCalls: [], reply }], 'send', ctx)
    const [sent] = await run(
      `select reply_buttons from messages where direction = 'outbound'
       and delivery_state = 'pending' order by created_at desc limit 1`, [],
    )
    return sent?.['reply_buttons'] as Array<{ id: string; title: string }> | null
  }

  it('offers them when the enquiry is ready and they say so', async () => {
    await qualified()
    const buttons = await buttonsOn(
      'i want too book this',
      'Got it — the Rolls-Royce Cullinan, 25th to 27th September, delivered.',
    )
    expect(buttons?.map((b) => b.title)).toEqual(['Confirm with team', 'Not just yet'])
  })

  /**
   * Offering to have a booking confirmed before anyone knows the dates is a
   * button that cannot be honoured, and the point of this one is that it can.
   */
  it('stays away while the enquiry is still missing something', async () => {
    const buttons = await buttonsOn('i want to book this', 'Which dates were you thinking?')
    expect(buttons).toBeNull()
  })

  /** Asking how to book is a question, not a decision. */
  it('stays away when they are only asking about booking', async () => {
    await qualified()
    const buttons = await buttonsOn('can i book online?', 'You can book right here with me.')
    expect(buttons).toBeNull()
  })

  /** The reply carries buttons, so it cannot also carry a photograph. */
  it('does not promise a booking in the words on the buttons', async () => {
    await qualified()
    const buttons = await buttonsOn('book it', 'The Cullinan, 25th to 27th September.')
    for (const button of buttons ?? []) expect(button.title).not.toMatch(/\bbook/i)
  })
})

/**
 * The silence after "I've connected you with an agent".
 *
 * Live, that sentence was the last thing a customer heard before asking which
 * colours were available, then "??", then "Hi?", then to change their dates,
 * then who runs the company — five messages into five minutes of nothing,
 * while ai_resumes_after_minutes counted down.
 */
describe('a customer waiting on a person nobody has become', () => {
  const asking = async (body: string): Promise<ConversationContext> => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.${Math.random()}`],
    )
    return (await loadConversationContext(run, rows[0]!['id'] as string))!
  }

  const handedOver = async () => {
    const { handoffId } = await raiseHandoff(run, {
      operatorId: OP, conversationId: CONV, reason: 'customer_asked',
      summary: 'Customer asked for a person.',
    })
    await run(`update conversations set handler_mode = 'human' where id = $1`, [CONV])
    return handoffId!
  }

  const outbound = async () =>
    run(
      `select body from messages where conversation_id = $1 and direction = 'outbound'
       order by created_at`, [CONV],
    )

  it('says something rather than nothing', async () => {
    await handedOver()
    const ctx = await asking('Which colour do you have?')

    const result = await acknowledgeWaiting({ run, transact, destination: 'send' }, ctx)
    expect(result.outcome).toBe('queued')

    const sent = await outbound()
    expect(sent).toHaveLength(1)
    expect(String(sent[0]!['body'])).toContain('colleague')
  })

  /**
   * Once is the whole design. A bot repeating "someone will be with you
   * shortly" is the sound of nobody being there at all.
   */
  it('says it once, however many times they write', async () => {
    await handedOver()
    for (const body of ['Which colour do you have?', '??', 'Hi?', 'Please change my dates ?']) {
      await acknowledgeWaiting({ run, transact, destination: 'send' }, await asking(body))
    }
    expect(await outbound()).toHaveLength(1)
  })

  /**
   * A salesperson who has accepted it is present, and a machine talking over
   * them mid-sentence is worse than the quiet. Section 10's "one handler at a
   * time" is about exactly that; this only fills the gap before the handler
   * exists.
   */
  it('stays quiet once somebody has picked it up', async () => {
    const handoffId = await handedOver()
    await acceptHandoff(run, { handoffId, operatorId: OP, membershipId: MEMBER })

    await acknowledgeWaiting({ run, transact, destination: 'send' }, await asking('Hi?'))
    expect(await outbound()).toEqual([])
  })

  /** A deliberate takeover is a person choosing to be there. */
  it('stays quiet when a person took it over with no handoff', async () => {
    await run(`update conversations set handler_mode = 'human' where id = $1`, [CONV])
    await acknowledgeWaiting({ run, transact, destination: 'send' }, await asking('Hi?'))
    expect(await outbound()).toEqual([])
  })

  /** A new handoff is a new silence, and earns its own line. */
  it('speaks again for a later handoff', async () => {
    const first = await handedOver()
    await acknowledgeWaiting({ run, transact, destination: 'send' }, await asking('Hi?'))
    await resolveHandoff(run, { conversationId: CONV, operatorId: OP, resolution: 'handled' })

    await handedOver()
    await acknowledgeWaiting({ run, transact, destination: 'send' }, await asking('Back again'))

    const sent = await outbound()
    expect(sent).toHaveLength(2)
    expect(first).toBeTruthy()
  })
})

/**
 * The two messages the operator writes and the system sends on its own.
 *
 * Neither is composed, guessed or defaulted — the same rule as a policy
 * answer, for the same reason: this is the operator's voice, and inventing it
 * is the mistake that took a day to undo.
 */
describe('the operator\u2019s own automated messages', () => {
  const publish = async (topic: string, answer: string) => {
    const draft = await draftKnowledge(run, {
      operatorId: OP, topic, answer,
      confirmedBy: 'Owner', confirmedByMembershipId: MEMBER,
    })
    await publishKnowledge(transact, { operatorId: OP, entryId: draft.id, membershipId: MEMBER })
    // Well before the pinned clocks below, which sit in September 2026 and are
    // behind the wall clock these tests run at.
    await run(
      `update knowledge_entries set effective_from = timestamptz '2026-01-01' where id = $1`,
      [draft.id],
    )
  }

  const asking = async (body: string): Promise<ConversationContext> => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.${Math.random()}`],
    )
    return (await loadConversationContext(run, rows[0]!['id'] as string))!
  }

  const sent = async () =>
    (await run(
      `select body from messages where conversation_id = $1 and direction = 'outbound'
       order by created_at`, [CONV],
    )).map((m) => String(m['body']))

  const deps = () => ({ run, transact, destination: 'send' as const })

  describe('the greeting', () => {
    it('says nothing at all until somebody writes one', async () => {
      expect(await greetIfNew(deps(), await asking('hello'))).toBe(false)
      expect(await sent()).toEqual([])
    })

    it('sends the operator\u2019s words, whole', async () => {
      await publish('greeting', 'Thanks for messaging Vyra Rentals.')
      expect(await greetIfNew(deps(), await asking('hello'))).toBe(true)
      expect(await sent()).toEqual(['Thanks for messaging Vyra Rentals.'])
    })

    /**
     * Keyed on the contact, not the conversation: a conversation reopens for
     * years, and being welcomed again in March is being told you are a
     * stranger.
     */
    it('greets each person once, ever', async () => {
      await publish('greeting', 'Thanks for messaging Vyra Rentals.')
      await greetIfNew(deps(), await asking('hello'))
      await greetIfNew(deps(), await asking('still there?'))
      expect(await sent()).toHaveLength(1)
    })
  })

  describe('the out-of-hours notice', () => {
    /** 09:00 to 21:00 every day, Dubai. */
    const nineToNine = JSON.stringify(Object.fromEntries(
      [0, 1, 2, 3, 4, 5, 6].map((d) => [d, { open: '09:00', close: '21:00' }]),
    ))
    const setHours = () =>
      run(`update operators set service_hours = $2::jsonb where id = $1`, [OP, nineToNine])

    const at = (local: string) => new Date(`${local}+04:00`)

    it('says nothing when nobody has set any hours', async () => {
      await publish('out-of-hours', 'We are away from the desk right now.')
      expect(await noticeOutOfHours(deps(), await asking('hi'), at('2026-09-17T03:00'))).toBe(false)
    })

    it('says nothing while they are open', async () => {
      await setHours()
      await publish('out-of-hours', 'We are away from the desk right now.')
      expect(await noticeOutOfHours(deps(), await asking('hi'), at('2026-09-17T14:00'))).toBe(false)
    })

    it('speaks at three in the morning', async () => {
      await setHours()
      await publish('out-of-hours', 'We are away from the desk right now.')
      expect(await noticeOutOfHours(deps(), await asking('hi'), at('2026-09-17T03:00'))).toBe(true)
      expect(await sent()).toEqual(['We are away from the desk right now.'])
    })

    /** Three messages at two in the morning is not three notices. */
    it('says it once a night', async () => {
      await setHours()
      await publish('out-of-hours', 'We are away from the desk right now.')
      for (const body of ['hi', 'hello?', 'anyone there']) {
        await noticeOutOfHours(deps(), await asking(body), at('2026-09-17T03:00'))
      }
      expect(await sent()).toHaveLength(1)
    })

    it('speaks again the following night', async () => {
      await setHours()
      await publish('out-of-hours', 'We are away from the desk right now.')
      await noticeOutOfHours(deps(), await asking('hi'), at('2026-09-17T03:00'))
      await noticeOutOfHours(deps(), await asking('hi again'), at('2026-09-18T03:00'))
      expect(await sent()).toHaveLength(2)
    })

    /** Closed is a claim about somebody else's business. */
    it('stays quiet when the hours are set but the message is not', async () => {
      await setHours()
      expect(await noticeOutOfHours(deps(), await asking('hi'), at('2026-09-17T03:00'))).toBe(false)
      expect(await sent()).toEqual([])
    })
  })
})

/**
 * Section 15's rule, finally attached to something.
 *
 * Holding the turn is only half of it. A customer who has just crashed the car
 * and hears nothing is worse off than one who got a sales reply, so the
 * acknowledgement matters as much as the stop.
 */
describe('a message a rule stopped before the model', () => {
  async function urgent(body: string): Promise<ConversationContext> {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.${Math.random()}`],
    )
    return (await loadConversationContext(run, rows[0]!['id'] as string))!
  }

  const URGENT = { code: 'accident' as const, matched: 'accident', why: 'Possible accident, injury or safety issue' }

  it('answers rather than going quiet, and points at 999 first', async () => {
    const ctx = await urgent('I have had an accident in the Huracán')
    const result = await handleUrgentMessage({ run, transact, destination: 'send' }, ctx, URGENT)
    expect(result).toMatchObject({ outcome: 'needs_a_person', reason: 'safety_or_accident' })

    const [message] = await run(
      `select body, delivery_state::text as state from messages
       where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(message!['body']).toContain('999')
    expect(message).toMatchObject({ state: 'pending' })
  })

  it('raises an urgent task, not an ordinary one', async () => {
    const ctx = await urgent('I have had an accident')
    await handleUrgentMessage({ run, transact, destination: 'send' }, ctx, URGENT)

    const [handoff] = await run(
      `select reason::text as reason, priority::text as priority, summary from handoffs
       where conversation_id = $1`, [CONV],
    )
    expect(handoff).toMatchObject({ reason: 'safety_or_accident', priority: 'urgent' })
    // The customer's own words, so a salesperson can see why it stopped.
    expect(handoff!['summary']).toContain('accident')
  })

  it('takes the conversation away from the agent', async () => {
    const ctx = await urgent('the car broke down')
    await handleUrgentMessage({ run, transact, destination: 'send' }, ctx, URGENT)
    const [conversation] = await run(
      `select handler_mode::text as mode from conversations where id = $1`, [CONV],
    )
    expect(conversation).toMatchObject({ mode: 'human' })
  })

  /** A dispute is not an accident, and must not be told to call the police. */
  it('says something different for a payment dispute', async () => {
    const ctx = await urgent('you charged me twice')
    await handleUrgentMessage({ run, transact, destination: 'send' }, ctx, {
      code: 'payment_dispute', matched: 'charged me twice', why: 'Payment, refund or fraud dispute',
    })

    const [message] = await run(
      `select body from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(message!['body']).not.toContain('999')
    expect(message!['body']).toContain('colleague')
  })

  /**
   * It concedes nothing. The commercial and legal position belongs to a
   * person, and a machine giving it away in the first thirty seconds is its
   * own kind of harm.
   */
  it('does not apologise on the operator\u2019s behalf', async () => {
    const ctx = await urgent('I am speaking to my lawyer')
    await handleUrgentMessage({ run, transact, destination: 'send' }, ctx, {
      code: 'complaint', matched: 'lawyer', why: 'Complaint or legal escalation',
    })

    const [message] = await run(
      `select body from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(message!['body']).not.toMatch(/\b(?:sorry|apologi[sz]e|our fault|we were wrong)\b/i)
  })

  it('acknowledges once, however many times the job is retried', async () => {
    const ctx = await urgent('I have had an accident')
    await handleUrgentMessage({ run, transact, destination: 'send' }, ctx, URGENT)
    await handleUrgentMessage({ run, transact, destination: 'send' }, ctx, URGENT)
    const messages = await run(
      `select id from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(1)
  })
})

/**
 * Build plan step 27. decideHandling always held these, and the comment beside
 * it claimed they were "stored and acknowledged, never silently dropped". Two
 * of three were true: nothing acknowledged and nothing routed, so a voice note
 * was answered with silence by a system that had correctly decided a person
 * was needed.
 */
describe('a message the agent cannot read', () => {
  async function nonText(kind: string): Promise<ConversationContext> {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, provider_id, media)
       values ($1, $2, 'inbound', $3::message_kind, $4, '{"id":"media-1"}'::jsonb) returning id`,
      [OP, CONV, kind, `wamid.${kind}.${Math.random()}`],
    )
    return (await loadConversationContext(run, rows[0]!['id'] as string))!
  }

  it('says something honest rather than nothing', async () => {
    const ctx = await nonText('audio')
    const result = await handleNonTextMessage({ run, transact, destination: 'send' }, ctx)
    expect(result).toMatchObject({ outcome: 'needs_a_person', reason: 'non_text_message' })

    const [message] = await run(
      `select body, delivery_state::text as state from messages
       where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(message!['body']).toContain("can't listen to voice notes")
    expect(message).toMatchObject({ state: 'pending' })
  })

  it('never guesses what was in it', async () => {
    const ctx = await nonText('image')
    await handleNonTextMessage({ run, transact, destination: 'send' }, ctx)
    const [message] = await run(
      `select body from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    // Honest about the limit, and makes no claim about the contents.
    expect(message!['body']).toContain("can't view images")
  })

  it('puts it in front of a person', async () => {
    const ctx = await nonText('audio')
    await handleNonTextMessage({ run, transact, destination: 'send' }, ctx)
    const [conversation] = await run(
      `select handler_mode::text as mode, next_action from conversations where id = $1`, [CONV],
    )
    expect(conversation).toMatchObject({ mode: 'human' })
    // Words, not the enum. "Customer sent a audio" reached a real queue.
    expect(conversation!['next_action']).toContain('a voice note')
    expect(conversation!['next_action']).not.toContain('a audio')
  })

  it('acknowledges once, however many times the job is retried', async () => {
    const ctx = await nonText('document')
    await handleNonTextMessage({ run, transact, destination: 'send' }, ctx)
    await handleNonTextMessage({ run, transact, destination: 'send' }, ctx)
    const messages = await run(
      `select id from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(1)
  })

  it('writes a note instead of sending, in shadow mode', async () => {
    const ctx = await nonText('video')
    await handleNonTextMessage({ run, transact, destination: 'draft' }, ctx)
    const messages = await run(
      `select id from messages where conversation_id = $1 and direction = 'outbound'`, [CONV],
    )
    expect(messages).toHaveLength(0)
    const notes = await run(`select body from conversation_notes`, [])
    expect(notes[0]!['body']).toContain("can't watch videos")
  })
})

describe('no model configured', () => {
  it('skips the turn instead of failing the job', async () => {
    const result = await runConversationTurn(
      { run, transact, model: null, destination: 'send' }, context,
    )
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'no_model_configured' })

    // Nothing raised, nothing queued — a missing key is a configuration state,
    // not an incident.
    expect(await run(`select id from audit_events`, [])).toHaveLength(0)
  })
})

/**
 * The photographs, when the model answers without looking the car up.
 *
 * Which it started doing the moment it was told what this customer had already
 * seen: given that fact in its instructions it replies in one round with no
 * tool call. Faster, and it used to leave the picture path with nothing to
 * work from, because the car was only ever known from a search this turn.
 */
describe('showing a car the model did not look up', () => {
  const PHOTOS = [
    'https://example.com/huracan-1.jpg',
    'https://example.com/huracan-2.jpg',
  ]

  /** A message that already went out carrying one of the car's photographs. */
  const shownAlready = async (url: string) => {
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id,
                             reply_image_url, delivery_state)
       values ($1, $2, 'outbound', 'text', '', $3, $4, 'accepted')`,
      [OP, CONV, `wamid.${Math.random()}`, url],
    )
  }

  const addHuracan = () =>
    run(
      `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                             chassis_number, provenance, confirmed_by, photo_urls)
       values ($1,'Lamborghini','Huracán',2023,'Verde','exotic','D 1','VIN1',
               'operator_confirmed','Owner',$2::jsonb)`,
      [OP, JSON.stringify(PHOTOS)],
    )

  /** The customer's message is what `asksToSeePhotos` reads. */
  const asking = async (body: string) => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.${Math.random()}`],
    )
    return (await loadConversationContext(run, rows[0]!['id'] as string))!
  }

  it('sends the one they have not seen, with no search this turn', async () => {
    await addHuracan()
    await shownAlready(PHOTOS[0]!)
    const ctx = await asking('can i see the lambo')

    await turn([{ toolCalls: [], reply: 'Of course — here is another angle.' }], 'send', ctx)

    const [sent] = await run(
      `select reply_image_url from messages
       where direction = 'outbound' and delivery_state = 'pending'
       order by created_at desc limit 1`, [],
    )
    expect(sent!['reply_image_url']).toBe(PHOTOS[1])
  })

  /**
   * Two cars shown and "send me another angle" names neither.
   *
   * This used to send both, on the reasoning that showing them and asking
   * which is what a person does when handed an ambiguous question. That came
   * from the same mechanism as the fleet line-up, and it does not survive the
   * same objection: a customer who has seen six cars gets six photographs for
   * a question they have not answered yet.
   *
   * So the reply asks which one and sends nothing, and the answer to that
   * question is a selection — which sends that car's photographs, every angle
   * of the one car they actually meant.
   */
  it('sends nothing when two cars have been shown and neither was named', async () => {
    await addHuracan()
    await run(
      `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                             chassis_number, provenance, confirmed_by, photo_urls)
       values ($1,'Ferrari','488',2022,'Rosso','exotic','D 2','VIN2',
               'operator_confirmed','Owner',$2::jsonb)`,
      [OP, JSON.stringify(['https://example.com/ferrari-1.jpg'])],
    )
    await shownAlready(PHOTOS[0]!)
    await shownAlready('https://example.com/ferrari-1.jpg')
    const ctx = await asking('show me another angle')

    await turn([{ toolCalls: [], reply: 'Which one did you mean?' }], 'send', ctx)

    const images = await run(
      `select id from messages
       where direction = 'outbound' and delivery_state = 'pending' and reply_image_url is not null`,
      [],
    )
    expect(images).toEqual([])
  })

  /**
   * And saying which is what makes the photographs findable again: the car has
   * been part-seen, so the restraint rule holds the pictures and the reply
   * points at the message that carried them instead.
   */
  it('points at that car\u2019s photographs once they say which', async () => {
    await addHuracan()
    await shownAlready(PHOTOS[0]!)
    const ctx = await asking('the lambo')

    await turn([{ toolCalls: [], reply: 'The Huracán Tecnica — sent those earlier.' }], 'send', ctx)

    const [sent] = await run(
      `select reply_image_url, quotes_message_id from messages
       where direction = 'outbound' and delivery_state = 'pending'
       order by created_at desc limit 1`, [],
    )
    expect(sent!['reply_image_url']).toBeNull()
    expect(sent!['quotes_message_id']).not.toBeNull()
  })

  /**
   * Without this the fallback would start decorating ordinary replies with
   * photographs of a car mentioned days ago.
   */
  it('attaches nothing when they did not ask to see it', async () => {
    await addHuracan()
    await shownAlready(PHOTOS[0]!)
    const ctx = await asking('what is the deposit?')

    await turn([{ toolCalls: [], reply: 'Let me check the deposit and come back to you.' }], 'send', ctx)

    const [sent] = await run(
      `select reply_image_url from messages
       where direction = 'outbound' and delivery_state = 'pending'
       order by created_at desc limit 1`, [],
    )
    expect(sent!['reply_image_url']).toBeNull()
  })

  /**
   * Every car after the first used to be invisible.
   *
   * The unprompted send was gated on "this conversation has seen no
   * photographs", which reads as restraint and behaves as "only the first car
   * is ever shown". Live: the customer picked the Ferrari off the list an hour
   * after being sent the Lamborghini, and got a paragraph with no picture.
   */
  describe('a second car, after the first has been seen', () => {
    const FERRARI = ['https://example.com/ferrari-1.jpg']

    const addFerrari = () =>
      run(
        `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                               chassis_number, provenance, confirmed_by, photo_urls)
         values ($1,'Ferrari','488',2022,'Giallo','exotic','D 2','VIN2',
                 'operator_confirmed','Owner',$2::jsonb)`,
        [OP, JSON.stringify(FERRARI)],
      )

    it('shows it unasked, even though another car was shown already', async () => {
      await addHuracan()
      await addFerrari()
      await shownAlready(PHOTOS[0]!)
      const ctx = await asking('Ferrari 488, please.')

      await turn(
        [{ toolCalls: [], reply: 'The Ferrari 488 — Giallo Modena, AED 5,000 per day.' }],
        'send', ctx,
      )

      const [sent] = await run(
        `select reply_image_url from messages
         where direction = 'outbound' and delivery_state = 'pending'
         order by created_at desc limit 1`, [],
      )
      expect(sent!['reply_image_url']).toBe(FERRARI[0])
    })

    /**
     * "or mentioned if already sent" — the other half.
     *
     * Picking a car they have already been shown sends nothing, correctly. What
     * it should not do is leave them scrolling: the reply quotes the message
     * that carried those photographs, so tapping it jumps there.
     */
    it('points at the photographs when they pick a car they have seen', async () => {
      await addHuracan()
      const [shown] = await run(
        `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id,
                               reply_image_url, delivery_state)
         values ($1, $2, 'outbound', 'text', '', $3, $4, 'accepted') returning id`,
        [OP, CONV, `wamid.${Math.random()}`, PHOTOS[0]],
      )
      await run(
        `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id,
                               reply_image_url, delivery_state)
         values ($1, $2, 'outbound', 'text', '', $3, $4, 'accepted')`,
        [OP, CONV, `wamid.${Math.random()}`, PHOTOS[1]],
      )
      const ctx = await asking('the lambo please')

      await turn([{ toolCalls: [], reply: 'The Huracán Tecnica it is.' }], 'send', ctx)

      const [sent] = await run(
        `select reply_image_url, quotes_message_id from messages
         where direction = 'outbound' and delivery_state = 'pending'
         order by created_at desc limit 1`, [],
      )
      expect(sent!['reply_image_url']).toBeNull()
      // The second message is the one that carried the most recent photograph.
      expect(sent!['quotes_message_id']).not.toBeNull()
      expect(sent!['quotes_message_id']).not.toBe(shown!['id'])
    })

    /**
     * Shown the Lamborghini and then the Ferrari, "the lambo please" used to
     * quote the Ferrari — photosShown is most-recent-first and the code took
     * `[0]` regardless of which car the turn was about.
     */
    it('points at this car\u2019s photographs, not the last car\u2019s', async () => {
      await addHuracan()
      await addFerrari()
      await shownAlready(PHOTOS[0]!)
      await shownAlready(PHOTOS[1]!)
      const [ferrariMessage] = await run(
        `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id,
                               reply_image_url, delivery_state)
         values ($1, $2, 'outbound', 'text', '', $3, $4, 'accepted') returning id`,
        [OP, CONV, `wamid.${Math.random()}`, FERRARI[0]],
      )
      const ctx = await asking('the lambo please')

      await turn([{ toolCalls: [], reply: 'The Huracán Tecnica it is.' }], 'send', ctx)

      const [sent] = await run(
        `select quotes_message_id from messages
         where direction = 'outbound' and delivery_state = 'pending'
         order by created_at desc limit 1`, [],
      )
      expect(sent!['quotes_message_id']).not.toBe(ferrariMessage!['id'])
    })

    /**
     * A WhatsApp message carries an image or an interactive, never both.
     *
     * It used to be the buttons that won, which was invisible while the button
     * patterns matched one reply in ninety-eight. Widening them surfaced it: a
     * customer who had just picked the Ferrari off the list would have lost its
     * photographs to two buttons.
     */
    it('keeps the photographs and drops the buttons', async () => {
      await addHuracan()
      await addFerrari()
      await shownAlready(PHOTOS[0]!)
      const ctx = await asking('Ferrari 488, please.')

      await turn([{
        toolCalls: [],
        reply: 'The Ferrari 488 — AED 5,000 per day. Still looking at 19th to 21st September?',
      }], 'send', ctx)

      const [sent] = await run(
        `select reply_image_url, reply_buttons from messages
         where direction = 'outbound' and delivery_state = 'pending'
         order by created_at desc limit 1`, [],
      )
      expect(sent!['reply_image_url']).toBe(FERRARI[0])
      expect(sent!['reply_buttons']).toBeNull()
    })

    /** And the buttons still arrive when there is no picture to displace. */
    it('keeps the buttons when no photograph is going out', async () => {
      await addHuracan()
      await shownAlready(PHOTOS[0]!)
      await shownAlready(PHOTOS[1]!)
      const ctx = await asking('the lambo please')

      await turn([{
        toolCalls: [],
        reply: 'The Huracán Tecnica. Still looking at 19th to 21st September?',
      }], 'send', ctx)

      const [sent] = await run(
        `select reply_image_url, reply_buttons from messages
         where direction = 'outbound' and delivery_state = 'pending'
         order by created_at desc limit 1`, [],
      )
      expect(sent!['reply_image_url']).toBeNull()
      expect(sent!['reply_buttons']).not.toBeNull()
    })

    /** Restraint intact: the same car twice unasked is what a bot does. */
    it('does not show the same car again unasked', async () => {
      await addHuracan()
      await shownAlready(PHOTOS[0]!)
      await shownAlready(PHOTOS[1]!)
      const ctx = await asking('the lambo please')

      await turn([{ toolCalls: [], reply: 'The Huracán Tecnica it is.' }], 'send', ctx)

      const [sent] = await run(
        `select reply_image_url from messages
         where direction = 'outbound' and delivery_state = 'pending'
         order by created_at desc limit 1`, [],
      )
      expect(sent!['reply_image_url']).toBeNull()
    })
  })
})

/**
 * v12 lets the model use WhatsApp's formatting, which means it will sometimes
 * reach for Markdown's. Repaired on the way out rather than argued about in
 * the instructions.
 */
describe('a reply written with Markdown in it', () => {
  it('sends one asterisk where the model wrote two', async () => {
    await turn([{ toolCalls: [], reply: 'The **Huracán Tecnica** is AED 5,500 per day.' }])

    const [sent] = await run(
      `select body from messages where direction = 'outbound' order by created_at desc limit 1`, [],
    )
    expect(sent!['body']).toBe('The *Huracán Tecnica* is AED 5,500 per day.')
  })

  /** A reply is a person's words; rewriting them is not something this does. */
  it('leaves an ordinary reply exactly as written', async () => {
    const reply = 'Nice choice — the yellow one is the 488 Spider.'
    await turn([{ toolCalls: [], reply }])

    const [sent] = await run(
      `select body from messages where direction = 'outbound' order by created_at desc limit 1`, [],
    )
    expect(sent!['body']).toBe(reply)
  })
})

/**
 * Showing a fleet rather than a car.
 *
 * "What have you got?" sent a tappable list of names and no pictures at all,
 * because the photo path wants exactly one vehicle. True, and the wrong answer:
 * it is not one picture, it is one picture each.
 */
describe('a reply about several cars', () => {
  const HURACAN = 'https://example.com/huracan.jpg'
  const FERRARI = 'https://example.com/ferrari.jpg'

  const addCars = async () => {
    await run(
      `insert into vehicles (operator_id, make, model, variant, year, colour, category, plate,
                             chassis_number, provenance, confirmed_by, photo_urls)
       values ($1,'Lamborghini','Huracán','Tecnica',2023,'Verde','exotic','D 1','VIN1',
               'operator_confirmed','Owner',$2::jsonb),
              ($1,'Ferrari','488',null,2022,'Rosso','exotic','D 2','VIN2',
               'operator_confirmed','Owner',$3::jsonb)`,
      [OP, JSON.stringify([HURACAN]), JSON.stringify([FERRARI])],
    )
  }

  /** A turn that looked the fleet up, so the reply is about several cars. */
  const searched = (reply: string): ModelResponse[] => [
    {
      toolCalls: [{
        id: 't1', name: 'search_vehicles',
        arguments: {
          vehicle: null, startDate: null, category: null, maxDayRateMinor: null,
          minSeats: null, order: null, endDate: null,
        },
      }],
      reply: null,
    },
    { toolCalls: [], reply },
  ]

  const asking = async (body: string) => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.${Math.random()}`],
    )
    return (await loadConversationContext(run, rows[0]!['id'] as string))!
  }

  /**
   * There used to be a line-up here: one photograph per car, captioned, sent
   * after the list. It was right for a fleet of three and wrong for a fleet of
   * thirty — capped at six it still buries the question under six image
   * bubbles, and the question is the thing that moves the sale along.
   *
   * The list is the browse. A photograph is the detail view, and it arrives
   * when somebody picks a car.
   */
  it('sends the list and no photographs', async () => {
    await addCars()
    const ctx = await asking('show me your cars')

    await turn(searched('We have two that would suit — which one takes your fancy?'), 'send', ctx)

    const [reply] = await run(
      `select reply_list, reply_image_url from messages
       where direction = 'outbound' and reply_list is not null`, [],
    )
    expect(reply!['reply_list']).not.toBeNull()
    expect(reply!['reply_image_url']).toBeNull()

    const images = await run(
      `select id from messages where direction = 'outbound' and reply_image_url is not null`, [],
    )
    expect(images).toEqual([])
  })

  it('sends that car\u2019s photographs once they pick one', async () => {
    await addCars()
    const ctx = await asking('Ferrari 488, please.')

    await turn([{ toolCalls: [], reply: 'The Ferrari 488 — a fine choice.' }], 'send', ctx)

    const [sent] = await run(
      `select reply_image_url from messages
       where direction = 'outbound' and delivery_state = 'pending'
       order by created_at desc limit 1`, [],
    )
    expect(sent!['reply_image_url']).toBe(FERRARI)
  })
})

/**
 * A way out for a fleet the conversation cannot hold.
 *
 * Attached because the reply offered it, not because we decided to — the model
 * judges the fleet is bigger than the thread and says so, and this makes the
 * sentence true. A link is an exit: tested on a real device, the button opens
 * the phone's default browser as a separate app.
 */
describe('pointing at the whole range', () => {
  /**
   * Reloaded, because the context is read once at the top of the turn and the
   * fixture built it before this test changed anything.
   */
  const withWebsite = async (url: string | null) => {
    await run(`update operators set website_url = $1 where id = $2`, [url, OP])
    context = (await loadConversationContext(run, context.message.id))!
  }

  const lastSent = async () =>
    (await run(
      `select body, reply_link from messages where direction = 'outbound'
       order by created_at desc limit 1`, [],
    ))[0]!

  it('attaches the link when the reply offers the full range', async () => {
    await withWebsite('https://example.com/fleet')

    await turn([{ toolCalls: [], reply: 'You can see our full range here.' }])

    expect((await lastSent())['reply_link'])
      .toEqual({ label: 'See all our cars', url: 'https://example.com/fleet' })
  })

  /**
   * A link offered to somebody who did not ask costs the conversation they
   * were already having.
   */
  it('attaches nothing to an ordinary reply', async () => {
    await withWebsite('https://example.com/fleet')

    await turn([{ toolCalls: [], reply: 'The Huracán is AED 5,500 per day.' }])

    expect((await lastSent())['reply_link']).toBeNull()
  })

  /**
   * With no website the reply is still a sentence rather than a broken
   * promise, which is the right failure of the two available.
   */
  it('sends the reply without a link when the operator has no website', async () => {
    await withWebsite(null)

    await turn([{ toolCalls: [], reply: 'You can see our full range here.' }])

    const sent = await lastSent()
    expect(sent['reply_link']).toBeNull()
    expect(sent['body']).toBe('You can see our full range here.')
  })

  it('refuses an address that is not https', async () => {
    await withWebsite('http://example.com/fleet')

    await turn([{ toolCalls: [], reply: 'You can see our full range here.' }])

    expect((await lastSent())['reply_link']).toBeNull()
  })
})

/**
 * The fleet, looked up before the model is asked anything.
 *
 * Measured: 4.5 seconds with no tool call, 7.6 with one, because a tool call
 * means a second trip to the model. Nearly every one of those was
 * search_vehicles with no filters — a question answerable while the model was
 * still being asked.
 */
describe('looking the fleet up in advance', () => {
  const addHuracan = () =>
    run(
      `insert into vehicles (operator_id, make, model, variant, year, colour, category, plate,
                             chassis_number, provenance, confirmed_by)
       values ($1,'Lamborghini','Huracán','Tecnica',2023,'Verde','exotic','D 1','VIN1',
               'operator_confirmed','Owner')`,
      [OP],
    )

  const asking = async (body: string) => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.${Math.random()}`],
    )
    return (await loadConversationContext(run, rows[0]!['id'] as string))!
  }

  /**
   * Captured rather than asserted on the reply, because what matters is what
   * the model was given before it said anything.
   */
  const systemFor = async (body: string) => {
    let system: string | undefined
    const ctx = await asking(body)
    await runConversationTurn(
      {
        run,
        transact,
        destination: 'send',
        model: {
          modelId: 'test',
          label: 'test',
          complete: async (request) => {
            system = request.system
            return { toolCalls: [], reply: 'Noted.' }
          },
        },
      },
      ctx,
    )
    return system ?? ''
  }

  /**
   * Asserted on the marker rather than on a car's name: the few-shot examples
   * mention a Huracán too, so searching the whole prompt for one proves
   * nothing. The first version of this test passed for that reason.
   */
  const MARKER = 'looked up for you already'

  it('hands the fleet over for a message about cars', async () => {
    await addHuracan()
    const system = await systemFor('show me your cars')
    expect(system).toContain(MARKER)
    expect(system.slice(system.indexOf(MARKER))).toContain('Huracán')
  })

  /**
   * The tool's own output, guidance and all. That guidance is where "you have
   * NOT checked whether any of them is free" lives, and a fleet handed over
   * without it is a list of cars with nothing stopping the model calling them
   * available.
   */
  it('carries the guidance with it, not just the cars', async () => {
    await addHuracan()
    const system = await systemFor('show me your cars')
    expect(system).toContain('NOT checked')
  })

  /** Being wrong the other way costs a database read; being wrong here costs nothing. */
  it('does not bother for a message about something else', async () => {
    await addHuracan()
    expect(await systemFor('what is the deposit?')).not.toContain(MARKER)
  })

  it('says nothing when the operator has no cars', async () => {
    expect(await systemFor('show me your cars')).not.toContain(MARKER)
  })
})

/**
 * The shape of a reply about several cars, which a real conversation showed
 * coming apart.
 *
 * "show me your cars" came back as a paragraph naming all three, no tappable
 * list, and one photograph — of the Lamborghini, because it is the only car
 * with any. Three separate faults, all downstream of the same thing: the
 * prefetch means no tool call, and every surface was built from tool results.
 */
describe('answering about several cars after a prefetch', () => {
  const addCars = async (photographed: number) => {
    const cars = [
      ['Rolls-Royce', 'Cullinan', 'suv'],
      ['Lamborghini', 'Huracán', 'exotic'],
      ['Ferrari', '488', 'exotic'],
    ] as const
    for (const [i, [make, model, category]] of cars.entries()) {
      await run(
        `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                               chassis_number, provenance, confirmed_by, photo_urls)
         values ($1,$2,$3,2023,'Black',$4::vehicle_category,'P'||$5,'V'||$5,
                 'operator_confirmed','Owner',$6::jsonb)`,
        [OP, make, model, category, i,
         i < photographed ? JSON.stringify([`https://example.com/${i}.jpg`]) : null],
      )
    }
  }

  const asking = async (body: string) => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.${Math.random()}`],
    )
    return (await loadConversationContext(run, rows[0]!['id'] as string))!
  }

  /**
   * The list used to be built only from what the tools returned, so a turn
   * that answered from the prefetch offered nothing to tap.
   */
  it('still offers the tappable list when no tool ran', async () => {
    await addCars(0)
    const ctx = await asking('show me your cars')

    await turn([{ toolCalls: [], reply: 'Three of them — which one takes your fancy?' }], 'send', ctx)

    const [reply] = await run(
      `select reply_list from messages where direction = 'outbound' and reply_list is not null`, [],
    )
    expect(reply).toBeDefined()
  })

  /**
   * One photograph under a reply that named three cars is not a line-up, it is
   * a favourite — and the car with pictures is the only one anybody sees.
   */
  it('shows no photographs at all when only one car has any', async () => {
    await addCars(1)
    const ctx = await asking('show me your cars')

    await turn([{ toolCalls: [], reply: 'Three of them — which one takes your fancy?' }], 'send', ctx)

    const images = await run(
      `select id from messages where direction = 'outbound' and reply_image_url is not null`, [],
    )
    expect(images).toEqual([])
  })

  /**
   * The line-up is gone. Six image bubbles under one question is a fleet of
   * three being shown off; for the operator with thirty cars it is the reply
   * burying the question.
   *
   * The list is the browse and a photograph is the detail view — the pictures
   * arrive when somebody picks a car, which is when they have shown they want
   * to look.
   */
  it('sends no photographs with the list, however many cars have them', async () => {
    await addCars(3)
    const ctx = await asking('show me your cars')

    await turn([{ toolCalls: [], reply: 'Three of them — which one takes your fancy?' }], 'send', ctx)

    const images = await run(
      `select id from messages where direction = 'outbound' and reply_image_url is not null`, [],
    )
    expect(images).toEqual([])
  })

  it('sends that car\u2019s photographs when they pick one off the list', async () => {
    await addCars(3)
    const ctx = await asking('Ferrari 488, please.')

    await turn(
      [{ toolCalls: [], reply: 'The Ferrari 488 — a fine choice.' }], 'send', ctx,
    )

    const [sent] = await run(
      `select reply_image_url from messages
       where direction = 'outbound' and delivery_state = 'pending'
       order by created_at desc limit 1`, [],
    )
    expect(sent!['reply_image_url']).toBe('https://example.com/2.jpg')
  })
})

/**
 * The exchange that found this: "lambo", then "can you send again", and no
 * photographs either time.
 *
 * The prefetch is unfiltered, so the fleet is every car whenever no tool runs
 * — and "is this exactly one car" is then always no. The reply knew which car
 * it was about; nothing was reading it.
 */
describe('a car named only in the reply', () => {
  const addCars = async () => {
    for (const [i, [make, model, photos]] of ([
      ['Rolls-Royce', 'Cullinan', null],
      ['Lamborghini', 'Huracán', ['https://example.com/h1.jpg', 'https://example.com/h2.jpg']],
      ['Ferrari', '488', null],
    ] as const).entries()) {
      await run(
        `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                               chassis_number, provenance, confirmed_by, photo_urls)
         values ($1,$2,$3,2023,'Black','exotic','P'||$4,'V'||$4,
                 'operator_confirmed','Owner',$5::jsonb)`,
        [OP, make, model, i, photos === null ? null : JSON.stringify(photos)],
      )
    }
  }

  const asking = async (body: string) => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.${Math.random()}`],
    )
    return (await loadConversationContext(run, rows[0]!['id'] as string))!
  }

  const imagesSent = () =>
    run(
      `select reply_image_url from messages
       where direction = 'outbound' and delivery_state = 'pending' and reply_image_url is not null`,
      [],
    )

  it('sends the photographs of the car the reply named', async () => {
    await addCars()
    const ctx = await asking('lambo')

    await turn([{ toolCalls: [], reply: 'The green Lamborghini Huracán Tecnica — here you go.' }], 'send', ctx)

    expect(await imagesSent()).toHaveLength(2)
  })

  /**
   * "Sure — I'll get the photos resent" went to a customer who had just asked
   * for exactly that, and nothing followed it. Sending is something this turn
   * can do now, so a reply that says it will is a reply that should have.
   */
  it('keeps a promise to send them again', async () => {
    await addCars()
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id,
                             reply_image_url, delivery_state)
       values ($1, $2, 'outbound', 'text', '', $3, $4, 'accepted')`,
      [OP, CONV, 'wamid.old', 'https://example.com/h1.jpg'],
    )
    const ctx = await asking('can you send again')

    await turn(
      [{ toolCalls: [], reply: 'Sure — I’ll get the Huracán photos resent, with a few angles.' }],
      'send', ctx,
    )

    expect((await imagesSent()).length).toBeGreaterThan(0)
  })

  /** Two cars named is not one car named, and guessing is worse than asking. */
  it('sends nothing when the reply names more than one', async () => {
    await addCars()
    const ctx = await asking('what have you got')

    await turn(
      [{ toolCalls: [], reply: 'The Cullinan, the Huracán and the 488 — which one?' }],
      'send', ctx,
    )

    expect(await imagesSent()).toEqual([])
  })
})

/**
 * What the turn writes down without being asked.
 *
 * Five days into a ninety-four message conversation the enquiry still said
 * "Lamborghini Huracán Tecnica, 16 September to 5 October" — recorded in a
 * two-minute burst on the first evening and never touched again, while the
 * customer had since asked for a Cullinan. Seven of forty-seven turns recorded
 * anything at all, and prepare_quote prices from these fields.
 */
describe('what a turn remembers about the enquiry', () => {
  const addCars = async () => {
    for (const [i, [make, model]] of ([
      ['Lamborghini', 'Huracán'], ['Rolls-Royce', 'Cullinan'],
    ] as const).entries()) {
      await run(
        `insert into vehicles (operator_id, make, model, year, colour, category, plate,
                               chassis_number, provenance, confirmed_by)
         values ($1,$2,$3,2023,'Black','exotic','P'||$4,'V'||$4,'operator_confirmed','Owner')`,
        [OP, make, model, i],
      )
    }
  }

  const asking = async (body: string) => {
    const rows = await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id)
       values ($1, $2, 'inbound', 'text', $3, $4) returning id`,
      [OP, CONV, body, `wamid.${Math.random()}`],
    )
    return (await loadConversationContext(run, rows[0]!['id'] as string))!
  }

  const vehicleOnFile = async () =>
    (await run(
      `select value from field_evidence where field = 'vehicle' and superseded_at is null`, [],
    ))[0]?.['value'] ?? null

  /** Filling a field nobody has filled, which is the gap this started as. */
  it('records the car it just talked about when nothing is on file', async () => {
    await addCars()
    const ctx = await asking('the lambo')

    await turn([{ toolCalls: [], reply: 'The Lamborghini Huracán — a lovely thing.' }], 'send', ctx)

    expect(await vehicleOnFile()).toBe('Lamborghini Huracán')
  })

  /**
   * The failure this exists for: a customer who moves from one car to another
   * and an enquiry that still names the first.
   */
  it('supersedes the car when the customer settles on another', async () => {
    await addCars()
    await turn(
      [{ toolCalls: [], reply: 'The Lamborghini Huracán — a lovely thing.' }],
      'send', await asking('the lambo'),
    )
    await turn(
      [{ toolCalls: [], reply: 'The Rolls-Royce Cullinan it is.' }],
      'send', await asking('actually the cullinan'),
    )

    expect(await vehicleOnFile()).toBe('Rolls-Royce Cullinan')
    // Superseded rather than overwritten: what they said first is still there.
    const history = await run(`select value from field_evidence where field = 'vehicle'`, [])
    expect(history).toHaveLength(2)
  })

  /**
   * The correction that came from watching it run. Across four messages the
   * enquiry went Huracán, Cullinan, then back to Huracán — the last because
   * somebody asked "it's popular as compared to lambo?" and the lambo got
   * looked up. A comparison is not a choice.
   */
  it('does not change the car because one was mentioned in passing', async () => {
    await addCars()
    await turn(
      [{ toolCalls: [], reply: 'The Rolls-Royce Cullinan it is.' }],
      'send', await asking('actually the cullinan'),
    )
    await turn(
      [{ toolCalls: [], reply: 'The Cullinan is the more popular of the two.' }],
      'send', await asking('is it popular compared to the lambo?'),
    )

    expect(await vehicleOnFile()).toBe('Rolls-Royce Cullinan')
  })

  /** Asking to see a car is browsing, not picking. */
  it('does not change the car because they asked to see another', async () => {
    await addCars()
    await turn(
      [{ toolCalls: [], reply: 'The Rolls-Royce Cullinan it is.' }],
      'send', await asking('actually the cullinan'),
    )
    await turn(
      [{ toolCalls: [], reply: 'Here is the Huracán.' }],
      'send', await asking('can i see the lambo'),
    )

    expect(await vehicleOnFile()).toBe('Rolls-Royce Cullinan')
  })

  /** A reply about no car in particular establishes nothing. */
  it('records nothing when the turn was not about one car', async () => {
    await addCars()
    const ctx = await asking('what is the deposit?')

    await turn([{ toolCalls: [], reply: 'Let me check that for you.' }], 'send', ctx)

    expect(await vehicleOnFile()).toBeNull()
  })

  /** Every conversation sat at 'new' however far it had got. */
  it('moves the conversation off new', async () => {
    await addCars()
    const ctx = await asking('the lambo')

    await turn([{ toolCalls: [], reply: 'The Lamborghini Huracán — a lovely thing.' }], 'send', ctx)

    const [conversation] = await run(
      `select sales_stage::text as stage from conversations where id = $1`, [CONV],
    )
    expect(conversation!['stage']).not.toBe('new')
  })
})

/**
 * Coming back to a question that went unanswered.
 *
 * Live, the agent asked "what dates are you considering?", the customer asked
 * four questions of their own instead, and it answered all four and never came
 * back. Nine exchanges qualified nothing, because nothing told it there was
 * anything outstanding.
 */
describe('chasing what the enquiry still needs', () => {
  const systemFor = async () => {
    let system: string | undefined
    await runConversationTurn(
      {
        run, transact, destination: 'send',
        model: {
          modelId: 'test', label: 'test',
          complete: async (request) => {
            system = request.system
            return { toolCalls: [], reply: 'Noted.' }
          },
        },
      },
      context,
    )
    return system ?? ''
  }

  const askedFor = async () =>
    (await run(`select asked_for from conversations where id = $1`, [CONV]))[0]!['asked_for'] as
      Record<string, { times: number }>

  it('tells the model what is still missing', async () => {
    expect(await systemFor()).toContain('This enquiry still needs')
  })

  /** One question at the end of a reply, never a list of them. */
  it('puts only one of them at a time', async () => {
    const system = await systemFor()
    expect(system).toContain('never more than one')
  })

  it('remembers that it asked', async () => {
    await systemFor()
    expect(Object.keys(await askedFor())).toHaveLength(1)
  })

  /** Asking the same thing twice in a row is a form rather than a person. */
  it('does not put the same question again on the very next turn', async () => {
    await systemFor()
    const [field] = Object.keys(await askedFor())

    await systemFor()
    expect((await askedFor())[field!]!.times).toBe(1)
  })

  it('says nothing when the enquiry needs nothing', async () => {
    // The enquiry is created by the turn, so it has to exist before anything
    // can be recorded against it.
    const enquiryId = (await ensureEnquiry(run, OP, CONV))!

    await recordFields(transact, {
      operatorId: OP, enquiryId,
      observations: [
        { field: 'vehicle', value: 'Ferrari 488' },
        { field: 'start_at', value: '2026-09-25' },
        { field: 'end_at', value: '2026-09-28' },
        { field: 'delivery_preference', value: 'delivery' },
      ],
    })

    expect(await systemFor()).not.toContain('This enquiry still needs')
  })

  /**
   * The other half.
   *
   * v15 told the model what was missing. Nothing told it what was not, and the
   * customer noticed before we did: "don't you already know the dayes", with
   * the dates sitting in field_evidence from the night before.
   */
  describe('and what it already knows', () => {
    const remember = async (observations: Array<{ field: string; value: string }>) => {
      const enquiryId = (await ensureEnquiry(run, OP, CONV))!
      await recordFields(transact, {
        operatorId: OP,
        enquiryId,
        observations: observations as Parameters<typeof recordFields>[1]['observations'],
      })
      return enquiryId
    }

    it('says nothing when the enquiry knows nothing', async () => {
      expect(await systemFor()).not.toContain('This enquiry already has')
    })

    it('hands back what the customer has already said', async () => {
      await remember([{ field: 'vehicle', value: 'Lamborghini Huracán Tecnica' }])

      const system = await systemFor()
      expect(system).toContain('This enquiry already has')
      expect(system).toContain('they want the Lamborghini Huracán Tecnica')
    })

    /**
     * The exact sentence that went out live, as a test.
     */
    it('leaves no room for "I have no record of the dates"', async () => {
      await remember([
        { field: 'start_at', value: '2026-09-19' },
        { field: 'duration', value: '2 days' },
      ])

      const system = await systemFor()
      expect(system).toContain('do not say you have no record of them')
      expect(system).toContain('do not ask for them again')
    })

    /**
     * A stored date is 2026-09-19, and a model handed that says it back. That
     * is how an ISO date ended up in a quote reading like a receipt.
     */
    it('renders a date the way a person says it', async () => {
      await remember([{ field: 'start_at', value: '2026-09-19' }])

      const system = await systemFor()
      expect(system).toContain('19 September')
      expect(system).not.toContain('2026-09-19')
    })

    it('passes through a value that is not a date', async () => {
      await remember([{ field: 'duration', value: '2 days' }])
      expect(await systemFor()).toContain('it runs 2 days')
    })

    /**
     * A value from yesterday is worth confirming; one from this morning is not.
     * Without the when, a stale date is asserted as confidently as a fresh one.
     */
    it('says when each was said', async () => {
      await remember([{ field: 'vehicle', value: 'Ferrari 488' }])
      expect(await systemFor()).toMatch(/they said so (earlier today|yesterday|on \w+)/)
    })

    /**
     * Four facts from one conversation carried the clause four times. A prompt
     * that repeats a phrase is a reply that repeats it — which is how "7 photos
     * on the 15th" went out three times in six minutes from one instruction.
     */
    it('says it once when everything was said the same day', async () => {
      await remember([
        { field: 'vehicle', value: 'Ferrari 488' },
        { field: 'start_at', value: '2026-09-25' },
        { field: 'delivery_preference', value: 'delivery' },
      ])

      const system = await systemFor()
      expect(system.split('they said so').length - 1).toBe(1)
      // In the order an enquiry is built up, not alphabetically — which would
      // put delivery before the car and read like a form being read out.
      expect(system).toContain(
        'they want the Ferrari 488; it starts Friday 25 September; they want delivery',
      )
    })

    it('forgets a value the customer replaced', async () => {
      await remember([{ field: 'vehicle', value: 'Ferrari 488' }])
      await remember([{ field: 'vehicle', value: 'Rolls-Royce Cullinan' }])

      const system = await systemFor()
      expect(system).toContain('they want the Rolls-Royce Cullinan')
      expect(system).not.toContain('they want the Ferrari 488')
    })

    /** A memory is a nicety. A reply is not. */
    it('still replies when the recall fails', async () => {
      await remember([{ field: 'vehicle', value: 'Ferrari 488' }])
      // Precisely the recall path: `original_wording` is read by
      // getEnquiryFields and by nothing ensureEnquiry needs, so the enquiry is
      // still found and only the memory is lost.
      await run(`alter table field_evidence drop column original_wording`, [])

      const system = await systemFor()
      expect(system).not.toContain('This enquiry already has')
      const [last] = await run(
        `select body from messages where conversation_id = $1 and direction = 'outbound'
         order by created_at desc limit 1`, [CONV],
      )
      expect(last!['body']).toBe('Noted.')
    })
  })
})
