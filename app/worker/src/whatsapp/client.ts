/**
 * The only code in this repository that calls Meta.
 *
 * Section 18.3: the dispatcher is the single component that sends WhatsApp
 * messages, including messages a salesperson typed by hand. A second send path
 * would bypass the 24-hour window check, the ownership check and the delivery
 * record, so there must never be one.
 */

/** Meta rejected the request and said why. */
export class MetaApiError extends Error {
  readonly httpStatus: number
  readonly code: number | null
  readonly retryable: boolean

  constructor(message: string, httpStatus: number, code: number | null, retryable: boolean) {
    super(message)
    this.name = 'MetaApiError'
    this.httpStatus = httpStatus
    this.code = code
    this.retryable = retryable
  }
}

/**
 * The send may or may not have happened.
 *
 * A timeout or a dropped connection after the request left us is genuinely
 * ambiguous: Meta may have accepted the message and lost the response. Section
 * 18.10 forbids resolving that ambiguity by guessing — a blind retry can
 * duplicate a real customer message, and marking it failed can lose one.
 */
export class MetaUnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetaUnknownOutcomeError'
  }
}

export type SendTextInput = {
  to: string
  body: string
  /**
   * Reply buttons to offer, or nothing for an ordinary text message.
   *
   * Almost always nothing. Only two closed questions in this product earn a
   * tap; see the confirmations module for why that restraint is the design.
   */
  buttons?: Array<{ id: string; title: string }> | null
  /**
   * A tappable list, for the one question three buttons cannot hold. A message
   * carries buttons or a list, never both — the list wins if both arrive.
   */
  list?: {
    button: string
    rows: Array<{ id: string; title: string; description?: string }>
  } | null
  /**
   * A photograph to send instead of a plain text message, as a public HTTPS
   * link. The reply becomes its caption, so a picture costs one message rather
   * than a burst of them.
   */
  imageUrl?: string | null
  /**
   * A message to quote, by its Meta id (wamid), so the reply arrives in a
   * contextual bubble above the new one.
   *
   * What it buys is a customer who does not have to work out which of twenty
   * messages you meant. "Sent you a few this morning" is better when the
   * morning's photographs are attached to the sentence saying so.
   *
   * Meta calls these contextual replies. An id that is too old, deleted, or
   * from another conversation is rejected for the whole message — so this is
   * dropped rather than allowed to fail a send: a reply that arrives without
   * its quote is a smaller loss than one that does not arrive.
   */
  /**
   * A labelled link, sent as WhatsApp's cta_url button.
   *
   * Loses to a list and to buttons, and wins over an image. A message asking
   * somebody to choose between three cars should not also offer to take them
   * out of the app, and a reply pointing at the whole range has no single car
   * to photograph.
   *
   * Tested: this does not open a panel over the chat. It launches the phone's
   * default browser as a separate app, so it is an exit and is used like one.
   */
  link?: { label: string; url: string } | null
  quotesProviderId?: string | null
  /**
   * A published Flow to open, with the data its first screen needs.
   *
   * The only surface Meta offers where a tappable list carries pictures. Wins
   * over `list` when both are present, because it is the same question asked
   * better; loses to nothing, because a Flow the customer's client cannot
   * render is a dead end and the caller decides that, not this.
   */
  flow?: {
    id: string
    /** The button that opens it. Twenty characters, like every other CTA. */
    cta: string
    screen: string
    data: Record<string, unknown>
    /** Echoed back with the reply, so a response can be tied to its request. */
    token: string
    /**
     * Send a Flow that is still a draft.
     *
     * Meta refuses to publish one until the business is verified — "Blocked by
     * Integrity", which is a policy gate rather than anything wrong with the
     * Flow. A draft can still be opened by people with a role on the business
     * account, which is how this gets tested on a real phone in the months
     * before verification comes through.
     *
     * It shows a warning banner to whoever opens it, so it is a test mode and
     * not a way to skip the queue.
     */
    draft?: boolean
  } | null
}

export type SendTextResult = {
  providerMessageId: string
}

