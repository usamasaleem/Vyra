import type { QueryRunner } from '../runner.js'

/**
 * Connecting an operator's own WhatsApp number.
 *
 * The pilot sends with one access token, held in the worker's environment. That
 * is why a second operator could sign up, add their cars, publish their answers
 * and still not send a message: Meta issues a token per business, and ours can
 * only send as ours.
 *
 * So the credential moves into the row that already decides which operator a
 * message belongs to. `phone_number_id` was already the routing key from the
 * webhook — this makes it the sending key too, which it always should have been.
 */

export type ConnectedNumber = {
  id: string
  phoneNumberId: string
  wabaId: string
  displayPhoneNumber: string | null
  active: boolean
  /** Null when this number still borrows the worker's own token. */
  tokenHint: string | null
  connectedAt: Date | null
}

export async function listConnectedNumbers(
  run: QueryRunner,
  operatorId: string,
): Promise<ConnectedNumber[]> {
  const rows = await run(
    `select id, phone_number_id, provider_account_id, display_phone_number, active,
            token_hint, connected_at
     from whatsapp_accounts
     where operator_id = $1
     order by created_at`,
    [operatorId],
  )
  return rows.map((r) => ({
    id: r['id'] as string,
    phoneNumberId: r['phone_number_id'] as string,
    wabaId: r['provider_account_id'] as string,
    displayPhoneNumber: (r['display_phone_number'] as string) ?? null,
    active: r['active'] === true,
    tokenHint: (r['token_hint'] as string) ?? null,
    connectedAt: r['connected_at'] == null ? null : new Date(r['connected_at'] as string),
  }))
}

export type ConnectResult =
  | { connected: true; accountId: string }
  /**
   * A number belongs to exactly one operator, globally, and that is enforced by
   * a unique index rather than by asking first. Somebody connecting a number
   * another operator already has is either mistaken or attempting something,
   * and both get the same answer.
   */
  | { connected: false; reason: 'already_connected_elsewhere' }

/**
 * Store, or replace, the credentials for one number.
 *
 * The token arrives sealed — this module never sees the plaintext and never
 * holds the key, so a query log is not a credential leak. Re-connecting the
 * same number updates it in place, because rotating a token is the ordinary
 * case and a second row would leave two answers to "how do we send".
 */
export async function connectWhatsAppNumber(
  run: QueryRunner,
  input: {
    operatorId: string
    phoneNumberId: string
    wabaId: string
    displayPhoneNumber: string | null
    accessTokenCipher: string
    tokenHint: string
    connectedByMembershipId: string
  },
): Promise<ConnectResult> {
  const rows = await run(
    `insert into whatsapp_accounts (
       operator_id, provider_account_id, phone_number_id, display_phone_number,
       access_token_cipher, token_hint, connected_at, connected_by_membership_id, active
     )
     values ($1, $2, $3, $4, $5, $6, now(), $7, true)
     on conflict (phone_number_id) do update set
       provider_account_id = excluded.provider_account_id,
       display_phone_number = excluded.display_phone_number,
       access_token_cipher = excluded.access_token_cipher,
       token_hint = excluded.token_hint,
       connected_at = now(),
       connected_by_membership_id = excluded.connected_by_membership_id,
       active = true
     -- Only when it is already ours. A number another operator has connected
     -- updates nothing and returns nothing, which is how the caller finds out.
     where whatsapp_accounts.operator_id = $1
     returning id`,
    [
      input.operatorId, input.wabaId, input.phoneNumberId, input.displayPhoneNumber,
      input.accessTokenCipher, input.tokenHint, input.connectedByMembershipId,
    ],
  )

  const id = rows[0]?.['id']
  if (typeof id !== 'string') return { connected: false, reason: 'already_connected_elsewhere' }

  await run(
    `insert into audit_events (operator_id, actor_type, actor_id, action, subject_type, subject_id, data)
     values ($1, 'user', $2, 'whatsapp.connected', 'whatsapp_account', $3, $4::jsonb)`,
    [
      input.operatorId, input.connectedByMembershipId, id,
      // The hint and never the token. An audit trail that records the
      // credential is a second copy of it, kept forever, in a table people read.
      JSON.stringify({ phone_number_id: input.phoneNumberId, token_hint: input.tokenHint }),
    ],
  )

  return { connected: true, accountId: id }
}

export async function disconnectWhatsAppNumber(
  run: QueryRunner,
  input: { operatorId: string; accountId: string; actorMembershipId: string },
): Promise<{ disconnected: boolean }> {
  const rows = await run(
    // The row stays. It is what every historical message is scoped through, and
    // deleting it would orphan the conversations it routed.
    `update whatsapp_accounts
     set active = false, access_token_cipher = null, token_hint = null
     where id = $1 and operator_id = $2
     returning id`,
    [input.accountId, input.operatorId],
  )
  if (rows.length === 0) return { disconnected: false }

  await run(
    `insert into audit_events (operator_id, actor_type, actor_id, action, subject_type, subject_id)
     values ($1, 'user', $2, 'whatsapp.disconnected', 'whatsapp_account', $3)`,
    [input.operatorId, input.actorMembershipId, input.accountId],
  )
  return { disconnected: true }
}

/**
 * How to send as whoever owns this number.
 *
 * Read by the worker at dispatch, keyed on the number the message is going
 * out from — the same key the webhook routed the customer's message in on.
 * Returns the sealed token; opening it is the caller's job, because the key
 * belongs to the process and not to the database layer.
 */
export type SendingCredentials = {
  phoneNumberId: string
  accessTokenCipher: string | null
  operatorId: string
}

export async function findSendingCredentials(
  run: QueryRunner,
  phoneNumberId: string,
): Promise<SendingCredentials | null> {
  const rows = await run(
    `select phone_number_id, access_token_cipher, operator_id
     from whatsapp_accounts
     where phone_number_id = $1 and active`,
    [phoneNumberId],
  )
  const row = rows[0]
  if (row === undefined) return null
  return {
    phoneNumberId: row['phone_number_id'] as string,
    accessTokenCipher: (row['access_token_cipher'] as string) ?? null,
    operatorId: row['operator_id'] as string,
  }
}
