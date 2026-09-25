import { TEMPLATES } from '@vyra/contracts'
import { recordTemplateStatus, type QueryRunner } from '@vyra/db'
import type { WhatsAppClient } from './whatsapp/client.js'

/**
 * Keeping what we believe about each template in line with what Meta says.
 *
 * Hourly, because review takes minutes to a day and the answer changes on
 * Meta's side, not ours — approved, rejected, and later paused if customers
 * block the number after one. A template is only sent while this says
 * APPROVED, so a stale status fails safe: it keeps a task a task.
 */
export const TEMPLATE_SYNC_INTERVAL_MS = 60 * 60 * 1000

type Account = { operatorId: string; phoneNumberId: string; wabaId: string }

async function accounts(run: QueryRunner): Promise<Account[]> {
  const rows = await run(
    `select operator_id, phone_number_id, provider_account_id from whatsapp_accounts where active`, [])
  return rows.map((r) => ({
    operatorId: r['operator_id'] as string,
    phoneNumberId: r['phone_number_id'] as string,
    wabaId: r['provider_account_id'] as string,
  }))
}

const OURS = new Map(Object.values(TEMPLATES).map((t) => [`${t.name}:${t.language}`, t]))

export async function syncTemplates(
  run: QueryRunner,
  clientFor: (phoneNumberId: string) => Promise<WhatsAppClient | null>,
  log: (fields: Record<string, unknown>) => void,
): Promise<void> {
  for (const account of await accounts(run)) {
    const client = await clientFor(account.phoneNumberId)
    if (client === null) continue
    const listed = await client.listTemplates(account.wabaId).catch((error: unknown) => {
      log({ event: 'templates.sync_failed', operator: account.operatorId, error: error instanceof Error ? error.message : String(error) })
      return null
    })
    if (listed === null) continue
    for (const t of listed) {
      const ours = OURS.get(`${t.name}:${t.language}`)
      if (ours === undefined) continue
      await recordTemplateStatus(run, {
        operatorId: account.operatorId, name: t.name, language: t.language, category: t.category,
        body: ours.body, status: t.status, providerTemplateId: t.id, rejectedReason: t.rejectedReason,
      })
    }
  }
}

/** Submit every template Meta does not already have, for one operator's account. */
export async function submitTemplates(
  run: QueryRunner,
  client: WhatsAppClient,
  account: Account,
): Promise<Array<{ name: string; outcome: string }>> {
  const existing = new Set((await client.listTemplates(account.wabaId)).map((t) => `${t.name}:${t.language}`))
  const results: Array<{ name: string; outcome: string }> = []
  for (const t of Object.values(TEMPLATES)) {
    if (existing.has(`${t.name}:${t.language}`)) {
      results.push({ name: t.name, outcome: 'already submitted' })
      continue
    }
    try {
      const created = await client.createTemplate(account.wabaId, t)
      await recordTemplateStatus(run, {
        operatorId: account.operatorId, name: t.name, language: t.language, category: created.category,
        body: t.body, status: created.status, providerTemplateId: created.id, submitted: true,
      })
      results.push({ name: t.name, outcome: `submitted — ${created.status}${created.category !== t.category ? ` (Meta filed it as ${created.category})` : ''}` })
    } catch (error) {
      results.push({ name: t.name, outcome: `refused — ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return results
}

export { accounts as templateAccounts }
