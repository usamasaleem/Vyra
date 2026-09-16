import { VEHICLE_ROW } from './confirmations.js'

/**
 * The car list as a WhatsApp Flow, which is the only surface Meta offers where
 * a tappable list carries pictures.
 *
 * An interactive list row has exactly three fields — id, a 24-character title
 * and a 72-character description — and the list header is text only. There is
 * no image anywhere on it, and no version of that message will ever have one.
 * The alternatives are a commerce catalog, which forces a price, a stock flag
 * and a condition of new, refurbished or used onto every car, and this.
 *
 * The limits below are Meta's and they are tight: a 30-character title, a
 * 20-character description, and a base64 image capped at 100KB. Twenty items
 * at most. Everything here is written to fit inside them and to degrade by
 * dropping detail rather than by failing to send.
 *
 * UNVERIFIED, and deliberately switched off until it is not. Meta's own
 * component reference does not document NavigationList at all; the third-party
 * specification that does contradicts itself about whether it may share a
 * screen with other components. Both of those are exactly the kind of claim
 * that has been wrong twice in this project — the album threshold and whether
 * the API could group images at all — and both times a real phone settled it.
 * So this ships behind WHATSAPP_FLOW_ID: with no flow published, nothing about
 * the product changes.
 */

/** What a NavigationList item may hold, in Meta's own casing. */
export type FlowCarItem = {
  id: string
  'main-content': { title: string; description?: string; metadata?: string }
  start?: { image: string; 'alt-text': string }
  'on-click-action': { name: 'complete'; payload: { car: string } }
}

export const CAR_FLOW_LIMITS = {
  items: 20,
  title: 30,
  description: 20,
  metadata: 80,
  /** Base64 characters, which is what the 100KB cap actually counts. */
  image: 100_000,
} as const

/**
 * Truncated on a word where one is available.
 *
 * A description cut mid-word reads as a bug rather than as brevity, and at
 * twenty characters there is not room to be careless.
 */
function fit(value: string, limit: number): string {
  const flat = value.trim().replace(/\s+/g, ' ')
  if (flat.length <= limit) return flat
  const cut = flat.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return (space > limit / 2 ? cut.slice(0, space) : cut).trim()
}

export type FlowCar = {
  make: string
  model: string
  variant: string | null
  colour: string
  engine: string | null
  dayRate: string | null
  /** Base64 JPEG, already within the cap. Omitted when there is no photograph. */
  image: string | null
}

/**
 * The screen's data, built from the same rows the list message uses.
 *
 * A car with no photograph still appears. The list is what the operator has,
 * and leaving a car out of it to keep the pictures tidy would be the fleet
 * lying about its own size — different from the album, where a car without a
 * photograph has nothing to contribute at all.
 */
export function carFlowItems(cars: readonly FlowCar[]): FlowCarItem[] {
  return cars.slice(0, CAR_FLOW_LIMITS.items).map((car) => {
    const name = [car.make, car.model, car.variant].filter((p) => p !== null && p !== '').join(' ')

    // Colour without the gloss: "Verde Mantis (green)" is over the limit before
    // it starts, and the word in brackets is the one a customer recognises.
    const colour = car.colour.replace(/\s*\([^)]*\)/, '')

    // The rate goes here rather than in `end`, whose title allows ten
    // characters — "AED 12,000" is exactly ten and anything dearer is not.
    const metadata = [car.engine, car.dayRate === null ? null : `${car.dayRate}/day`]
      .filter((part): part is string => part !== null && part !== '')
      .join(' · ')

    const image = car.image !== null && car.image.length <= CAR_FLOW_LIMITS.image
      ? car.image
      : null

    return {
      // The same identifier the list rows use, so a tap through either surface
      // arrives at the turn as the same sentence.
      id: `${VEHICLE_ROW}${name}`.slice(0, 200),
      'main-content': {
        title: fit(name, CAR_FLOW_LIMITS.title),
        description: fit(colour, CAR_FLOW_LIMITS.description),
        ...(metadata === '' ? {} : { metadata: fit(metadata, CAR_FLOW_LIMITS.metadata) }),
      },
      ...(image === null ? {} : { start: { image, 'alt-text': name } }),
      'on-click-action': { name: 'complete' as const, payload: { car: name } },
    }
  })
}

/**
 * What comes back when somebody taps one.
 *
 * A Flow reply arrives as `nfm_reply` carrying a JSON string rather than the
 * id-and-title pair a list reply gives, so this is where that shape is turned
 * back into the one the rest of the system already understands.
 */
export function carChosenInFlow(responseJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(responseJson)
    if (typeof parsed !== 'object' || parsed === null) return null
    const car = (parsed as { car?: unknown }).car
    return typeof car === 'string' && car.trim() !== '' ? car.trim() : null
  } catch {
    // A payload we cannot read is not a crash. The customer tapped something;
    // the worst honest outcome is treating it as a message with no body, which
    // routes to a person rather than guessing which car they meant.
    return null
  }
}
