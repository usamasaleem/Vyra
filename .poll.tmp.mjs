import postgres from 'postgres'
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 })
const base = {
  note: (await sql`select max(created_at) as t from conversation_notes`)[0].t,
  out: (await sql`select max(created_at) as t from messages where direction='outbound'`)[0].t,
}
for (let i = 0; i < 45; i++) {
  const jobs = await sql`
    select id, locked_by, attempts, last_error,
           extract(epoch from now() - locked_at)::int as locked_secs
    from graphile_worker._private_jobs`
  const note = (await sql`select max(created_at) as t from conversation_notes`)[0].t
  const out = (await sql`select max(created_at) as t from messages where direction='outbound'`)[0].t
  const stamp = new Date().toISOString().slice(11, 19)

  if (+note > +base.note || +out > +base.out) {
    if (+note > +base.note) {
      const [n] = await sql`select body from conversation_notes order by created_at desc limit 1`
      console.log(`${stamp} DRAFT (shadow mode):`, n.body.replace(/\n/g, ' '))
    }
    if (+out > +base.out) {
      const [m] = await sql`select body, delivery_state from messages where direction='outbound' order by created_at desc limit 1`
      console.log(`${stamp} SENT (${m.delivery_state}):`, m.body)
    }
    break
  }
  if (jobs.length === 0) { console.log(`${stamp} job gone, but produced nothing — skipped (no model on Render)`); break }
  const j = jobs[0]
  console.log(`${stamp} locked ${j.locked_secs}s attempts=${j.attempts}${j.last_error ? ' ERR:' + String(j.last_error).slice(0,100) : ''}`)
  await new Promise((r) => setTimeout(r, 20000))
}
await sql.end()
