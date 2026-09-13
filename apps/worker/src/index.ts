import { parseServerEnv } from '@vyra/contracts'

const env = parseServerEnv()

console.log(`vyra worker starting (node ${process.version}, env ${env.NODE_ENV})`)
console.log('no task list registered yet — build plan step 10')
