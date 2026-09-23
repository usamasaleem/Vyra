import { usableWebsite } from '@vyra/contracts'
import type { QueryRunner } from '../runner.js'

/**
 * What an operator decides about their own agent.
 *
 * Every one of these was a column somebody had to change with SQL. The two
 * that cost the most while they were out of reach: the fallback owner, whose
 * absence the worker logs on every escalation as "no fallback owner configured
 * for this operator", and the follow-up gap, which sat at four hours because
 * four hours was the default rather than because anybody chose it.
 */
export type OperatorSettings = {
  name: string
  timezone: string
  /** Where the whole fleet can be seen. Null when there is nowhere. */
  websiteUrl: string | null
  aiSendingEnabled: boolean
  /** Null switches off taking a conversation back from a silent salesperson. */
  aiResumesAfterMinutes: number | null
  followUpAfterMinutes: number
  /** How long the agent holds a car for somebody deciding. Null: it does not. */
  holdMinutes: number | null
  handoffSlaMinutes: number
  answerValidMinutes: number
  retentionDays: number
  fallbackOwnerMembershipId: string | null
  /**
   * Whether the agent may confirm a booking itself.
   *
   * Audited on every change, like the calendar claim it depends on, because
   * it changes what the software is allowed to promise on somebody's behalf.
   */
  autoConfirmBookings: boolean
  /** The most it may confirm alone, in minor units. Null for no ceiling. */
  autoConfirmLimitMinor: number | null
  /** Whether the operator vouches for the calendar. Auto-confirm needs it. */
  availabilityCalendarComplete: boolean
  /** Read-only here. Connecting a number is not something a form can do. */
  whatsappNumber: string | null
}

export async function getOperatorSettings(
  run: QueryRunner,
  operatorId: string,
): Promise<OperatorSettings | null> {
  const rows = await run(
    `select o.name, o.timezone, o.website_url, o.ai_sending_enabled, o.ai_resumes_after_minutes,
            o.follow_up_after_minutes, o.hold_minutes, o.handoff_sla_minutes, o.answer_valid_minutes,
            o.retention_days, o.fallback_owner_membership_id,
            o.auto_confirm_bookings, o.auto_confirm_limit_minor,
            o.availability_calendar_complete,
            (select w.display_phone_number from whatsapp_accounts w
             where w.operator_id = o.id order by w.created_at limit 1) as whatsapp_number
     from operators o
     where o.id = $1`,
    [operatorId],
  )
  const row = rows[0]
  if (row === undefined) return null

  return {
    name: row['name'] as string,
    timezone: row['timezone'] as string,
    websiteUrl: (row['website_url'] as string) ?? null,
    aiSendingEnabled: row['ai_sending_enabled'] === true,
    aiResumesAfterMinutes: row['ai_resumes_after_minutes'] === null
      ? null
      : Number(row['ai_resumes_after_minutes']),
    followUpAfterMinutes: Number(row['follow_up_after_minutes']),
    holdMinutes: row['hold_minutes'] == null ? null : Number(row['hold_minutes']),
    handoffSlaMinutes: Number(row['handoff_sla_minutes']),
    answerValidMinutes: Number(row['answer_valid_minutes']),
    retentionDays: Number(row['retention_days']),
    fallbackOwnerMembershipId: (row['fallback_owner_membership_id'] as string) ?? null,
    autoConfirmBookings: row['auto_confirm_bookings'] === true,
    autoConfirmLimitMinor: row['auto_confirm_limit_minor'] == null
      ? null
      : Number(row['auto_confirm_limit_minor']),
    availabilityCalendarComplete: row['availability_calendar_complete'] === true,
    whatsappNumber: (row['whatsapp_number'] as string) ?? null,
  }
}

export type SettingsUpdate = {
  name: string
  timezone: string
  websiteUrl: string | null
  aiResumesAfterMinutes: number | null
  followUpAfterMinutes: number
  /** How long the agent holds a car for somebody deciding. Null: it does not. */
  holdMinutes: number | null
  handoffSlaMinutes: number
  answerValidMinutes: number
  retentionDays: number
  fallbackOwnerMembershipId: string | null
  autoConfirmBookings: boolean
  autoConfirmLimitMinor: number | null
}

