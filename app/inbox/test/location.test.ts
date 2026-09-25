import { describe, expect, it } from 'vitest'
import { toInboundKind, toMessageBody, webhookPayloadSchema } from '../src/lib/whatsapp/payload.ts'

/** A customer sends the hotel's pin so the car can be brought there. */
const pinFrom = (location: Record<string, unknown>) => {
  const payload = webhookPayloadSchema.parse({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: '111' },
          messages: [{ id: 'wamid.1', from: '971500000001', timestamp: '1790000000', type: 'location', location }],
        },
      }],
    }],
  })
  return payload.entry[0]!.changes![0]!.value.messages![0]!
}

describe('a shared location pin', () => {
  it('arrives as words the agent can read, with a map link', () => {
    const message = pinFrom({ latitude: 25.1304, longitude: 55.1171, name: 'Atlantis The Palm', address: 'Crescent Rd, Dubai' })
    expect(toInboundKind(message)).toBe('text')
    expect(toMessageBody(message)).toBe(
      'Location pin shared: Atlantis The Palm, Crescent Rd, Dubai — https://maps.google.com/?q=25.1304,55.1171')
  })

  it('still says where, when the pin has no name', () => {
    expect(toMessageBody(pinFrom({ latitude: 25.2, longitude: 55.27 })))
      .toBe('Location pin shared: https://maps.google.com/?q=25.2,55.27')
  })
})
