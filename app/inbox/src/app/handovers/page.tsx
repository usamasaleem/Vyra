import {
  bookingChecklist, formatMoney, getApprovedAnswer, getNavCounts, listConfirmedBookings,
  remindersSent, whatIsOwed, type Checklist,
} from '@vyra/db'
import { formatDateForMessage } from '@vyra/contracts'
import { permissions, requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'
import { SiteNav } from '../site-nav'
import { ReturnForm } from './return-form'

/**
 * Where the cars are going, and when they come back.
 *
 * The diary on /bookings answers "what did we agree". This answers the
 * question somebody has at eight in the morning: which cars leave today, to
 * where, at what time, and is anything still missing before a driver goes —
 * and which ones are due back, or should have been.
 */
export const dynamic = 'force-dynamic'

type Row = {
  kind: 'out' | 'back'
  date: string
  time: string | null
  bookingId: string
  conversationId: string
  who: string
  list: Checklist
  depositState: string | null
  reminded: boolean
}

const civilToday = (tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())

const addDays = (civil: string, n: number): string => {
  const d = new Date(`${civil}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const day = (civil: string) => formatDateForMessage(new Date(`${civil}T12:00:00Z`), 'UTC')

export default async function HandoversPage() {
  const actor = await requireActor()
  const canAnswer = permissions.canReply(actor)

  const { counts, rows, tz, collectionPoint } = await actorReads(actor, async (run) => {
    const [operator] = await run(`select timezone from operators where id = $1`, [actor.operatorId])
    const timezone = (operator?.['timezone'] as string | undefined) ?? 'UTC'
    const all = await listConfirmedBookings(run, actor.operatorId)
    const sent = await remindersSent(run, {
      operatorId: actor.operatorId, bookingIds: all.map((b) => b.bookingId),
    })
    const out: Row[] = []
    for (const b of all) {
      const list = await bookingChecklist(run, { operatorId: actor.operatorId, bookingId: b.bookingId })
      if (list === null) continue
      const owed = await whatIsOwed(run, { operatorId: actor.operatorId, bookingId: b.bookingId })
      const who = b.customerName ?? b.customer
      if (list.startDate !== null) {
        out.push({
          kind: 'out', date: list.startDate, time: list.deliveryTime, bookingId: b.bookingId,
          conversationId: b.conversationId, who, list, depositState: null,
          reminded: sent.has(`handover-reminder:${b.bookingId}`),
        })
      }
      if (list.endDate !== null) {
        out.push({
          kind: 'back', date: list.endDate, time: list.returnTime, bookingId: b.bookingId,
          conversationId: b.conversationId, who, list,
          depositState: owed.find((o) => o.kind === 'deposit')?.state ?? null,
          reminded: sent.has(`return-reminder:${b.bookingId}`),
        })
      }
    }
    const point = await getApprovedAnswer(run, actor.operatorId, 'collection-point')
    return {
      counts: await getNavCounts(run, actor.operatorId),
      rows: out,
      tz: timezone,
      collectionPoint: point?.answer ?? null,
    }
  })

  const today = civilToday(tz)
  const tomorrow = addDays(today, 1)
  const weekOut = addDays(today, 7)
  const byTime = (a: Row, b: Row) =>
    a.date.localeCompare(b.date) || (a.time ?? '99').localeCompare(b.time ?? '99')

  const sections: Array<{ title: string; rows: Row[]; empty: string }> = [
    {
      title: 'Overdue returns',
      rows: rows.filter((r) => r.kind === 'back' && r.date < today && r.list.returnedAt === null)
        .sort(byTime),
      empty: '',
    },
    { title: `Today — ${day(today)}`, rows: rows.filter((r) => r.date === today).sort(byTime), empty: 'Nothing going out or coming back today.' },
    { title: `Tomorrow — ${day(tomorrow)}`, rows: rows.filter((r) => r.date === tomorrow).sort(byTime), empty: 'Nothing tomorrow.' },
    {
      title: 'The rest of the week',
      rows: rows.filter((r) => r.date > tomorrow && r.date <= weekOut).sort(byTime),
      empty: 'Nothing else in the next seven days.',
    },
  ]

  return (
    <main className="shell">
      <SiteNav current="handovers" counts={counts} />
      <h1>Handovers</h1>
      <p className="muted">
        Every car going out and coming back, by day. The agent collects the time, the place, the
        documents and the payment; this is where you see what is still missing before a driver
        goes, and where you mark a car back.
      </p>

      {sections.map((section) => (section.rows.length === 0 && section.empty === '' ? null : (
        <section key={section.title} style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1.05rem' }}>{section.title}</h2>
          {section.rows.length === 0 ? (
            <p className="card">{section.empty}</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0.6rem 0 0', display: 'grid', gap: '0.6rem' }}>
              {section.rows.map((r) => (
                <li key={`${r.kind}-${r.bookingId}`} className="card">
                  <HandoverRow row={r} collectionPoint={collectionPoint} canAnswer={canAnswer} today={today} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )))}
    </main>
  )
}

function HandoverRow({
  row, collectionPoint, canAnswer, today,
}: { row: Row; collectionPoint: string | null; canAnswer: boolean; today: string }) {
  const { list } = row
  const money = (minor: number) => formatMoney(minor, list.currency)
  const how = list.handover === 'delivery' ? 'Delivery' : list.handover === 'collection' ? 'Collection' : 'Not chosen yet'

  const place = row.kind === 'out'
    ? (list.handover === 'delivery'
      ? list.deliveryAddress ?? 'address not given yet'
      : list.handover === 'collection' ? collectionPoint ?? 'collection point not written under Answers' : '—')
    : (list.handover === 'delivery'
      ? list.returnAddress ?? 'pick-up address not given yet'
      : 'back to you')

  const payment = list.owedMinor === 0
    ? 'paid'
    : list.paymentPlan === 'on_delivery'
      ? `${money(list.owedMinor)} to take at the handover`
      : list.customerReportedPaidAt !== null
        ? `${money(list.owedMinor)} — customer says paid, check the account`
        : `${money(list.owedMinor)} not paid`

  const documents = list.documentsCheckedAt !== null
    ? 'checked'
    : list.documents === 0 ? 'none yet' : `${list.documents} received, not checked`

  return (
    <div className="stack" style={{ gap: '0.35rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <strong>{row.time ?? 'time not set'} · {row.kind === 'out' ? `Going out — ${how}` : 'Coming back'}</strong>
          <div className="muted" style={{ fontSize: '0.88rem' }}>
            {list.vehicle ?? 'Car'} · {row.who} · {place}
            {row.date !== today && row.kind === 'back' && row.date < today ? ` · was due ${day(row.date)}` : ''}
          </div>
        </div>
        <a className="button secondary" href={`/conversations/${row.conversationId}`}>Conversation</a>
      </div>

      {row.kind === 'out' ? (
        <div style={{ fontSize: '0.88rem' }}>
          Payment: {payment} · Documents: {documents}
          {row.reminded && <span className="muted"> · day-before message sent</span>}
        </div>
      ) : list.returnedAt !== null ? (
        <div style={{ fontSize: '0.88rem' }}>
          Returned {list.returnedAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
          {row.depositState === 'paid' && (
            <> · deposit still held — <a href="/bookings">give it back on Bookings</a></>
          )}
          {row.depositState === 'refunded' && ' · deposit given back'}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '0.8rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.88rem' }}>
          <span>
            {row.reminded ? 'Return message sent' : 'Return not arranged yet'}
            {row.depositState === 'paid' ? ' · deposit held' : ''}
          </span>
          {canAnswer && <ReturnForm bookingId={row.bookingId} />}
        </div>
      )}
    </div>
  )
}