export type WhatsAppClient = {
  sendText(input: SendTextInput): Promise<SendTextResult>
  /**
   * Mark the customer's message read and show that a reply is being written.
   *
   * One call does both, which is how Meta models it — and the pairing is right
   * anyway: two blue ticks and a typing indicator are the same promise, that
   * somebody is there and an answer is coming.
   *
   * A reply takes about nine seconds, most of it the model. This does not make
   * it shorter; it makes those nine seconds look like a person typing instead
   * of silence, which is most of what "fast" means in a chat.
   *
   * Meta dismisses the indicator when the reply arrives or after 25 seconds,
   * and asks that it only be shown when a reply is actually coming. It is sent
   * here only once the system has decided to answer.
   */
  showTyping(input: { messageId: string }): Promise<void>
  /**
   * Two blue ticks, and no promise of a reply.
   *
   * The pairing above is right when an answer is coming and wrong when one is
   * not. A voice note, a message to a conversation a salesperson owns, an
   * accident routed to a person — all of these returned before showTyping was
   * reached, so the customer's message was never marked read at all. They saw
   * one grey tick and a silence, which says "this did not arrive" when the
   * truth is "this arrived and a person has it".
   *
   * Meta asks that a typing indicator only be shown when a reply is actually
   * coming. It asks nothing of the kind about a read receipt, which is a
   * statement of fact.
   */
  markRead(input: { messageId: string }): Promise<void>
  /**
   * The bytes behind a media id.
   *
   * Two calls, because Meta does not serve the file from the id: the first
   * returns a short-lived lookaside URL and the second fetches it, and that
   * second request needs the access token too — an unauthenticated GET of the
   * URL returns 401, which is the part that surprises people.
   *
   * Returns null rather than throwing on anything that is not a clean
   * download. A voice note that cannot be fetched is a voice note for a
   * person, which is the behaviour that already exists and works.
   */
  fetchMedia(input: { mediaId: string }): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string } | null>
}

/** 4xx that will never succeed on retry; anything else is worth retrying. */
function isPermanent(httpStatus: number): boolean {
  return httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429
}

