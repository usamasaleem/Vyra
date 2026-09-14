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
}

export type SendTextResult = {
  providerMessageId: string
}

export type WhatsAppClient = {
  sendText(input: SendTextInput): Promise<SendTextResult>
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

  return {
    async sendText({ to, body, buttons }) {
      const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`

      /**
       * An interactive body is capped at 1024 characters where a text message
       * allows 4096, so a long reply sends as plain text rather than failing.
       * Losing two buttons is a smaller loss than losing the message.
       */
      const useButtons =
        buttons !== undefined && buttons !== null && buttons.length > 0
        && buttons.length <= 3 && body.length <= 1024

      const payload = useButtons
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
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
