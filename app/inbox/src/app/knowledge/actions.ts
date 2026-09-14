'use server'

import { revalidatePath } from 'next/cache'
import { isPolicyTopic } from '@vyra/contracts'
import { draftKnowledge, publishKnowledge } from '@vyra/db'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { queryRunner, transactor } from '@/lib/db'

export type AnswerState = { error: string | null; saved?: string }

/**
 * Write an answer and publish it in one action.
 *
 * The queries underneath keep drafting and publishing apart, and they should: a
 * draft is a version nobody has stood behind, and publishing is where the check
 * constraint demands a named confirmer. But two buttons would be two things an
 * operator has to understand before their first answer exists, and what stands
 * between this agent and a real conversation is an empty table, not a review
 * workflow.
 *
 * So the screen asks for the answer and the name together, and the name is what
 * publishes it. Versioning is untouched: this creates the next version and
 * supersedes the last, so an answer given in September is still readable in
 * December when somebody asks why a customer was told what they were told.
 */
export async function saveAnswer(
  _previous: AnswerState,
  formData: FormData,
): Promise<AnswerState> {
  const actor = await requireActor()
  assertPermitted(permissions.canAdminister(actor), 'publish an operator answer')

  const topic = String(formData.get('topic') ?? '')
  const answer = String(formData.get('answer') ?? '').trim()
  const confirmedBy = String(formData.get('confirmedBy') ?? '').trim()

  // The topic list is closed, so a typo is a refusal rather than an answer
  // filed under a subject nothing will ever ask for.
  if (!isPolicyTopic(topic)) return { error: 'That is not a topic the agent can be asked about.' }
  if (answer === '') return { error: 'Write the answer before saving it.' }
  if (confirmedBy === '') {
    return { error: 'Say who confirmed this. A published answer binds the business.' }
  }

  const draft = await draftKnowledge(queryRunner(), {
    operatorId: actor.operatorId,
    topic,
    answer,
    confirmedBy,
  })

  const result = await publishKnowledge(transactor(), {
    entryId: draft.id,
    operatorId: actor.operatorId,
    membershipId: actor.membershipId,
  })

  if (!result.published) {
    return { error: `Saved as a draft but not published: ${result.reason.replace(/_/g, ' ')}.` }
  }

  revalidatePath('/knowledge')
  return { error: null, saved: topic }
}