/**
 * The bounds, which exist because these are timers on messages to real people.
 *
 * A follow-up gap of zero chases somebody in the same second they stopped
 * typing. A retention of zero deletes the conversation you are looking at.
 * Neither is a setting anybody wants and both are one slipped keystroke away,
 * so they are refused here rather than in a form that can be bypassed.
 */
export const SETTING_BOUNDS = {
  aiResumesAfterMinutes: { min: 5, max: 10_080 },
  followUpAfterMinutes: { min: 5, max: 1_440 },
  holdMinutes: { min: 15, max: 1_440 },
  handoffSlaMinutes: { min: 5, max: 1_440 },
  answerValidMinutes: { min: 15, max: 10_080 },
  retentionDays: { min: 30, max: 3_650 },
} as const

export type SettingsProblem = { field: string; message: string }

export function checkSettings(update: SettingsUpdate): SettingsProblem[] {
  const problems: SettingsProblem[] = []

  if (update.name.trim() === '') {
    problems.push({ field: 'name', message: 'Enter the company name.' })
  }

  /**
   * https or nothing. The cost of accepting something odd here is a customer
   * sent somewhere the operator did not mean, from the operator's own number.
   */
  if (update.websiteUrl !== null && usableWebsite(update.websiteUrl) === null) {
    problems.push({
      field: 'websiteUrl',
      message: 'Enter the full address, starting with https://',
    })
  }

  for (const [field, bound] of Object.entries(SETTING_BOUNDS)) {
    const value = update[field as keyof typeof SETTING_BOUNDS]
    // Null is off, where the setting allows it, and is not out of range.
    if (value == null) continue
    if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
      problems.push({
        field,
        message: `Choose a number between ${bound.min} and ${bound.max}.`,
      })
    }
  }

  return problems
}

/**
 * Saving them, with the fallback owner checked against reality.
 *
 * That one is a uuid column with no foreign key — memberships would be
 * circular at table-creation time — so nothing in the schema stops it naming
 * somebody at another operator, or somebody who left. The subquery does: it
 * resolves to null unless the id belongs to an active member of this operator,
 * which is the same answer the escalation would give at three in the morning,
 * only now it is given while somebody is looking at the screen.
 */
export async function updateOperatorSettings(
  run: QueryRunner,
  input: SettingsUpdate & { operatorId: string; actorMembershipId: string },
): Promise<{ saved: boolean }> {
  const rows = await run(
    `update operators o set
       name = $2,
       timezone = $3,
       website_url = $10,
       ai_resumes_after_minutes = $4,
       follow_up_after_minutes = $5,
       handoff_sla_minutes = $6,
       answer_valid_minutes = $7,
       retention_days = $8,
       fallback_owner_membership_id = (
         select m.id from memberships m
         where m.id = $9::uuid and m.operator_id = o.id and m.active
       ),
       auto_confirm_bookings = $11,
       auto_confirm_limit_minor = $12,
       hold_minutes = $13,
       updated_at = now()
     where o.id = $1
     returning o.id`,
    [
      input.operatorId, input.name.trim(), input.timezone,
      input.aiResumesAfterMinutes, input.followUpAfterMinutes, input.handoffSlaMinutes,
      input.answerValidMinutes, input.retentionDays, input.fallbackOwnerMembershipId,
      usableWebsite(input.websiteUrl),
      input.autoConfirmBookings, input.autoConfirmLimitMinor, input.holdMinutes,
    ],
  )
  if (rows.length === 0) return { saved: false }

  await run(
    `insert into audit_events (operator_id, actor_type, actor_id, action, subject_type, subject_id, data)
     values ($1, 'user', $2, 'operator.settings_changed', 'operator', $1, $3::jsonb)`,
    [
      input.operatorId,
      input.actorMembershipId,
      JSON.stringify({
        timezone: input.timezone,
        ai_resumes_after_minutes: input.aiResumesAfterMinutes,
        follow_up_after_minutes: input.followUpAfterMinutes,
        handoff_sla_minutes: input.handoffSlaMinutes,
        answer_valid_minutes: input.answerValidMinutes,
        retention_days: input.retentionDays,
        auto_confirm_bookings: input.autoConfirmBookings,
        auto_confirm_limit_minor: input.autoConfirmLimitMinor,
        hold_minutes: input.holdMinutes,
      }),
    ],
  )

  return { saved: true }
}
