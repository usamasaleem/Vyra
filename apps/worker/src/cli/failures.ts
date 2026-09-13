import { parseServerEnv } from '@vyra/contracts'
import { createClient } from '@vyra/db'
import {
  listStuckWork,
  reapStaleDispatching,
  retryFailedSend,
  retryOutboxRow,
} from '../failures.js'
import type { QueryRunner } from '../relay.js'

/**
 * The interim surface for step 12's "somewhere a human can see and retry them".
 *
 * The inbox in phase 3 renders the same queries. Until it exists, this is how
 * a person finds stuck work — which is better than it existing only in a table
 * nobody thinks to open.
 *
 *   npm run failures                 list everything stuck
 *   npm run failures -- reap         mark interrupted dispatches as unknown
 *   npm run failures -- retry <id>   retry one item
 */

const env = parseServerEnv()
const { sql } = createClient(env.DATABASE_URL, { max: 1 })
const run: QueryRunner = async (text, params) =>
  (await sql.unsafe(text, params as never[])) as never

const [command = 'list', argument] = process.argv.slice(2)

try {
  if (command === 'list') {
    const items = await listStuckWork(run)
    if (items.length === 0) {
      console.log('Nothing stuck.')
    } else {
      console.log(`${items.length} item(s) needing attention:\n`)
      for (const item of items) {
        const flag = item.safeToRetry ? '' : '   [NOT safe to retry automatically]'
        console.log(`  ${item.occurredAt.toISOString()}  ${item.kind}${flag}`)
        console.log(`    id:     ${item.id}`)
        console.log(`    detail: ${item.detail}`)
        console.log()
      }
      if (items.some((i) => !i.safeToRetry)) {
        console.log('Items marked NOT safe to retry may already have reached the customer.')
        console.log('Meta accepted the send and the response was lost, so retrying could send it twice.')
        console.log('Check the conversation on WhatsApp before deciding.')
      }
    }
  } else if (command === 'reap') {
    const { reaped } = await reapStaleDispatching(run)
    console.log(`Marked ${reaped} interrupted dispatch(es) as unknown.`)
  } else if (command === 'retry') {
    if (argument === undefined) {
      console.error('Usage: npm run failures -- retry <id>')
      process.exitCode = 1
    } else {
      const asOutbox = await retryOutboxRow(run, argument)
      const result = asOutbox.retried ? asOutbox : await retryFailedSend(run, argument)
      if (result.retried) {
        console.log(`Requeued ${argument}.`)
      } else if (result.reason === 'refused_ambiguous') {
        console.error(`Refused: ${argument} has an unknown outcome and may already have been delivered.`)
        console.error('Confirm on WhatsApp first. Retrying could send the customer the same message twice.')
        process.exitCode = 1
      } else {
        console.error(`Could not retry ${argument}: ${result.reason}`)
        process.exitCode = 1
      }
    }
  } else {
    console.error(`Unknown command '${command}'. Use list, reap or retry.`)
    process.exitCode = 1
  }
} finally {
  await sql.end()
}
