import { describe, expect, it } from 'vitest'
import { toInboundKind, toMessageBody, webhookPayloadSchema } from '../src/lib/whatsapp/payload.ts'

/**
 * A Flow that finished, coming back in.
 *
 * A tap through a Flow is the same answer as a tap through a list, so it has to
 * arrive at the turn as the same sentence — otherwise the customer picks a car
 * and the conversation stops, which is what happened to button replies before
 * they were turned into words.
 */
const flowReply = (responseJson: string) => ({
  from: '971500000001',
  id: 'wamid.FLOW',
  timestamp: '1758000000',
  type: 'interactive' as const,
  interactive: { type: 'nfm_reply', nfm_reply: { response_json: responseJson } },
})

describe('a Flow reply', () => {
  it('becomes the same sentence a list row would have produced', () => {
    const body = toMessageBody(flowReply('{"car":"Lamborghini Huracán Tecnica"}'))
    expect(body).toContain('Lamborghini Huracán Tecnica')
  })

  /** Otherwise Meta's `interactive` type routes it to the non-text path. */
  it('counts as text, not as something a person must read', () => {
    expect(toInboundKind(flowReply('{"car":"Ferrari 488"}'))).toBe('text')
  })

  /**
   * The customer definitely chose something, so a reply we cannot read is held
   * for a person rather than guessed at.
   */
  it('has no body when the answer cannot be read', () => {
    expect(toMessageBody(flowReply('{}'))).toBeNull()
    expect(toMessageBody(flowReply('not json'))).toBeNull()
  })

  it('survives the payload schema', () => {
    const parsed = webhookPayloadSchema.safeParse({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '+971', phone_number_id: '111' },
            messages: [flowReply('{"car":"Ferrari 488"}')],
          },
        }],
      }],
    })
    expect(parsed.success).toBe(true)
  })
})
