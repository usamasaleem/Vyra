import { describe, expect, it, vi } from 'vitest'
import { createWhatsAppClient } from '../src/whatsapp/client.ts'

/**
 * The payload Meta actually receives. Nothing else in the suite looks at it,
 * and a wrong shape here is a 400 in production rather than a failing test.
 */
function clientCapturing() {
  const calls: Array<Record<string, unknown>> = []
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 })
  }) as unknown as typeof fetch

  const client = createWhatsAppClient({
    apiVersion: 'v26.0', phoneNumberId: '111', accessToken: 'token', fetchImpl,
  })
  return { client, calls }
}

const BUTTONS = [
  { id: 'dates_confirmed', title: 'Yes, correct' },
  { id: 'dates_wrong', title: 'Different dates' },
]

describe('sending', () => {
  it('sends an ordinary message as text', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'The Cullinan is AED 8,000 per day.' })

    expect(calls[0]).toMatchObject({
      type: 'text',
      text: { preview_url: false, body: 'The Cullinan is AED 8,000 per day.' },
    })
  })

  it('sends reply buttons in the shape Meta expects', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001',
      body: '20th to 23rd September — that right?',
      buttons: BUTTONS,
    })

    expect(calls[0]).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '20th to 23rd September — that right?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'dates_confirmed', title: 'Yes, correct' } },
            { type: 'reply', reply: { id: 'dates_wrong', title: 'Different dates' } },
          ],
        },
      },
    })
  })

  it.each([null, undefined, []])('sends plain text when buttons are %j', async (buttons) => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'Nice choice.', buttons })
    expect(calls[0]).toMatchObject({ type: 'text' })
  })

  /**
   * An interactive body is capped at 1024 characters where a text message
   * allows 4096. Losing two buttons is a smaller loss than losing the message.
   */
  it('falls back to text when the body is too long to be interactive', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'x'.repeat(1100), buttons: BUTTONS })
    expect(calls[0]).toMatchObject({ type: 'text' })
  })

  it('truncates a title rather than letting the send be rejected', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001', body: 'Pick one',
      buttons: [{ id: 'x', title: 'A title somebody made much too friendly' }],
    })

    const sent = calls[0] as { interactive: { action: { buttons: Array<{ reply: { title: string } }> } } }
    expect(sent.interactive.action.buttons[0]!.reply.title).toHaveLength(20)
  })
})
