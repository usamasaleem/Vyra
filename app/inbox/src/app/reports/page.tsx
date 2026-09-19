import Link from 'next/link'
import { SiteNav } from '../site-nav'
import {
  findQueueBacklog,
  formatDuration,
  formatMoney,
  getAgentCosts,
  getMetrics,
  getNavCounts,
  getQueueWaits,
} from '@vyra/db'
import { requireActor } from '@/lib/auth'
import { actorReads, queryRunner } from '@/lib/db'

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
  const since = new Date(Date.now() - days * 86_400_000)
  const [[counts, m, ai, waits], backlog] = await Promise.all([
    actorReads(actor, (run) => Promise.all([
      getNavCounts(run, actor.operatorId),
      getMetrics(run, actor.operatorId, since),
      getAgentCosts(run, actor.operatorId, since),
      getQueueWaits(run, actor.operatorId, since),
    ])),
    /**
     * Privileged, alone on this page.
     *
     * The queue lives in graphile_worker's own schema, which vyra_app has no
     * access to at all — deliberately: it holds every operator's jobs and is
     * not scoped by anything. Reading it as the restricted role fails with
     * "permission denied for schema graphile_worker", which is the database
     * being right. What is shown is a count, a task name and a duration; no
     * customer data and nothing another operator could be identified from.
     */
    findQueueBacklog(queryRunner()),
  ])

  // Thousands separators, and an em dash when nobody reported a number. "0"
  // would say the turns were free rather than that the provider said nothing.
  const tokens = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'))

  const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`)

  return (
    <main className="shell">
      <SiteNav current="reports" counts={counts} />
      <h1>Reporting</h1>
      <p className="muted">
        The ten sales measures. Fleet, utilisation, payments and maintenance belong to Operations,
        not here.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', margin: '1.5rem 0 1rem', flexWrap: 'wrap' }}>
        <Link className="button secondary" href="/reports?range=today">Today</Link>
        <Link className="button secondary" href="/reports?range=week">7 days</Link>
        <Link className="button secondary" href="/reports?range=month">30 days</Link>
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
        <Measure
          label="BOOKED"
          value={String(m.bookingsConfirmed)}
          note={m.bookingsConfirmed === 0
            ? 'confirmed rentals'
            : `${m.confirmedByAgent} confirmed by the agent`}
        />
        <Measure
          label="DISCOUNTED"
          value={formatMoney(m.discountedMinor, m.discountedCurrency)}
          note="given away by your people"
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

      {/*
        What the AI did and what it cost.
        
        Here rather than on its own page because the question it answers —
        "is this worth running" — is the same question the ten measures above
        answer from the other side.
      */}
      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.05rem' }}>What the agent did</h2>
        <div className="measures" style={{ marginTop: '0.8rem' }}>
          <Measure label="TURNS" value={String(ai.runs)} note={`${ai.conversations} conversations`} />
          <Measure label="MODEL CALLS" value={String(ai.modelCalls)} note="including the tool loop" />
          <Measure label="INPUT TOKENS" value={tokens(ai.inputTokens)} note={`${tokens(ai.cachedInputTokens)} cached`} />
          <Measure
            label="OUTPUT TOKENS"
            value={tokens(ai.outputTokens)}
            note={`${tokens(ai.reasoningTokens)} reasoning`}
          />
        </div>

        {ai.runsWithoutUsage > 0 && (
          <p className="muted" style={{ fontSize: '0.85rem', margin: '0 0 1rem' }}>
            {ai.runsWithoutUsage} turn{ai.runsWithoutUsage === 1 ? '' : 's'} reported no usage, so the
            totals above are missing {ai.runsWithoutUsage === 1 ? 'it' : 'them'}.
          </p>
        )}

        {ai.byModel.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem', display: 'grid', gap: '0.4rem' }}>
            {ai.byModel.map((b) => (
              <li
                key={`${b.modelId}:${b.promptVersion}`}
                className="card"
                style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}
              >
                <span>
                  {b.modelId} <span className="muted">· {b.promptVersion}</span>
                </span>
                <span className="muted">
                  {b.runs} turn{b.runs === 1 ? '' : 's'} · {tokens(b.outputTokens)} out
                </span>
              </li>
            ))}
          </ul>
        )}

        {/*
          How turns ended. 'drafted' is the one worth reading: it was paid for
          and never reached a customer.
        */}
        {ai.byResultState.length > 0 && (
          <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
            {ai.byResultState.map((r) => `${r.runs} ${r.state}`).join(' · ')}
          </p>
        )}

        <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.8rem' }}>
          Tokens, not money. Converting them needs the rates you actually pay, which nothing here
          should invent.
        </p>
      </section>

      {/*
        The wait before anything starts, which is not the same as how long a
        reply takes and until now was not recorded anywhere. A median of a few
        hundred milliseconds beside a maximum of a minute and a half is the
        shape worth catching: it is one customer, not a slow system, and an
        average would bury it.
      */}
      <section>
        <h2 style={{ fontSize: '1.05rem' }}>Before the reply started</h2>

        {backlog.length > 0 && (
          <div className="card" style={{ borderColor: '#b45309', marginBottom: '0.8rem' }}>
            <strong>{backlog.length} job{backlog.length === 1 ? ' is' : 's are'} late right now.</strong>
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
              {backlog.map((j) => (
                <li key={j.jobId} className="muted" style={{ fontSize: '0.85rem' }}>
                  {j.task} · {j.state === 'locked' ? 'held by a worker' : 'waiting for a worker'} for{' '}
                  {formatDuration(j.lateSeconds)}
                  {j.attempts > 0 && ` · ${j.attempts} attempt${j.attempts === 1 ? '' : 's'}`}
                  {j.lastError !== null && ` · ${j.lastError.slice(0, 120)}`}
                </li>
              ))}
            </ul>
            <p className="muted" style={{ fontSize: '0.8rem', margin: '0.6rem 0 0' }}>
              Jobs are serialised per conversation, so one held job is one customer hearing nothing.
              A lock older than ten minutes is released automatically; anything younger is either
              genuinely running or a worker that has just died.
            </p>
          </div>
        )}

        {waits.measured === 0 ? (
          <p className="card muted">
            No turn in this window recorded a wait. Runs from before this was measured have none,
            which is not the same as having waited nothing.
          </p>
        ) : (
          <>
            <div className="measures">
              <Measure
                label="TYPICAL WAIT"
                value={formatDuration(waits.medianMs === null ? null : waits.medianMs / 1000)}
                note={`median of ${waits.measured} turn${waits.measured === 1 ? '' : 's'}`}
              />
              <Measure
                label="SLOWEST 1 IN 20"
                value={formatDuration(waits.p95Ms === null ? null : waits.p95Ms / 1000)}
                note="95th percentile"
              />
              <Measure
                label="LONGEST"
                value={formatDuration(waits.maxMs === null ? null : waits.maxMs / 1000)}
                note="one customer waited this long"
              />
              <Measure
                label="OVER 15 SECONDS"
                value={String(waits.slow)}
                note={waits.slow === 0 ? 'none' : 'each one is a person waiting'}
              />
            </div>
            <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.8rem' }}>
              Measured from when the job became due, which is already two seconds after the message
              arrived — that pause is deliberate, so several messages typed in a row are answered
              once rather than three times. Anything much past it is queue delay.
            </p>
          </>
        )}
      </section>

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
