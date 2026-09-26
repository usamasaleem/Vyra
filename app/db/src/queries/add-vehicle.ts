import type { Transactor } from '../runner.js'
import { setVehicleRate } from './quotes.js'

/**
 * Adding a car, from the dashboard, in one go.
 *
 * Until this existed there was no way to: the pilot's three cars were inserted
 * by hand, so a new operator could not finish setup alone. Setup's first
 * blocking step was one nobody outside this repository could complete.
 *
 * The car arrives `operator_confirmed`, with the name of whoever pressed Save.
 * That is honest in a way a placeholder would not be: the person adding it is
 * the person saying it exists, and a car added from the dashboard that the
 * agent still refused to mention would be a second step with no reason to
 * exist.
 *
 * It arrives priced, too, and in the same transaction. A car on file with no
 * rate is one the agent names and then refuses to quote — correct, and the
 * worst first impression an operator can have of the thing they just paid
 * for. The rate goes through `setVehicleRate`, the same path the Rates page
 * uses, so it carries a name like every other figure.
 */

export const VEHICLE_CATEGORIES = [
  'exotic', 'luxury', 'suv', 'sports', 'convertible', 'sedan',
] as const
export type VehicleCategory = (typeof VEHICLE_CATEGORIES)[number]

export type NewVehicle = {
  /**
   * Chosen by the caller when it needs the id before the car exists — the
   * collage link is built from it. Left out, the database picks one.
   */
  vehicleId?: string
  operatorId: string
  membershipId: string
  /** The person, as the Rates page names them: email or membership id. */
  confirmedBy: string
  make: string
  model: string
  variant?: string | null
  year: number
  colour: string
  category: string
  plate: string
  chassisNumber: string
  seats?: number | null
  dailyRateMinor: number
  depositMinor?: number | null
  /** Already checked by the caller to serve a picture; stored as given. */
  photoUrls?: string[]
  /**
   * The collage link, which only the caller can build — it knows the host
   * serving the request, and `vehicleId` is what makes the link this car's. Stored with the car for the reason `savePhotos`
   * stores it: the worker should not need to know where the inbox lives.
   */
  collageUrl?: string | null
}

export type AddVehicleProblem =
  | 'make' | 'model' | 'year' | 'colour' | 'category' | 'plate' | 'chassis'
  | 'seats' | 'rate' | 'deposit' | 'plate_taken' | 'chassis_taken'

export type AddVehicleResult =
  | { ok: true; vehicleId: string }
  | { ok: false; problem: AddVehicleProblem }

/**
 * What is wrong with the form, if anything, before a transaction is opened.
 *
 * The year bound is loose on purpose. A classic car is a real thing to rent
 * in Dubai and next year's model arrives in the autumn; the bound is there to
 * catch "223" and "20233", not to have an opinion about the fleet.
 */
export function problemWithVehicle(input: NewVehicle, now = new Date()): AddVehicleProblem | null {
  const blank = (s: string | null | undefined) => s === null || s === undefined || s.trim() === ''
  if (blank(input.make)) return 'make'
  if (blank(input.model)) return 'model'
  if (!Number.isInteger(input.year) || input.year < 1900 || input.year > now.getUTCFullYear() + 1) {
    return 'year'
  }
  if (blank(input.colour)) return 'colour'
  if (!(VEHICLE_CATEGORIES as readonly string[]).includes(input.category)) return 'category'
  if (blank(input.plate)) return 'plate'
  if (blank(input.chassisNumber)) return 'chassis'
  if (input.seats != null && (!Number.isInteger(input.seats) || input.seats < 1 || input.seats > 60)) {
    return 'seats'
  }
  if (!Number.isInteger(input.dailyRateMinor) || input.dailyRateMinor <= 0) return 'rate'
  if (input.depositMinor != null && (!Number.isInteger(input.depositMinor) || input.depositMinor < 0)) {
    return 'deposit'
  }
  return null
}

/**
 * Plates and chassis numbers compared the way people mistype them.
 *
 * The unique constraints compare exact strings, so "Dubai A 12345" and
 * "DUBAI A12345" would both go in and the fleet would hold one car twice —
 * two rows the agent offers as two cars. Upper-cased with the spaces and
 * dashes taken out before comparing, and stored the same way for the chassis
 * number, which has no conventional spacing to keep.
 */
const squash = (s: string) => s.toUpperCase().replace(/[\s-]+/g, '')

export async function addVehicle(transact: Transactor, input: NewVehicle): Promise<AddVehicleResult> {
  const problem = problemWithVehicle(input)
  if (problem !== null) return { ok: false, problem }

  const plate = input.plate.trim().replace(/\s+/g, ' ')
  const chassis = squash(input.chassisNumber)

  return transact(async (tx) => {
    /**
     * Inactive cars count. A sold car keeps its plate on file so its old
     * bookings still explain themselves, and adding it again is reactivating
     * it, which is a different act from this one.
     */
    const clashes = await tx(
      `select
         bool_or(regexp_replace(upper(plate), '[\\s-]+', '', 'g') = $2) as plate_taken,
         bool_or(regexp_replace(upper(chassis_number), '[\\s-]+', '', 'g') = $3) as chassis_taken
       from vehicles where operator_id = $1`,
      [input.operatorId, squash(plate), chassis],
    )
    if (clashes[0]?.['plate_taken'] === true) return { ok: false as const, problem: 'plate_taken' as const }
    if (clashes[0]?.['chassis_taken'] === true) return { ok: false as const, problem: 'chassis_taken' as const }

    const photos = input.photoUrls ?? []
    const [row] = await tx(
      `insert into vehicles (
         id, operator_id, make, model, variant, year, colour, category, plate, chassis_number,
         seats, photo_urls, collage_url, provenance, confirmed_by, confirmed_at,
         confirmed_by_membership_id
       ) values (coalesce($15::uuid, gen_random_uuid()),
                 $1,$2,$3,$4,$5,$6,$7::vehicle_category,$8,$9,$10::int,$11::jsonb,$12,
                 'operator_confirmed',$13,now(),$14)
       returning id`,
      [
        input.operatorId, input.make.trim(), input.model.trim(),
        input.variant == null || input.variant.trim() === '' ? null : input.variant.trim(),
        input.year, input.colour.trim(), input.category, plate, chassis,
        input.seats ?? null,
        photos.length === 0 ? null : JSON.stringify(photos),
        photos.length >= 2 ? (input.collageUrl ?? null) : null,
        input.confirmedBy, input.membershipId, input.vehicleId ?? null,
      ],
    )
    const vehicleId = row!['id'] as string

    await setVehicleRate(tx, {
      operatorId: input.operatorId,
      vehicleId,
      confirmedBy: input.confirmedBy,
      dailyRateMinor: input.dailyRateMinor,
      depositMinor: input.depositMinor ?? null,
    })

    await tx(
      `insert into audit_events (operator_id, actor_type, actor_id, action, subject_type, subject_id, data)
       values ($1, 'user', $2, 'vehicle.added', 'vehicle', $3, $4::jsonb)`,
      [
        input.operatorId, input.membershipId, vehicleId,
        JSON.stringify({ plate, dailyRateMinor: input.dailyRateMinor, photos: photos.length }),
      ],
    )

    return { ok: true as const, vehicleId }
  })
}
