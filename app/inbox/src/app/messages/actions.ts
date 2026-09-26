'use server'

import { revalidatePath } from 'next/cache'
import { hasUnfilledBlank, isAutomatedMessage, readServiceHours, readyStarter } from '@vyra/contracts'
import { draftKnowledge, publishKnowledge } from '@vyra/db'
import { assertPermitted, permissions, requireActor, type Actor } from '@/lib/auth'
import { actorRunner, actorTransactor } from '@/lib/db'

export type MessageState = { error: string | null; saved?: string }

/**
 * The words the system sends without anybody watching.
 *
 * Stored through the same two queries as a policy answer, and bound by the
 * same check constraint: a version, an effective window, and an account behind
 * the publish. A greeting sent to every new customer is at least as much the
 * operator's voice as their deposit policy, and there is no reason for it to
 * have weaker provenance.
 */
export async function saveAutomatedMessage(
  _previous: MessageState,
  formData: FormData,
): Promise<MessageState> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'change the automated messages')

  const topic = String(formData.get('topic') ?? '')
  const answer = String(formData.get('answer') ?? '').trim()
  const confirmedBy = String(formData.get('confirmedBy') ?? '').trim()

  if (!isAutomatedMessage(topic)) return { error: 'That is not a message the system sends.' }
  if (answer === '') {
    return { error: 'Write the message before saving it. An empty one is not sent at all.' }
  }
  if (confirmedBy === '') {
    return { error: 'Say who approved this. It goes out in the operator’s name.' }
  }
  // The thank-you starter leaves the review link blank; a blank must never reach a customer.
  if (hasUnfilledBlank(answer)) {
    return { error: 'Fill in the ___ before publishing — or take it out if you do not want it.' }
  }

  return await publishMessage(actor, topic, answer, confirmedBy)
}

/**
 * Taking the starter as it stands, in one tap.
 *
 * The wording comes from the server, never the form, so what is published is
 * exactly what the page showed beside the button — the operator's name filled
 * in, any sentence with a blank left out. The approver is the person who
 * tapped, from the session: pressing "Use this" is putting your name to it,
 * and asking them to type it as well is the step that kept these unwritten.
 */
export async function acceptStarter(
  _previous: MessageState,
  formData: FormData,
): Promise<MessageState> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'change the automated messages')

  const topic = String(formData.get('topic') ?? '')
  if (!isAutomatedMessage(topic)) return { error: 'That is not a message the system sends.' }
  const answer = readyStarter(topic, actor.operatorName)
  if (answer === null) return { error: 'This one needs writing — use Edit.' }

  return await publishMessage(
    actor, topic, answer, actor.displayName ?? actor.email ?? actor.membershipId,
  )
}

/** Drafted then published, so it gets the same version and name as any answer. */
async function publishMessage(
  actor: Actor,
  topic: string,
  answer: string,
  confirmedBy: string,
): Promise<MessageState> {
  const draft = await draftKnowledge(actorRunner(actor), {
    operatorId: actor.operatorId,
    topic,
    answer,
    confirmedBy,
    confirmedByMembershipId: actor.membershipId,
  })

  const result = await publishKnowledge(actorTransactor(actor), {
    entryId: draft.id,
    operatorId: actor.operatorId,
    membershipId: actor.membershipId,
  })

  if (!result.published) {
    return { error: `Saved as a draft but not published: ${result.reason.replace(/_/g, ' ')}.` }
  }

  revalidatePath('/messages')
  return { error: null, saved: topic }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * When the operator's people are there.
 *
 * `operators.service_hours` has existed since the schema was written, with the
 * comment "opening hours, for honest out-of-hours replies rather than invented
 * ones", and nothing has ever written it. This is that form.
 *
 * A day left blank is a day they are closed, which is the rule the column has
 * always documented. Clearing every day removes the hours entirely, and hours
 * nobody has set are never treated as closed.
 */
export async function saveServiceHours(
  _previous: MessageState,
  formData: FormData,
): Promise<MessageState> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'change the opening hours')

  const hours: Record<string, { open: string; close: string }> = {}
  for (const [index, name] of DAYS.entries()) {
    const open = String(formData.get(`open-${index}`) ?? '').trim()
    const close = String(formData.get(`close-${index}`) ?? '').trim()
    if (open === '' && close === '') continue
    if (open === '' || close === '') {
      return { error: `${name} has one time but not the other. Give both, or neither to close it.` }
    }
    hours[String(index)] = { open, close }
  }

  const parsed = Object.keys(hours).length === 0 ? null : readServiceHours(hours)
  if (parsed === null && Object.keys(hours).length > 0) {
    return { error: 'Times need to look like 09:00 and 21:00.' }
  }

  await actorRunner(actor)(
    `update operators set service_hours = $2::jsonb, updated_at = now() where id = $1`,
    [actor.operatorId, parsed === null ? null : JSON.stringify(parsed)],
  )

  revalidatePath('/messages')
  return { error: null, saved: 'hours' }
}
