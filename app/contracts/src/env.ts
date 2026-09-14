import { z } from 'zod'

/**
 * Fail at boot, not at the first customer message.
 *
 * Per-operator WhatsApp credentials (access token, phone number id) live here
 * only while the pilot runs a single operator. Section 18.5 requires an
 * explicit operator -> account -> number -> credential mapping, so these move
 * into `whatsapp_accounts` before a second operator is onboarded.
 */
const required = z.string().min(1)

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Supabase PostgreSQL connection string. Pooled for web, direct for migrations. */
  DATABASE_URL: required,

  /** Meta app-level secrets. */
  WHATSAPP_VERIFY_TOKEN: required,
  /** Used to verify the X-Hub-Signature-256 HMAC over the raw request body. */
  WHATSAPP_APP_SECRET: required,
  /**
   * Pinned deliberately. v26.0 was the newest version Meta accepted when
   * probed on 13 September 2026; v27.0 and above did not exist. Newest gives
   * the longest support window, but never inherit this from memory — probe
   * the real API before changing it.
   */
  WHATSAPP_API_VERSION: z.string().default('v26.0'),

  /** Pilot-operator channel credentials. Moves to the database — see above. */
  WHATSAPP_ACCESS_TOKEN: required,
  WHATSAPP_PHONE_NUMBER_ID: required,

  /**
   * System-wide AI kill switch. When false, ingestion and staff replies keep
   * working and the AI sends nothing. Section 18.14.
   */
  AI_SENDING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Model credentials. Optional: without a key the worker boots, ingests and
   * serves staff normally, and simply runs no AI turn. A worker that refused
   * to start for the lack of a model would take the inbox down with it.
   */
  OPENAI_API_KEY: z.string().min(1).optional(),

  /**
   * Chosen by the eval sweep on 14 September 2026, not by reputation.
   *
   * gpt-5.6-luna scored identically at low, medium and high effort across all
   * 28 cases — zero blocking failures, 55/55 expectations — and the cheapest of
   * those is the one to pay for. At `none` it stayed safe but grew sloppy,
   * missing 8 expectations, so `low` is the floor rather than the default.
   * Re-run `npm run evals:compare` before changing either.
   */
  AI_MODEL: z.string().default('gpt-5.6-luna'),
  AI_REASONING_EFFORT: z
    .enum(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    .default('low'),

  /**
   * Whether an accepted reply is sent, or written as an internal note for a
   * person to read and send themselves.
   *
   * Separate from AI_SENDING_ENABLED, which decides whether a turn runs at all.
   * Two switches because "stop everything" and "let me see what it would have
   * said" are different questions, and shadow mode (step 33) is the second one.
   * Both default to off: reaching a customer should take a deliberate act.
   */
  AI_AUTOSEND_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

/**
 * Extra configuration the staff inbox needs and the worker does not.
 *
 * Kept separate so the worker is not made to carry variables it has no use
 * for — a worker that refuses to boot for the lack of a browser key would be
 * a confusing failure.
 *
 * The publishable key is designed to be visible in a browser. It is not a
 * secret, and it grants nothing on its own: authorisation is decided by the
 * session and the membership row behind it.
 */
export const webEnvSchema = serverEnvSchema.extend({
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
})

export type WebEnv = z.infer<typeof webEnvSchema>

export function parseWebEnv(source: NodeJS.ProcessEnv = process.env): WebEnv {
  const result = webEnvSchema.safeParse(source)
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }
  return result.data
}

export function parseServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(source)
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }
  return result.data
}
