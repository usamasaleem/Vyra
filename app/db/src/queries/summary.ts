import type { QueryRunner } from '../runner.js'

/**
 * Keeping what fell out of the window.
 *
 * The model sees the last twenty messages. Everything older is gone, and the
 * agent has no way to know it is missing: it asks again for a date the customer
 * gave on Monday, or forgets they said they are visiting on a tourist visa.
 *
 * Only the messages beyond the window are summarised. Summarising the recent
 * ones too would spend money describing text the model is about to read in
 * full, and would let a paraphrase compete with the original.
 */
export type OlderMessage = { direction: string; body: string }

export async function loadMessagesBeforeWindow(
  run: QueryRunner,
  input: { conversationId: string; operatorId: string; windowSize: number; limit?: number },
): Promise<{ messages: OlderMessage[]; totalMessages: number }> {
  const [count] = await run(
    `select count(*)::int as n from messages
     where conversation_id = $1 and operator_id = $2 and body is not null`,
    [input.conversationId, input.operatorId],
  )
  const totalMessages = Number(count?.['n'] ?? 0)
  if (totalMessages <= input.windowSize) return { messages: [], totalMessages }

  /**
   * Oldest first, and capped. A conversation with four hundred messages must
   * not produce a four-hundred-message summarisation call; the previous summary
   * carries what came before the cap.
   */
  // How many the window no longer covers, and how many of those to read now.
  // When more have fallen out than the cap allows, the newest of them are the
  // ones worth reading: the previous summary already covers what came before.
  const fallenOut = totalMessages - input.windowSize
  const take = Math.min(input.limit ?? 60, fallenOut)

  const rows = await run(
    `select direction::text as direction, body from messages
     where conversation_id = $1 and operator_id = $2 and body is not null
     order by created_at
     limit $3 offset $4`,
    [input.conversationId, input.operatorId, take, fallenOut - take],
  )

  return {
    messages: rows.map((r) => ({
      direction: r['direction'] as string,
      body: r['body'] as string,
    })),
    totalMessages,
  }
}

/**
 * Written without touching `revision`.
 *
 * A summary is not a change a customer or a salesperson made to the
 * conversation, and bumping the revision would make every in-flight turn look
 * superseded — the agent would fall silent because it wrote a note to itself.
 */
export async function saveConversationSummary(
  run: QueryRunner,
  input: {
    conversationId: string
    operatorId: string
    summary: string
    throughCount: number
  },
): Promise<void> {
  await run(
    `update conversations
     set summary = $3, summary_through_count = $4, updated_at = now()
     where id = $1 and operator_id = $2`,
    [input.conversationId, input.operatorId, input.summary, input.throughCount],
  )
}
