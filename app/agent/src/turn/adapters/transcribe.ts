/**
 * A voice note, in words.
 *
 * WhatsApp voice notes are files rather than a live stream, so this is
 * `gpt-transcribe` — the file endpoint — and not `gpt-live-transcribe`, which
 * is for streaming. whisper-1 and gpt-4o-transcribe were deprecated on 26
 * August 2026 and shut down in February 2027; both are the model memory
 * suggests, and both are wrong.
 *
 * Returns null for anything that is not a clean, non-empty transcript. A voice
 * note this cannot read is a voice note for a person, which is the behaviour
 * that already exists and works — there is no version of this where guessing
 * is better than handing it over.
 */

/** Long enough for a real note, short enough that a stuck call is not a turn. */
const TIMEOUT_MS = 30_000

/**
 * Meta sends voice notes as audio/ogg, and the endpoint reads the extension.
 * A wrong one is a 400 on a file that would otherwise have transcribed.
 */
const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
}

export type Transcriber = (input: {
  /** The file itself. Typed as a view over an ArrayBuffer so Blob accepts it. */
  bytes: Uint8Array<ArrayBuffer>
  mimeType: string
}) => Promise<string | null>

export function openaiTranscriber(options: {
  apiKey: string
  model?: string
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Transcriber {
  const model = options.model ?? 'gpt-transcribe'
  const baseUrl = options.baseUrl ?? 'https://api.openai.com'
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const doFetch = options.fetchImpl ?? fetch

  return async ({ bytes, mimeType }) => {
    const extension = EXTENSIONS[mimeType.toLowerCase()]
    if (extension === undefined) return null
    if (bytes.byteLength === 0) return null

    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mimeType }), `note.${extension}`)
    form.append('model', model)
    /**
     * Free-form context, which the transcription guide supports and which is
     * worth more here than anywhere: these are car names in a Gulf accent, and
     * "Huracán" is not a word a general model expects to hear.
     */
    form.append(
      'prompt',
      'A customer messaging a Dubai luxury car rental company. Car names likely to '
      + 'appear: Lamborghini Huracán, Ferrari, Rolls-Royce Cullinan, Bentley, '
      + 'McLaren, Porsche, Range Rover, G63. Places: Dubai Marina, Downtown, JBR, '
      + 'Palm Jumeirah, Abu Dhabi, Sharjah. Amounts are in AED.',
    )

    try {
      const response = await doFetch(`${baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return null

      const body = (await response.json()) as { text?: unknown }
      if (typeof body.text !== 'string') return null

      const text = body.text.trim()
      return text === '' ? null : text
    } catch {
      return null
    }
  }
}
