import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  checkSettings, getOperatorSettings, updateOperatorSettings, type SettingsUpdate,
} from '../src/queries/settings.ts'
import type { QueryRunner } from '../src/runner.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const OP = '11111111-1111-1111-1111-111111111111'
const RIVAL = '22222222-2222-2222-2222-222222222222'
const SARA = '44444444-4444-4444-4444-444444444444'
const RIVAL_MEMBER = '44444444-4444-4444-4444-4444444444bb'

let db: PGlite
let run: QueryRunner

beforeEach(async () => {
  db = await PGlite.create()
  run = async (t, p) => (await db.query(t, p)).rows as Array<Record<string, unknown>>
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  await db.exec(`
    insert into operators (id, name, timezone) values
      ('${OP}', 'Vyra Pilot', 'Asia/Dubai'), ('${RIVAL}', 'Rival Rentals', 'Asia/Dubai');
    insert into memberships (id, operator_id, user_id, role) values
      ('${SARA}', '${OP}', '10000000-0000-0000-0000-000000000001', 'manager'),
      ('${RIVAL_MEMBER}', '${RIVAL}', '10000000-0000-0000-0000-000000000002', 'admin');
  `)
})

const valid: SettingsUpdate = {
  name: 'Vyra Pilot', timezone: 'Asia/Dubai',
  aiResumesAfterMinutes: 60, followUpAfterMinutes: 10, handoffSlaMinutes: 30,
  answerValidMinutes: 240, retentionDays: 730, fallbackOwnerMembershipId: null,
}

const save = (over: Partial<SettingsUpdate> = {}) =>
  updateOperatorSettings(run, {
    ...valid, ...over, operatorId: OP, actorMembershipId: SARA,
  })

describe('reading the settings', () => {
  it('reports what the operator is currently running on', async () => {
    const settings = await getOperatorSettings(run, OP)
    expect(settings).toMatchObject({
      name: 'Vyra Pilot', timezone: 'Asia/Dubai',
      followUpAfterMinutes: 240, handoffSlaMinutes: 30, aiSendingEnabled: false,
    })
  })

  it('says when no WhatsApp number is connected rather than pretending', async () => {
    expect((await getOperatorSettings(run, OP))!.whatsappNumber).toBeNull()
  })
})

describe('saving them', () => {
  it('takes effect immediately', async () => {
    await save({ followUpAfterMinutes: 10, timezone: 'Asia/Riyadh' })

    const settings = await getOperatorSettings(run, OP)
    expect(settings).toMatchObject({ followUpAfterMinutes: 10, timezone: 'Asia/Riyadh' })
  })

  it('records who changed them', async () => {
    await save({ handoffSlaMinutes: 45 })

    const [event] = await run(
      `select actor_id, action, data from audit_events where action = 'operator.settings_changed'`, [],
    )
    expect(event!['actor_id']).toBe(SARA)
    expect((event!['data'] as Record<string, unknown>)['handoff_sla_minutes']).toBe(45)
  })

  /** Blank is off, and off is a real answer for this one alone. */
  it('lets an operator switch off taking conversations back', async () => {
    await save({ aiResumesAfterMinutes: null })
    expect((await getOperatorSettings(run, OP))!.aiResumesAfterMinutes).toBeNull()
  })

  it('leaves another operator alone', async () => {
    await save({ name: 'Renamed' })
    expect((await getOperatorSettings(run, RIVAL))!.name).toBe('Rival Rentals')
  })
})

/**
 * The column has no foreign key — memberships would be circular at
 * table-creation time — so nothing in the schema stops it naming somebody at
 * another company, or somebody who left.
 */
describe('the fallback owner', () => {
  it('accepts an active member of this operator', async () => {
    await save({ fallbackOwnerMembershipId: SARA })
    expect((await getOperatorSettings(run, OP))!.fallbackOwnerMembershipId).toBe(SARA)
  })

  it('refuses somebody at another operator, leaving nobody named', async () => {
    await save({ fallbackOwnerMembershipId: RIVAL_MEMBER })
    expect((await getOperatorSettings(run, OP))!.fallbackOwnerMembershipId).toBeNull()
  })

  it('drops somebody who no longer has access', async () => {
    await save({ fallbackOwnerMembershipId: SARA })
    await run(`update memberships set active = false where id = $1`, [SARA])

    await save({ fallbackOwnerMembershipId: SARA })
    expect((await getOperatorSettings(run, OP))!.fallbackOwnerMembershipId).toBeNull()
  })
})

/**
 * These are timers on messages to real people, and every one of them is a
 * slipped keystroke away from something nobody wants.
 */
describe('what will not be saved', () => {
  it('refuses a follow-up that chases somebody in the same second', () => {
    expect(checkSettings({ ...valid, followUpAfterMinutes: 0 }))
      .toEqual([{ field: 'followUpAfterMinutes', message: expect.stringContaining('between 5') }])
  })

  it('refuses a retention that deletes the conversation you are reading', () => {
    expect(checkSettings({ ...valid, retentionDays: 0 })).toHaveLength(1)
  })

  it('refuses a company with no name', () => {
    expect(checkSettings({ ...valid, name: '   ' }))
      .toEqual([{ field: 'name', message: 'Enter the company name.' }])
  })

  it('refuses a number that is not one', () => {
    expect(checkSettings({ ...valid, handoffSlaMinutes: Number.NaN })).toHaveLength(1)
  })

  it('accepts the settings this operator actually runs on', () => {
    expect(checkSettings(valid)).toEqual([])
  })
})
