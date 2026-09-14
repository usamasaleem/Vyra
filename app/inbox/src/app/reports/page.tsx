import Link from 'next/link'
import { formatDuration, getMetrics } from '@vyra/db'
import { requireActor } from '@/lib/auth'
import { queryRunner } from '@/lib/db'

/**
 * Build plan step 32 — the ten measures section 15 asks for, and only those.
 *
 * The spec names what does not belong here: "Fleet, availability, vehicle
 * utilisation, delivery, maintenance, payment, deposit, document, and
 * operational reports belong to the Operations Agent." A sales report that
 * drifts into fleet utilisation is answering somebody else's question, and the
 * ten below are the ones that tell an operator whether this is working.
 */
export const dynamic = 'force-dynamic'

const RANGES = { today: 1, week: 7, month: 30 } as const

const LOST_REASON_LABEL: Record<string, string> = {
  price: 'Price',
  availability: 'Nothing available',
  vehicle_not_available: 'That car was gone',
  too_slow: 'We were too slow',
  went_elsewhere: 'Went elsewhere',
  not_eligible: 'Not eligible',
  no_response: 'Went quiet',
  not_serious: 'Not serious',
  other: 'Other',
}

function Measure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: '0.78rem', letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 600, marginTop: '0.2rem' }}>{value}</div>
      {note !== undefined && (
        <div className="muted" style={{ fontSize: '0.76rem', marginTop: '0.15rem' }}>{note}</div>
      )}
    </div>
  )
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: keyof typeof RANGES }>
}) {
  const actor = await requireActor()
  const { range } = await searchParams
  const days = RANGES[range ?? 'week'] ?? 7
  const m = await getMetrics(queryRunner(), actor.operatorId, new Date(Date.now() - days * 86_400_000))

  const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`)

  return (
    <main className="shell">
      <h1>Reporting</h1>
      <p className="muted">
        The ten sales measures. Fleet, utilisation, payments and maintenance belong to Operations,
        not here.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', margin: '1.5rem 0 1rem', flexWrap: 'wrap' }}>
        <Link className="button secondary" href="/reports?range=today">Today</Link>
        <Link className="button secondary" href="/reports?range=week">7 days</Link>
        <Link className="button secondary" href="/reports?range=month">30 days</Link>
        <Link className="button secondary" href="/">Conversations</Link>
      </div>

      <div className="measures">
        <Measure label="ENQUIRIES" value={String(m.enquiries)} />
        <Measure
          label="FIRST RESPONSE"
          value={formatDuration(m.firstResponseSeconds)}
          note="median"
        />
        <Measure
          label="QUALIFIED"
          value={String(m.qualifiedLeads)}
          note={`${pct(m.qualificationRate)} of enquiries`}
        />
        <Measure label="HANDOFFS" value={String(m.handoffs)} />
        <Measure
          label="TO A SALESPERSON"
          value={formatDuration(m.timeToSalespersonSeconds)}
          note="median, raised to accepted"
        />
        <Measure
          label="QUOTES"
          value={String(m.quoteRequests)}
          note={`${m.quotesSent} sent`}
        />
        <Measure label="WON" value={String(m.won)} />
        <Measure label="LOST" value={String(m.lost)} />
        <Measure
          label="COMPLAINTS"
          value={String(m.complaints)}
          note="disputes and safety"
        />
        {/*
          Given its own emphasis because nothing else in the system can detect
          one. Every safety mechanism prevents a category of error; none of them
          notices a reply that is fluent, permitted and untrue.
        */}
        <Measure
          label="WRONG ANSWERS"
          value={String(m.incorrectAnswers)}
          note="flagged by staff"
        />
      </div>

      <section>
        <h2 style={{ fontSize: '1.05rem' }}>Why leads were lost</h2>
        {m.lostReasons.length === 0 ? (
          <p className="card muted">
            Nothing closed as lost in this window. A lead nobody closes is not a lead that was won.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.8rem 0 0', display: 'grid', gap: '0.4rem' }}>
            {m.lostReasons.map((r) => (
              <li key={r.reason} className="card" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{LOST_REASON_LABEL[r.reason] ?? r.reason}</span>
                <strong>{r.count}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
