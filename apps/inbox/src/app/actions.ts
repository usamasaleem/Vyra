'use server'

import { resumeAi, setOperatorAiSending, takeOverConversation, queueOutboundText } from '@vyra/db'
import { revalidatePath } from 'next/cache'
import { assertPermitted, permissions, requireActor } from '@/lib/auth'
import { queryRunner } from '@/lib/db'

/**
 * Every action re-derives the actor and its operator from the session.
 *
 * Nothing here trusts a form field to say which operator is being acted on.
 * Section 18.7: a browser-supplied operator id is a requested scope, not proof
 * of permission — and a hidden input is exactly the browser supplying one.
 */

export async function sendReply(
  _previous: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const actor = await requireActor()
  const conversationId = String(formData.get('conversationId') ?? '')
  const body = String(formData.get('body') ?? '').trim()

  if (body === '') return { error: 'Write something first.' }

  try {
    assertPermitted(permissions.canReply(actor), 'send a customer reply')
  } catch {
    return { error: 'Your role cannot send customer replies.' }
  }

  /**
   * Staff messages take the same path as AI messages — queued here, sent by
   * the dispatcher. Section 18.12 forbids a second way to send, because a
   * direct call would skip the 24-hour window check and the delivery record.
   */
  const result = await queueOutboundText(queryRunner(), {
    conversationId,
    operatorId: actor.operatorId,
    body,
    // Stable per submission so a double-click cannot queue two replies.
    idempotencyKey: `staff:${actor.membershipId}:${hash(conversationId + body)}`,
    sentByMembershipId: actor.membershipId,
  })

  if (result.messageId === null && !result.duplicate) {
    return { error: 'That conversation could not be found.' }
  }

  revalidatePath(`/conversations/${conversationId}`)
  return { error: null }
}

export async function takeOver(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const conversationId = String(formData.get('conversationId') ?? '')
  assertPermitted(permissions.canReply(actor), 'take over a conversation')

  await takeOverConversation(queryRunner(), {
    conversationId,
    operatorId: actor.operatorId,
    membershipId: actor.membershipId,
  })
  revalidatePath(`/conversations/${conversationId}`)
}

export async function handBackToAi(formData: FormData): Promise<void> {
  const actor = await requireActor()
  const conversationId = String(formData.get('conversationId') ?? '')
  assertPermitted(permissions.canReply(actor), 'return a conversation to the AI')

  await resumeAi(queryRunner(), {
    conversationId,
    operatorId: actor.operatorId,
    membershipId: actor.membershipId,
  })
  revalidatePath(`/conversations/${conversationId}`)
}

export async function toggleAiSending(formData: FormData): Promise<void> {
  const actor = await requireActor()
  assertPermitted(permissions.canControlAi(actor), 'change the AI switch')

  await setOperatorAiSending(queryRunner(), {
    operatorId: actor.operatorId,
    enabled: String(formData.get('enabled')) === 'true',
    membershipId: actor.membershipId,
  })
  revalidatePath('/')
}

/** Small stable hash so an idempotency key stays a sensible length. */
function hash(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
