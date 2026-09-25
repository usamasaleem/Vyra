/**
 * npm run templates --workspace=app/worker -- status | submit
 *
 * status  what Meta says about each template, synced into the database
 * submit  send the ones Meta does not have yet for review
 */
import { createClient } from '@vyra/db'
import { TEMPLATES } from '@vyra/contracts'
import { createWhatsAppClient } from '../whatsapp/client.js'
import { submitTemplates, syncTemplates, templateAccounts } from '../templates.js'

const command = process.argv[2] ?? 'status'
const { sql } = createClient(process.env['DATABASE_URL']!)
const run = async (text: string, params?: unknown[]) =>
  (await sql.unsafe(text, (params ?? []) as never[])) as unknown as Array<Record<string, unknown>>
const client = createWhatsAppClient({
  apiVersion: process.env['WHATSAPP_API_VERSION'] ?? 'v26.0',
  phoneNumberId: process.env['WHATSAPP_PHONE_NUMBER_ID']!,
  accessToken: process.env['WHATSAPP_ACCESS_TOKEN']!,
})

for (const account of await templateAccounts(run)) {
  if (account.phoneNumberId !== process.env['WHATSAPP_PHONE_NUMBER_ID']) continue
  if (command === 'submit') {
    for (const r of await submitTemplates(run, client, account)) console.log(`${r.name}: ${r.outcome}`)
  }
  await syncTemplates(run, async () => client, (f) => console.log(JSON.stringify(f)))
  const rows = await run(`select name, status, category, rejected_reason from whatsapp_templates where operator_id = $1 order by name`, [account.operatorId])
  for (const t of Object.values(TEMPLATES)) {
    const row = rows.find((r) => r['name'] === t.name)
    console.log(`${t.name.padEnd(24)} ${String(row?.['status'] ?? 'NOT_SUBMITTED').padEnd(14)} ${row?.['category'] ?? t.category}${row?.['rejected_reason'] ? `  rejected: ${row['rejected_reason']}` : ''}`)
  }
}
await sql.end()
