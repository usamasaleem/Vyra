/**
 * The customer choosing a car, as opposed to mentioning one.
 *
 * The enquiry's vehicle used to be whatever car the last turn happened to be
 * about, which sounds reasonable until you watch it: across four messages it
 * went Huracán, then Cullinan, then back to Huracán — the last because the
 * customer asked "it's popular as compared to lambo?" and the tool looked the
 * lambo up. A comparison is not a choice, and a car the agent mentions is not
 * a car the customer picked.
 *
 * Thrashing is worse than staleness here. A stale value is at least something
 * the customer once said; a thrashed one is whichever car came up last, and
 * prepare_quote prices from it.
 *
 * So this asks a narrower question than "which car is this turn about": is the
 * customer, in their own words, settling on one.
 */

/** Lower-cased and stripped of accents, so "Huracan" finds "Huracán". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/**
 * What people call these cars when they are not reading the badge.
 *
 * Only the ones this market actually shortens. A longer list would be guessing
 * at names nobody uses.
 */
const NICKNAMES: Record<string, readonly string[]> = {
  lamborghini: ['lambo', 'lambio', 'lamborgini'],
  'rolls-royce': ['rolls', 'roller', 'royce'],
  ferrari: ['ferari'],
  'mercedes-benz': ['merc', 'mercedes'],
}

/**
 * Words that turn a mention into a decision.
 *
 * "actually the cullinan" is a choice. "is it popular compared to the lambo"
 * names a car and chooses nothing.
 */
const CHOOSING = /\b(?:actually|instead|let'?s (?:go|do|say)|i'?ll take|i want|i'?d like|make it|go with|book|choose|prefer|rather have)\b/i

/**
 * Asking about a car rather than for it.
 *
 * Checked only on the bare-name path: a choosing word overrides it, because
 * "I'll take the Ferrari, can I see it" is plainly a decision.
 */
const ASKING_ABOUT = /\b(?:see|show|send|look|photo|photos|picture|pictures|image|images|how much|price|cost|rate|compare|than|vs|popular|better|good|available)\b/i

export type NamedCar = { make: string; model: string }

/** Every fleet car the message names, by make, model, variant or nickname. */
export function carsNamedIn<T extends NamedCar & { variant?: string | null }>(
  message: string | null,
  cars: readonly T[],
): T[] {
  if (message === null || message.trim() === '') return []
  const said = fold(message)

  return cars.filter((car) => {
    const make = fold(car.make)
    const words = [
      fold(`${car.make} ${car.model}`),
      fold(car.model),
      ...(car.variant === null || car.variant === undefined ? [] : [fold(car.variant)]),
      ...(NICKNAMES[make] ?? []),
    ]
    // The make alone counts only when this operator has one of them. With two
    // Lamborghinis, "lambo" names neither in particular.
    if (cars.filter((other) => fold(other.make) === make).length === 1) words.push(make)
    return words.some((word) => word.length >= 3 && said.includes(word))
  })
}

/**
 * The car the customer is settling on, if they are.
 *
 * One car and one only: a message naming two is comparing them. And either a
 * word that makes it a decision, or a message that is little more than the
 * name — "cullinan", "the lambo please" — which is how somebody answers "which
 * one?".
 */
export function carChosenIn<T extends NamedCar & { variant?: string | null }>(
  message: string | null,
  cars: readonly T[],
): T | null {
  const named = carsNamedIn(message, cars)
  if (named.length !== 1 || message === null) return null

  if (CHOOSING.test(message)) return named[0]!

  /**
   * Or barely more than the name — which is how somebody answers "which one?".
   *
   * Six words is "the rolls royce cullinan please" with room. Past that they
   * are saying something about the car rather than picking it, and a question
   * mark settles it either way.
   */
  const words = message.trim().split(/\s+/).length
  if (words > 6 || message.includes('?')) return null

  /**
   * Unless they are asking about it rather than for it. "can i see the lambo"
   * is five words and names one car and is browsing — flipping the enquiry to
   * whichever car somebody wants a photograph of is the same thrash in a
   * politer sentence.
   */
  return ASKING_ABOUT.test(message) ? null : named[0]!
}

/**
 * The customer saying they want it.
 *
 * Read from their message rather than from the reply, which is the difference
 * between this and every other surface decision here. Whether to offer the
 * booking buttons is not a judgement about how the agent phrased something —
 * it is a fact about what the customer just said, and asking a regex to infer
 * intent from the model's prose is what has failed repeatedly.
 *
 * Narrow. "Book" and its neighbours only, and only as a statement about this
 * rental. A question — "can I book online?" — is asking how, not doing it.
 */
const READY = [
  /\b(?:i|we)(?:'|’)?(?:d| would)? ?(?:want|like|wanna) (?:to )?(?:book|take|reserve|have) (?:it|this|that|the)\b/i,
  /\b(?:i|we)(?:(?:'|’)?ll| will) take (?:it|this|that|the)\b/i,
  /\b(?:let(?:'|’)?s|lets) (?:do|book|go with) (?:it|this|that|the)\b/i,
  /\b(?:book|reserve) (?:it|this|that)\b/i,
  /\bgo ahead\b/i,
  /\b(?:confirm|confirmed) (?:it|this|the booking)\b/i,
]

export function wantsToBook(message: string | null): boolean {
  if (message === null || message.trim() === '') return false
  // A question about booking is not a booking. "How do I book?" needs an
  // answer, not two buttons.
  if (/\?\s*$/.test(message.trim()) && !/\b(?:yes|yeah|ok|okay)\b/i.test(message)) return false
  return READY.some((pattern) => pattern.test(message))
}
