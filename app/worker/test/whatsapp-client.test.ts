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

  /**
   * The second and third photographs of a car say nothing, and " " under a
   * picture is a visible artefact of how the message was stored.
   */
  it('omits a blank caption rather than sending one', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: ' ', imageUrl: IMAGE })

    const sent = calls[0] as { image: Record<string, unknown> }
    expect(sent.image).toMatchObject({ link: IMAGE })
    expect(sent.image).not.toHaveProperty('caption')
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

/**
 * Contextual replies — quoting an earlier message so it appears in a bubble
 * above the new one.
 *
 * What it is for: "sent you a few this morning" is a better answer when the
 * morning's photographs are attached to the sentence saying so, rather than
 * somewhere above in a thread the customer has to scroll.
 */
describe('quoting an earlier message', () => {
  it('sends the context object Meta expects', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001',
      body: 'Sent you a few of those this morning.',
      quotesProviderId: 'wamid.EARLIER',
    })

    expect(calls[0]).toMatchObject({
      type: 'text',
      context: { message_id: 'wamid.EARLIER' },
    })
  })

  it('quotes alongside a photograph too', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001',
      body: 'Here is the side profile.',
      imageUrl: 'https://example.com/side.jpg',
      quotesProviderId: 'wamid.EARLIER',
    })

    expect(calls[0]).toMatchObject({ type: 'image', context: { message_id: 'wamid.EARLIER' } })
  })

  it('quotes alongside buttons', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001',
      body: '20th to 23rd September — that right?',
      buttons: BUTTONS,
      quotesProviderId: 'wamid.EARLIER',
    })

    expect(calls[0]).toMatchObject({ type: 'interactive', context: { message_id: 'wamid.EARLIER' } })
  })

  it('sends nothing when there is nothing to quote', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'Morning.' })

    expect(calls[0]).not.toHaveProperty('context')
  })

  /**
   * Meta rejects the whole message when the quoted id is not one of theirs, so
   * anything that is not a wamid is dropped rather than sent. A reply that
   * arrives without its quote is a much smaller loss than one that does not
   * arrive — and a row id is exactly what would end up here by mistake.
   */
  it('drops an id that is not a wamid rather than failing the send', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001',
      body: 'Morning.',
      quotesProviderId: '66666666-6666-6666-6666-666666666666',
    })

    expect(calls[0]).not.toHaveProperty('context')
    expect(calls[0]).toMatchObject({ type: 'text' })
  })

  it('drops a null without complaint', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'Morning.', quotesProviderId: null })
    expect(calls[0]).not.toHaveProperty('context')
  })
})

/**
 * A Flow — the only surface Meta offers where a tappable list carries
 * photographs. Switched off until a Flow is published, so these tests are what
 * says the payload is right until a phone can.
 */
describe('sending a Flow', () => {
  const flow = {
    id: '1234567890',
    cta: 'See the cars',
    screen: 'CARS',
    token: 'conv:abc',
    data: { cars: [{ id: 'vehicle:Ferrari 488' }] },
  }

  it('sends the shape Meta expects', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'Here is the range.', flow })

    expect(calls[0]).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: 'Here is the range.' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_id: '1234567890',
            flow_token: 'conv:abc',
            flow_cta: 'See the cars',
            flow_action: 'navigate',
            flow_action_payload: { screen: 'CARS', data: flow.data },
          },
        },
      },
    })
  })

  /** Asking the same question twice, once with pictures and once without. */
  it('wins over a list offering the same choice', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001',
      body: 'Which one?',
      list: { button: 'See the cars', rows: [{ id: 'vehicle:Ferrari 488', title: 'Ferrari 488' }] },
      flow,
    })

    expect(calls[0]).toMatchObject({ interactive: { type: 'flow' } })
  })

  /** Nothing changes until a Flow is published and its id configured. */
  it('falls back to the list when no flow is configured', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001',
      body: 'Which one?',
      list: { button: 'See the cars', rows: [{ id: 'vehicle:Ferrari 488', title: 'Ferrari 488' }] },
      flow: null,
    })

    expect(calls[0]).toMatchObject({ interactive: { type: 'list' } })
  })

  /**
   * Meta refuses to publish a Flow for an unverified business — "Integrity
   * requirements not met" — so the only way to see this one on a phone before
   * verification comes through is to send the draft.
   */
  it('can send a draft, for testing before Meta will publish it', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001', body: 'Here is the range.', flow: { ...flow, draft: true },
    })

    expect((calls[0] as { interactive: { action: { parameters: Record<string, unknown> } } })
      .interactive.action.parameters['mode']).toBe('draft')
  })

  it('says nothing about the mode for a published one', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({ to: '971500000001', body: 'Here is the range.', flow })

    expect((calls[0] as { interactive: { action: { parameters: Record<string, unknown> } } })
      .interactive.action.parameters).not.toHaveProperty('mode')
  })

  it('quotes an earlier message alongside a Flow', async () => {
    const { client, calls } = clientCapturing()
    await client.sendText({
      to: '971500000001', body: 'Here is the range.', flow, quotesProviderId: 'wamid.EARLIER',
    })

    expect(calls[0]).toMatchObject({ context: { message_id: 'wamid.EARLIER' } })
  })
})
