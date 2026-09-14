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

describe('sending a list', () => {
  const LIST = {
    button: 'See the cars',
    rows: [
      { id: 'vehicle:Rolls-Royce Cullinan', title: 'Rolls-Royce Cullinan',
        description: 'English White · 6.75L V12 · AED 8,000/day' },
      { id: 'vehicle:Ferrari 488', title: 'Ferrari 488', description: 'Giallo Modena · 3.9L V8' },
    ],
  }

  it('sends the shape Meta expects', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'Which one appeals?', list: LIST })

    expect(calls[0]).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'Which one appeals?' },
        action: {
          button: 'See the cars',
          sections: [{ rows: [
            { id: 'vehicle:Rolls-Royce Cullinan', title: 'Rolls-Royce Cullinan' },
            { id: 'vehicle:Ferrari 488', title: 'Ferrari 488' },
          ] }],
        },
      },
    })
  })

  /** A list body may run to 4096, so a long one does not fall back to text. */
  it('keeps the list even when the body is long for a button message', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'x'.repeat(1100), list: LIST })
    expect(calls[0]).toMatchObject({ type: 'interactive', interactive: { type: 'list' } })
  })

  /** A message carries one or the other. The list is the richer offer. */
  it('prefers the list when both are supplied', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'Pick one', buttons: BUTTONS, list: LIST })
    expect(calls[0]).toMatchObject({ interactive: { type: 'list' } })
  })

  it('omits an empty description rather than sending a blank one', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001', body: 'Pick one',
      list: { button: 'Cars', rows: [{ id: 'a', title: 'A', description: '' }] },
    })
    const sent = calls[0] as { interactive: { action: { sections: Array<{ rows: Array<Record<string, unknown>> }> } } }
    expect(sent.interactive.action.sections[0]!.rows[0]).not.toHaveProperty('description')
  })

  it.each([null, undefined, { button: 'x', rows: [] }])('falls back to text for %j', async (list) => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'Nice choice.', list })
    expect(calls[0]).toMatchObject({ type: 'text' })
  })
})

describe('sending a photograph', () => {
  const IMAGE = 'https://example.com/huracan.jpg'

  it('sends the reply as the caption', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001',
      body: 'The Huracán EVO Spyder, in Arancio orange. AED 5,500 per day.',
      imageUrl: IMAGE,
    })

    expect(calls[0]).toMatchObject({
      type: 'image',
      image: { link: IMAGE, caption: 'The Huracán EVO Spyder, in Arancio orange. AED 5,500 per day.' },
    })
  })

  /**
   * An image carries neither buttons nor a list. A tap moves the conversation
   * forward; a photograph only makes it nicer to look at.
   */
  it('gives way to buttons', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'That right?', buttons: BUTTONS, imageUrl: IMAGE })
    expect(calls[0]).toMatchObject({ type: 'interactive', interactive: { type: 'button' } })
  })

  it('falls back to text when the caption is too long', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'x'.repeat(1100), imageUrl: IMAGE })
    expect(calls[0]).toMatchObject({ type: 'text' })
  })

  it.each([null, undefined, 'http://example.com/insecure.jpg'])(
    'sends plain text for %j', async (imageUrl) => {
      const { client, calls } = clientCapturing()
      await client.sendText({ to: '971500000001', body: 'Nice choice.', imageUrl })
      expect(calls[0]).toMatchObject({ type: 'text' })
    })
})
