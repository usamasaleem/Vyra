import { POLICY_TOPICS } from '@vyra/contracts'
import { listKnowledge } from '@vyra/db'
import { permissions, requireActor } from '@/lib/auth'
import { actorRunner } from '@/lib/db'
import { SiteNav } from '../site-nav'
import { AnswerForm } from './answer-form'

/**
 * The six questions only the operator can answer, and the screen where the
 * answers land.
 *
 * Every part of this existed except the screen. draftKnowledge, publishKnowledge,
 * versioning, a check constraint that refuses to publish anything without a
 * named confirmer — all built, none reachable by the person who has the
 * answers. The table has been empty since the agent went live, which is why
 * roughly seven in ten of its replies are "let me check with the team".
 *
 * Unanswered topics are listed first and look unfinished on purpose. A page
 * that showed only what exists could not show what is missing, which is the
 * entire point of this one.
 */
export const dynamic = 'force-dynamic'

const TOPIC_LABELS: Record<string, { question: string; placeholder: string }> = {
  deposit: {
    question: 'What is the security deposit, and when is it returned?',
    placeholder: 'If it differs by car or category, say so — the agent quotes this exactly as written.',
  },
  'included-kilometres': {
    question: 'How many kilometres are included, and what is charged beyond that?',
    placeholder: 'Per day or per rental, and the rate per extra kilometre.',
  },
  'driver-requirements-resident': {
    question: 'What does a UAE resident need to rent?',
    placeholder: 'Licence, Emirates ID, minimum age, minimum time held, anything else.',
  },
  'driver-requirements-visitor': {
    question: 'What does a visitor need to rent?',
    placeholder: 'Passport, home licence, International Driving Permit, minimum age — and which nationalities differ.',
  },
  'delivery-areas': {
    question: 'Where do you deliver, what does it cost, and can the car leave Dubai?',
    placeholder: 'Areas and fees, and whether cross-emirate or cross-border travel is allowed.',
  },
  'business-hours': {
    question: 'When are you open, and what happens to a message out of hours?',
    placeholder: 'Days and times, and what a customer should expect at 2am.',
  },
  'follow-up-timing': {
    question: 'When should the agent chase a customer who has gone quiet, and what may it say?',
    placeholder: 'How long to wait, how many times, and the wording you are happy to send.',
  },
}

export default async function KnowledgePage() {
  const actor = await requireActor()
  const rows = await listKnowledge(actorRunner(actor), actor.operatorId)
  const canEdit = permissions.canAdminister(actor)

  /** The live answer per topic: published, and not yet superseded. */
  const live = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const topic = row['topic'] as string
    if (row['published_at'] != null && row['effective_to'] == null && !live.has(topic)) {
      live.set(topic, row)
    }
  }

  const answered = POLICY_TOPICS.filter((t) => live.has(t))
  const unanswered = POLICY_TOPICS.filter((t) => !live.has(t))

  return (
    <main className="shell">
      <SiteNav current="knowledge" actor={actor} />
      <h1>What the agent may say</h1>
      <p className="muted">
        The agent answers these from here and from nowhere else. A question with no answer below is
        one it must hand to a person — which is correct, and slower than answering.
      </p>

      {unanswered.length > 0 && (
        <p className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
          {unanswered.length} of {POLICY_TOPICS.length} unanswered. These are the questions customers
          ask before they will commit to anything.
        </p>
      )}

      <ul style={{ listStyle: 'none', padding: 0, margin: '1.5rem 0 0', display: 'grid', gap: '1rem' }}>
        {[...unanswered, ...answered].map((topic) => {
          const row = live.get(topic)
          const answer = row === undefined ? null : (row['answer'] as string)
          const meta = TOPIC_LABELS[topic]

          return (
            <li key={topic} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                <strong>{meta?.question ?? topic}</strong>
                {answer === null
                  ? <span className="tag">unanswered</span>
                  : (
                    <span className="muted" style={{ fontSize: '0.78rem' }}>
                      v{String(row!['version'])} · confirmed by {String(row!['confirmed_by'])}
                    </span>
                  )}
              </div>

              {answer !== null && (
                <p style={{ margin: '0.6rem 0 0', whiteSpace: 'pre-wrap' }}>{answer}</p>
              )}

              {canEdit ? (
                <div style={{ marginTop: '0.9rem' }}>
                  <AnswerForm
                    topic={topic}
                    current={answer}
                    placeholder={meta?.placeholder ?? ''}
                  />
                </div>
              ) : (
                answer === null && (
                  <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
                    Only an administrator can publish an answer.
                  </p>
                )
              )}
            </li>
          )
        })}
      </ul>

      <p className="muted" style={{ fontSize: '0.8rem', marginTop: '1.5rem' }}>
        Replacing an answer keeps the old one. A customer told something in September can still be
        shown what the answer was that day.
      </p>
    </main>
  )
}
