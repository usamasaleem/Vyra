/**
 * Promises the reply made that nothing in the turn actually started.
 *
 * Live, the agent told a customer "I'll get a salesperson to confirm the
 * highest-priced car and its exact rate for you." It never called
 * request_handoff. No handoff was raised, no task existed, and nobody at the
 * operator learned that a person had been promised. From the customer's side a
 * colleague was coming; from the system's side nothing had happened.
 *
 * That is the worst version of a failure this project keeps finding — a
 * mechanism reaching nobody — because here the thing reaching nobody is a
 * sentence the customer was given and will wait on.
 *
 * Detection is a heuristic and the action it triggers is deliberately the safe
 * one: raise a task a person can dismiss in a second. A false positive costs
 * somebody a glance at a queue. A false negative costs a customer their evening,
 * which is what actually happened.
 *
 * This lives beside the model rather than in the grader because the grader only
 * runs during evaluation, and this failure happens in production. The eval set
 * has its own promise patterns for a different question — whether a reply
 * *claimed* something unsafe — and treats "check" and "confirm" as hedges that
 * make a claim harmless. Those same words are the promise here, so the two
 * cannot share a pattern list.
 *
 * English only, knowingly. The Arabic equivalents need a native speaker, and a
 * pattern invented by guessing would fail silently on the customers it was
 * meant to protect. Recorded in the eval set as an open gap rather than filled
 * with something that looks finished.
 */

/** Somebody at the operator will make contact. */
const PERSON_PROMISED: RegExp[] = [
  // "I'll get / have / ask a salesperson to ...", "I'm getting someone to ..."
  /\b(?:i'?ll|i will|i'?m going to|let me)\b[^.!?]{0,30}\b(?:get|have|ask|grab|check with|speak to|pass(?:ing)? (?:this )?to)\b[^.!?]{0,30}\b(?:salesperson|sales team|colleague|team|someone|a person|manager)\b/i,
  // "a salesperson will come back to you", "the team will message you"
  /\b(?:a |the )?(?:salesperson|sales team|colleague|team|someone|manager)\b[^.!?]{0,30}\b(?:will|is going to|'?ll)\b[^.!?]{0,30}\b(?:contact|call|message|reply|come back|get back|confirm|be in touch|take it from here)\b/i,
  // "passing this to the team", "connecting you with a salesperson"
  /\b(?:passing|handing|connecting|putting) (?:you |this |it )?(?:over |on |through )?(?:to|with)\b[^.!?]{0,30}\b(?:salesperson|sales team|colleague|team|someone|a person|manager)\b/i,
]

/** The agent itself will go and find something out, then return with it. */
const CHECK_PROMISED: RegExp[] = [
  /\b(?:i'?ll|i will|let me)\b[^.!?]{0,20}\b(?:check|confirm|find out|look into|verify)\b/i,
  /\b(?:i'?ll|i will)\b[^.!?]{0,30}\b(?:come back|get back|revert|message you back|let you know)\b/i,
]

export type PromiseKind = 'person' | 'check'

/**
 * What the reply committed the operator to, if anything.
 *
 * 'person' wins over 'check' when both match: "I'll check with the sales team
 * and come back" is a promise of a person, and raising the handoff covers the
 * checking too. Two tasks for one sentence is how a queue becomes noise.
 */
/**
 * Typographic apostrophes, flattened before matching.
 *
 * Every pattern here was written with "I'll" and every real reply says "I’ll" —
 * models produce the curly one and WhatsApp shows it. The first version of this
 * file matched none of the sentences it was written from, which the tests said
 * immediately and a production deploy would not have.
 */
function flatten(text: string): string {
  return text.replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
}

export function promiseMadeIn(reply: string | null): PromiseKind | null {
  if (reply === null || reply.trim() === '') return null
  const text = flatten(reply)
  if (PERSON_PROMISED.some((p) => p.test(text))) return 'person'
  if (CHECK_PROMISED.some((p) => p.test(text))) return 'check'
  return null
}