export function createWhatsAppClient(config: {
  apiVersion: string
  phoneNumberId: string
  accessToken: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): WhatsAppClient {
  const doFetch = config.fetchImpl ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000

  /**
   * One endpoint, two promises. `typing` is the difference between "we have
   * this" and "we have this and an answer is coming", and Meta asks that the
   * second only be claimed when it is true.
   *
   * Swallowed on purpose, and the only place in this client that does. A
   * courtesy that fails is a courtesy that fails; letting it throw would retry
   * the job and send the customer a second reply, trading a missing tick for a
   * duplicate message.
   */
  const receipt = async (messageId: string, typing: boolean): Promise<void> => {
    const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`
    try {
      await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          ...(typing ? { typing_indicator: { type: 'text' } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      // See above.
    }
  }

  return {
    async showTyping({ messageId }) {
      await receipt(messageId, true)
    },

    async markRead({ messageId }) {
      await receipt(messageId, false)
    },

    async fetchMedia({ mediaId }) {
      const authorized = { authorization: `Bearer ${config.accessToken}` }
      try {
        const lookup = await doFetch(
          `https://graph.facebook.com/${config.apiVersion}/${mediaId}`,
          { headers: authorized, signal: AbortSignal.timeout(timeoutMs) },
        )
        if (!lookup.ok) return null

        const described = (await lookup.json()) as { url?: unknown; mime_type?: unknown }
        if (typeof described.url !== 'string') return null

        // The lookaside URL is authenticated too, which an unauthenticated GET
        // discovers as a 401 rather than as a redirect.
        const file = await doFetch(described.url, {
          headers: authorized,
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!file.ok) return null

        return {
          bytes: new Uint8Array(await file.arrayBuffer()),
          mimeType: typeof described.mime_type === 'string'
            ? described.mime_type.split(';')[0]!.trim()
            : 'application/octet-stream',
        }
      } catch {
        // Same reasoning as the receipt above: a download that fails is a
        // download that fails, and the message still reaches a person.
        return null
      }
    },

    async sendText({ to, body, buttons, list, imageUrl, link, quotesProviderId, flow }) {
      const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`

      /**
       * An interactive body is capped at 1024 characters where a text message
       * allows 4096, so a long reply sends as plain text rather than failing.
       * Losing two buttons is a smaller loss than losing the message.
       */
      const useButtons =
        buttons !== undefined && buttons !== null && buttons.length > 0
        && buttons.length <= 3 && body.length <= 1024

      /**
       * A list body may run to 4096 characters, unlike the 1024 a button
       * message allows, so no length fallback is needed here. Ten rows is the
       * hard ceiling; anything longer was never built.
       */
      /**
       * Ahead of the list and the buttons, and it has to be: a Flow is the
       * same choice with photographs on it, so offering both would be asking
       * twice.
       */
      const useFlow = flow !== undefined && flow !== null && flow.id !== '' && body.length <= 1024

      const useList =
        !useFlow
        && list !== undefined && list !== null && list.rows.length > 0 && list.rows.length <= 10

      /**
       * An image caption is capped at 1024 characters, and an image cannot
       * carry buttons or a list. When both are on offer the interactive one
       * wins: a tap moves the conversation forward, a photograph only makes it
       * nicer to look at.
       */
      const useLink =
        !useFlow && !useList && !useButtons
        && link !== undefined && link !== null
        && link.url.startsWith('https://') && body.length <= 1024

      const useImage =
        imageUrl !== undefined && imageUrl !== null && imageUrl.startsWith('https://')
        && body.length <= 1024 && !useList && !useButtons && !useFlow && !useLink

      /**
       * Only a wamid is worth sending. Meta's ids are prefixed, and a value
       * from anywhere else — a row id, an empty string — would fail the send
       * rather than the quote.
       */
      const quote =
        typeof quotesProviderId === 'string' && quotesProviderId.startsWith('wamid.')
          ? { context: { message_id: quotesProviderId } }
          : {}

      const payload = useFlow
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            ...quote,
            type: 'interactive',
            interactive: {
              type: 'flow',
              body: { text: body },
              action: {
                name: 'flow',
                parameters: {
                  flow_message_version: '3',
                  flow_id: flow.id,
                  flow_token: flow.token,
                  flow_cta: flow.cta.slice(0, 20),
                  // navigate rather than data_exchange: the screen is handed
                  // everything it needs here, so there is no endpoint to call
                  // and no keys to hold.
                  flow_action: 'navigate',
                  ...(flow.draft === true ? { mode: 'draft' } : {}),
                  flow_action_payload: { screen: flow.screen, data: flow.data },
                },
              },
            },
          }
        : useLink
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            ...quote,
            type: 'interactive',
            interactive: {
              type: 'cta_url',
              body: { text: body },
              action: {
                name: 'cta_url',
                parameters: { display_text: link.label.slice(0, 20), url: link.url },
              },
            },
          }
        : useImage
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            ...quote,
            type: 'image',
            image: {
              link: imageUrl,
              // A blank caption is omitted rather than sent: the second and
              // third photographs of a car say nothing, and " " under a picture
              // is a visible artefact of how it was stored.
              ...(body.trim() === '' ? {} : { caption: body }),
            },
          }
        : useList
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            ...quote,
            type: 'interactive',
            interactive: {
              type: 'list',
              body: { text: body },
              action: {
                button: list.button.slice(0, 20),
                sections: [{
                  rows: list.rows.map((r) => ({
                    id: r.id.slice(0, 200),
                    title: r.title.slice(0, 24),
                    // Omitted rather than sent empty: Meta rejects a blank
                    // description where it accepts an absent one.
                    ...(r.description === undefined || r.description === ''
                      ? {}
                      : { description: r.description.slice(0, 72) }),
                  })),
                }],
              },
            },
          }
        : useButtons
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            ...quote,
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text: body },
              action: {
                buttons: buttons.map((b) => ({
                  type: 'reply',
                  // Titles are capped at 20 characters by Meta. Truncated here
                  // as a last resort so a long one degrades instead of
                  // rejecting the whole send.
                  reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
                })),
              },
            },
          }
        : {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            ...quote,
            type: 'text',
            text: { preview_url: false, body },
          }

      let response: Response
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        // We never saw a response. Meta may still have accepted the send.
        throw new MetaUnknownOutcomeError(
          error instanceof Error ? error.message : String(error),
        )
      }

      const text = await response.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }

      if (!response.ok) {
        const error = (parsed as { error?: { message?: string; code?: number } } | null)?.error
        throw new MetaApiError(
          error?.message ?? `HTTP ${response.status}`,
          response.status,
          error?.code ?? null,
          !isPermanent(response.status),
        )
      }

      const providerMessageId = (
        parsed as { messages?: Array<{ id?: string }> } | null
      )?.messages?.[0]?.id

      if (typeof providerMessageId !== 'string') {
        // A 200 without an id means it probably went, but we cannot record what.
        throw new MetaUnknownOutcomeError('accepted without a message id')
      }

      return { providerMessageId }
    },
  }
}
