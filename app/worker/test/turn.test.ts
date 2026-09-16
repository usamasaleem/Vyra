import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { scriptedModel, type ModelResponse } from '../../agent/src/turn/model.ts'
import { loadConversationContext, type ConversationContext } from '../src/context.ts'
import { handleNonTextMessage, runConversationTurn } from '../src/turn.ts'
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
          arguments: { vehicle: 'Ferrari', startDate: '2026-10-01', endDate: '2026-10-03' },
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
   * Two cars shown and "send me another angle" names neither. Guessing the most
   * recent would be a guess presented as an answer, so nothing is attached and
   * the reply stands on its own.
   */
  it('attaches nothing when two cars have been shown', async () => {
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

    const [sent] = await run(
      `select reply_image_url from messages
       where direction = 'outbound' and delivery_state = 'pending'
       order by created_at desc limit 1`, [],
    )
    expect(sent!['reply_image_url']).toBeNull()
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

  /** What search_vehicles returns; the rows the list and the pictures come from. */
  const searched = (reply: string): ModelResponse[] => [
    {
      toolCalls: [{
        id: 't1', name: 'search_vehicles',
        arguments: { vehicle: null, startDate: null, endDate: null },
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

  const photosSent = async () =>
    run(
      `select body, reply_image_url from messages
       where direction = 'outbound' and reply_image_url is not null
       order by created_at`, [],
    )

  it('sends one photograph per car, captioned with its name', async () => {
    await addCars()
    const ctx = await asking('show me your cars')

    await turn(searched('We have two that would suit — which one takes your fancy?'), 'send', ctx)

    const sent = await photosSent()
    expect(sent.map((m) => [m['body'], m['reply_image_url']])).toEqual([
      ['Ferrari 488', FERRARI],
      ['Lamborghini Huracán Tecnica', HURACAN],
    ])
  })

  /**
   * A message carries an image or an interactive and never both, so the reply
   * goes first with its taps and the photographs follow. Losing the list to
   * attach a picture to it would trade a tappable choice for a caption.
   */
  it('keeps the tappable list on the reply and sends the pictures after it', async () => {
    await addCars()
    const ctx = await asking('show me your cars')

    await turn(searched('We have two that would suit — which one takes your fancy?'), 'send', ctx)

    const [reply] = await run(
      `select reply_list, reply_image_url from messages
       where direction = 'outbound' and reply_list is not null`, [],
    )
    expect(reply!['reply_image_url']).toBeNull()
    expect(reply!['reply_list']).not.toBeNull()
  })

  /**
   * The caption is the car and nothing else. A rate or an availability under a
   * photograph reads as a claim, and neither is one this turn can make.
   */
  it('puts nothing but the name under the photograph', async () => {
    await addCars()
    // A confirmed rate exists for one of them, and still must not appear: a
    // caption is read as a claim, and a price under a picture is a price
    // quoted without the dates that decide it.
    const [car] = await run(`select id from vehicles where make = 'Ferrari'`, [])
    await run(
      `insert into vehicle_rates (operator_id, vehicle_id, currency, daily_rate_minor,
                                  confirmed_by, confirmed_at)
       values ($1, $2, 'AED', 350000, 'Sara', now())`,
      [OP, car!['id']],
    )
    const ctx = await asking('show me your cars')

    await turn(searched('Two that would suit — which one takes your fancy?'), 'send', ctx)

    const captions = (await photosSent()).map((m) => String(m['body']))
    expect(captions).toEqual(['Ferrari 488', 'Lamborghini Huracán Tecnica'])
    for (const caption of captions) {
      expect(caption).not.toMatch(/AED|3,500|available|per day/i)
    }
  })

  /** Once. A line-up repeated at every question is the bot this is not. */
  it('does not send the line-up again once they have seen it', async () => {
    await addCars()
    await run(
      `insert into messages (operator_id, conversation_id, direction, kind, body, provider_id,
                             reply_image_url, delivery_state)
       values ($1, $2, 'outbound', 'text', 'Lamborghini Huracán Tecnica', $3, $4, 'accepted')`,
      [OP, CONV, 'wamid.old', HURACAN],
    )
    const ctx = await asking('what else do you have?')

    await turn(searched('We also have a Ferrari 488 — interested?'), 'send', ctx)

    const pending = await run(
      `select reply_image_url from messages
       where direction = 'outbound' and delivery_state = 'pending' and reply_image_url is not null`,
      [],
    )
    expect(pending).toEqual([])
  })
})
