import Link from 'next/link'
import { getNavCounts, getSetupState, whoConfirmedTheAnswers } from '@vyra/db'
import { SiteNav } from '../site-nav'
import { requireActor } from '@/lib/auth'
import { actorReads } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * What is still missing before this agent is any use.
 *
 * An empty Vyra is not visibly broken, which is the problem. It has no cars so
 * it offers to check with the team; it has no answers so it offers to check
 * with the team. Everything it does is correct and the result is a product
 * that appears to work and sells nothing. This page is the difference between
 * that and knowing which three things to go and do.
 */
export default async function SetupPage() {
  const actor = await requireActor()
  const [counts, setup, confirmers] = await actorReads(actor, (run) => Promise.all([
    getNavCounts(run, actor.operatorId),
    getSetupState(run, actor.operatorId),
    whoConfirmedTheAnswers(run, actor.operatorId),
  ]))

  const done = setup.steps.length - setup.remaining

  return (
    <main className="shell">
      <SiteNav current="setup" counts={counts} />
      <h1>Getting {actor.operatorName} ready</h1>
      <p className="muted">
        {setup.blocked === 0
          ? `Nothing is stopping the agent from selling. ${done} of ${setup.steps.length} done.`
          : `${setup.blocked} ${setup.blocked === 1 ? 'thing stops' : 'things stop'} the agent`
            + ` working at all. Until then every reply is an offer to check with the team.`}
      </p>

      <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0', display: 'grid', gap: '0.5rem' }}>
        {setup.steps.map((step) => (
          <li
            key={step.key}
            className="card"
            style={{
              borderColor: step.done ? undefined : step.blocking ? 'var(--accent)' : undefined,
              opacity: step.done ? 0.6 : 1,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 20rem' }}>
                <strong>
                  {step.done ? '✓ ' : ''}{step.title}
                </strong>
                {!step.done && step.blocking && (
                  <span className="muted" style={{ fontSize: '0.75rem' }}> · needed before it can sell</span>
                )}
                {!step.done && (
                  <p className="muted" style={{ fontSize: '0.83rem', margin: '0.3rem 0 0' }}>{step.why}</p>
                )}
                {step.detail !== null && (
                  <p className="muted" style={{ fontSize: '0.78rem', margin: '0.3rem 0 0' }}>{step.detail}</p>
                )}
              </div>
              {step.href !== null && !step.done && (
                <Link className="button secondary" href={step.href}>Go</Link>
              )}
            </div>
          </li>
        ))}
      </ul>

      {/*
        Not a step, because there is no state in which it is finished — and the
        one signal that used to answer it no longer can. Publishing sets
        provenance to operator_confirmed whatever the content was, so the only
        remaining evidence that a real person agreed to an answer is the name
        they signed it with.
      */}
      <section>
        <h2 style={{ fontSize: '1.05rem' }}>Who stands behind your answers</h2>
        {confirmers.length === 0 ? (
          <p className="card muted">Nothing published yet.</p>
        ) : (
          <>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0.8rem 0 0', display: 'grid', gap: '0.4rem' }}>
              {confirmers.map((who) => (
                <li
                  key={who.confirmedBy}
                  className="card"
                  style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}
                >
                  <span>{who.confirmedBy}</span>
                  <span className="muted">
                    {who.topics} {who.topics === 1 ? 'answer' : 'answers'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.8rem' }}>
              These answers are stated to customers as fact, in your name. A name here that is not
              a person at your company is an answer nobody has agreed to.
            </p>
          </>
        )}
      </section>
    </main>
  )
}
