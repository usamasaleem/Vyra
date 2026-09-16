/**
 * The customer asking to see the car.
 *
 * Photographs are normally sent once: someone asking three questions about the
 * same Huracán should not get the same picture three times, and repeating it is
 * what a bot does.
 *
 * That rule is right for an incidental mention and wrong the moment they ask.
 * Live, a customer said "Can you send me more images related to this car" and
 * then "show me side profile", and got prose both times — because the pictures
 * had already been sent once. Worse, the agent told them it could not send a
 * photograph at all, which had stopped being true an hour earlier.
 *
 * So an explicit request overrides the once-only rule, and shows the ones they
 * have not seen.
 */
/**
 * Asking for pictures by name. Unambiguous, and nothing overrides these.
 */
const EXPLICIT: RegExp[] = [
  /\b(?:show|send|see|share)\b[^.?!]{0,30}\b(?:photo|photos|picture|pictures|image|images|pic|pics)\b/i,
  /\b(?:photo|photos|picture|pictures|image|images|pic|pics)\b[^.?!]{0,20}\b(?:please|pls)\b/i,
  /\b(?:more|other|another|different)\b[^.?!]{0,15}\b(?:photo|photos|picture|pictures|image|images|pic|pics|angle|angles|view|views|shot|shots)\b/i,
  /\bany (?:photo|photos|picture|pictures|image|images|pic|pics)\b/i,
  /\bwhat does it look like\b/i,
  /\b(?:show|see)\b[^.?!]{0,25}\b(?:side|front|rear|back|inside|interior|cabin|profile)\b/i,
]

/**
 * Asking to be shown the car itself, which is the same request in the words
 * people actually use.
 *
 * "Can you show me the lambo?" named the car rather than the pictures, matched
 * nothing, and the photographs were suppressed — while the reply said they were
 * attached. Every pattern here was written from a real message.
 */
const IMPLICIT: RegExp[] = [
  /\b(?:show|send)\s+(?:me|us)\b/i,
  /\b(?:can|could|may)\s+(?:i|we)\s+see\b/i,
  /\blet(?:'|\u2019)?s\s+see\b/i,
  /\bi(?:'|\u2019)?d?\s+(?:like|want|wanna)\s+to\s+see\b/i,
  /\bhow does it look\b/i,
]

/**
 * What makes "show me the X" a request for information rather than a picture.
 *
 * The implicit patterns are broad on purpose, so they need this: "show me the
 * price" and "can I see the rates" are the same shape as "show me the Huracán"
 * and must not send photographs instead of an answer.
 *
 * Applied only to the implicit patterns. Someone who says "show me the photos
 * and the price" asked for both, and the picture noun settles it.
 */
const NOT_A_PICTURE =
  /\b(?:price|prices|pricing|rate|rates|cost|costs|quote|quotation|total|invoice|options|list|availability|calendar|dates|terms|conditions|contract|documents|paperwork|licence|license|discount|deal|deals|offer|offers)\b/i

export function asksToSeePhotos(text: string | null): boolean {
  if (text === null || text.trim() === '') return false
  if (EXPLICIT.some((p) => p.test(text))) return true
  return IMPLICIT.some((p) => p.test(text)) && !NOT_A_PICTURE.test(text)
}

/**
 * The reply telling the customer a photograph is attached.
 *
 * The prompt forbids mentioning it, for exactly the reason this exists: when
 * the model never narrates the attachment, a turn that attaches nothing is
 * invisible rather than a lie. Live, it narrated one anyway — "I've attached
 * the photos here" — on a turn that attached nothing, and the customer was
 * left looking for pictures that were never sent.
 *
 * So the claim is detected and honoured rather than argued with. The model has
 * already told the customer something on the operator's behalf; the cheapest
 * way to make it true is to send the photographs.
 */
const CLAIMS_ATTACHED: RegExp[] = [
  /\b(?:attached|attaching|sending|sent|here are|here's|here is)\b[^.?!]{0,40}\b(?:photo|photos|picture|pictures|image|images|pic|pics|shot|shots)\b/i,
  /\b(?:photo|photos|picture|pictures|image|images|pic|pics)\b[^.?!]{0,30}\b(?:attached|below|here|coming through)\b/i,
  /\b(?:have a look|take a look)\b[^.?!]{0,25}\b(?:photo|photos|picture|pictures|image|images|pic|pics|below|these)\b/i,
]

export function claimsPhotosAttached(reply: string | null): boolean {
  if (reply === null || reply.trim() === '') return false
  const flat = reply.replace(/[\u2018\u2019]/g, "'")
  return CLAIMS_ATTACHED.some((p) => p.test(flat))
}
