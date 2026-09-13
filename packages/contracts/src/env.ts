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
  WHATSAPP_API_VERSION: z.string().default('v21.0'),

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
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

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
