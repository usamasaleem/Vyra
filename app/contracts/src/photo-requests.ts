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
/**
 * ⚠️ The Arabic patterns below are model-written and want a native speaker's
 * eye, the same caveat `opt-out.ts` carries. The stakes are far lower here.
 * An opt-out matched wrongly silences a customer who is still trying to rent
 * a car; one of these matched wrongly offers a photograph nobody asked for,
 * or a list of cars beside an answer about something else. A miss costs the
 * thing not happening, which is exactly what happens today for every Arabic
 * message. So these lean generous where opt-out leans literal.
 */
const EXPLICIT: RegExp[] = [
  // Arabic. صورة/صور photo(s), أرسل/ابعت send, أشوف/شوف see, شكلها "what does
  // it look like", من الداخل "inside".
  /(?:صور|صورة|صوره)/,
  /(?:أرسل|ارسل|ابعت|ابعثل?ي|شارك)[^.?!]{0,20}(?:صور|صورة)/,
  /(?:أشوف|اشوف|شوف|أرى|ارى|نشوف)[^.?!]{0,20}(?:صور|صورة|السيارة|شكل)/,
  /شكل(?:ها|ه|هم)|كيف تبدو|وش شكل/,
  /من\s*الداخل|الداخلية|المقصورة/,

  /**
   * The verb in every form somebody writes it.
   *
   * It was `\bsend\b`, and a word boundary does not exist inside "resend" or
   * before the g in "sending" — so "can you resend the photos" and "are you
   * sending the images again or not?" both matched nothing. Both are real
   * messages from one conversation, and the customer had to ask three times.
   */
  /\b(?:re-?)?(?:show|send|share|see)(?:s|ing|ed)?\b[^.?!]{0,30}\b(?:photo|photos|picture|pictures|image|images|pic|pics)\b/i,
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
  /**
   * Asking for the last thing again, without naming it.
   *
   * "can you send again" is the whole message, and in context the last thing
   * sent was photographs. Implicit rather than explicit on purpose, so
   * NOT_A_PICTURE below still catches "can you send the quote again".
   */
  /\b(?:re-?)?(?:show|send)(?:s|ing|ed)?\b[^.?!]{0,25}\bagain\b/i,
  /\bre-?send(?:s|ing|ed)?\b/i,
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
  /**
   * A promise to send them, which is the same debt in the future tense.
   *
   * Live: "Sure — I'll get the green Huracán Tecnica photos resent, with a few
   * different angles", to a customer who had just typed "can you send again".
   * Nothing followed it. Sending is something this turn can do now, so a reply
   * that says it will is a reply that should have.
   */
  /\b(?:i'?ll|i will|let me|going to|gonna)\b[^.?!]{0,30}\b(?:send|get|share|resend|forward)\b[^.?!]{0,40}\b(?:photo|photos|picture|pictures|image|images|pic|pics|angle|angles|shot|shots|them|these)\b/i,
  /\b(?:resend|resent|send (?:them |those )?(?:again|over|across))\b/i,
  /\b(?:attached|attaching|sending|here are|here's|here is)\b[^.?!]{0,40}\b(?:photo|photos|picture|pictures|image|images|pic|pics|shot|shots)\b/i,
  /\b(?:photo|photos|picture|pictures|image|images|pic|pics)\b[^.?!]{0,30}\b(?:attached|below|here|coming through)\b/i,
  /\b(?:have a look|take a look)\b[^.?!]{0,25}\b(?:photo|photos|picture|pictures|image|images|pic|pics|below|these)\b/i,
]

/**
 * Whether the reply has put us in debt for photographs — by saying they are
 * attached, or by promising to send them.
 *
 * Renamed from claimsPhotosAttached when the future tense was added, because
 * the old name stopped describing half of what it catches. Both are the same
 * failure: a sentence about photographs that no photographs follow.
 */
/**
 * "Sent", which is a claim only when it is about now.
 *
 * "I've sent the photos" says they are on their way. "I sent you a few photos
 * this morning" points at ones already in the chat — which is exactly what the
 * instructions ask it to say when a car comes up again. Live, that sentence
 * was read as a claim, and the same four photographs went out a second time,
 * forty-three seconds after the first.
 */
const SENT_PHOTOS =
  /\bsent\b[^.?!]{0,40}\b(?:photo|photos|picture|pictures|image|images|pic|pics|shot|shots)\b/i
const POINTS_BACK =
  /\b(?:earlier|already|before|this morning|this afternoon|yesterday|above|ago|last|previously|on (?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i

export function photosPromisedIn(reply: string | null): boolean {
  if (reply === null || reply.trim() === '') return false
  const flat = reply.replace(/[\u2018\u2019]/g, "'")
  if (CLAIMS_ATTACHED.some((p) => p.test(flat))) return true
  return flat
    .split(/(?<=[.?!])\s+/)
    .some((sentence) => SENT_PHOTOS.test(sentence) && !POINTS_BACK.test(sentence))
}
