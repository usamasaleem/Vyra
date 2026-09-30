import { problemWithVehicle, type AddVehicleProblem } from './queries/add-vehicle.js'

/**
 * Reading a fleet spreadsheet.
 *
 * An operator with twelve cars already has them in a sheet, and typing them
 * into a form one at a time is the part of setup that makes them stop. This
 * turns the sheet's rows into cars the add-a-car path can save, and says
 * plainly, row by row, which ones it could not use and why.
 *
 * It only reads. Nothing here invents a value: a sheet with no plate column
 * gives rows that need a plate, not rows with a made-up one, because the plate
 * is what stops the same car being added twice and the rate is the only price
 * the agent will ever quote.
 *
 * Kept free of any spreadsheet library. The caller turns a file into rows of
 * text; this decides what the rows mean.
 */

export type SheetField =
  | 'make' | 'model' | 'variant' | 'year' | 'colour' | 'category'
  | 'plate' | 'chassis' | 'seats' | 'dailyRate' | 'deposit'

/** What each column may be called, compared with case, spaces and punctuation ignored. */
const HEADINGS: Record<SheetField, string[]> = {
  make: ['make', 'brand', 'manufacturer'],
  model: ['model', 'carmodel'],
  variant: ['variant', 'trim', 'edition', 'version'],
  year: ['year', 'modelyear', 'yearofmanufacture', 'manufactureyear'],
  colour: ['colour', 'color', 'exteriorcolour', 'exteriorcolor'],
  category: ['category', 'type', 'class', 'bodytype', 'segment', 'cartype'],
  plate: ['plate', 'platenumber', 'plateno', 'registration', 'registrationnumber', 'regno', 'reg', 'licenseplate', 'licenceplate', 'numberplate'],
  chassis: ['chassis', 'chassisnumber', 'chassisno', 'vin', 'vinnumber', 'vehicleidentificationnumber'],
  seats: ['seats', 'seat', 'seating', 'seatingcapacity', 'passengers'],
  dailyRate: [
    'dailyrate', 'dayrate', 'perday', 'priceperday', 'rateperday', 'ratedaily', 'daily', 'dailyprice',
    'rate', 'price', 'rentalrate', 'rentalprice', 'aedperday', 'aeddaily', 'dailyrateaed', 'priceaed', 'rateaed',
  ],
  deposit: ['deposit', 'securitydeposit', 'depositaed', 'depositamount'],
}

/** What an operator's word for a category becomes. Anything else is left for them to fix. */
const CATEGORY_WORDS: Record<string, string> = {
  supercar: 'exotic', exotic: 'exotic', hypercar: 'exotic',
  luxury: 'luxury', premium: 'luxury', executive: 'luxury', limousine: 'luxury',
  suv: 'suv', crossover: 'suv', '4x4': 'suv', offroad: 'suv',
  sports: 'sports', sport: 'sports', sportscar: 'sports', coupe: 'sports', muscle: 'sports',
  convertible: 'convertible', cabriolet: 'convertible', spider: 'convertible', spyder: 'convertible',
  roadster: 'convertible', cabrio: 'convertible',
  sedan: 'sedan', saloon: 'sedan',
}

const squashHeading = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

export type SheetCar = {
  make: string
  model: string
  variant: string
  year: number
  colour: string
  category: string
  plate: string
  chassisNumber: string
  seats: number | null
  dailyRateMinor: number
  depositMinor: number | null
}

export type SheetRowProblem = AddVehicleProblem | 'repeated_in_sheet'

export type SheetRow = {
  /** The row's number in the sheet as the operator sees it, header included. */
  line: number
  car: SheetCar
  /** What is wrong with this row, or null when it can be saved as it is. */
  problem: SheetRowProblem | null
}

export type ReadSheet =
  | {
      ok: true
      /** The heading each field was found under, so the operator can check the guess. */
      matched: Partial<Record<SheetField, string>>
      /** Fields with no column at all, of the ones a car cannot be saved without. */
      missing: SheetField[]
      rows: SheetRow[]
    }
  | { ok: false; reason: 'empty' | 'no_headings' }

/** Without these a car cannot be saved, so a sheet lacking the column is one to fix, not a sheet of failures. */
const REQUIRED: SheetField[] = ['make', 'model', 'year', 'colour', 'category', 'plate', 'chassis', 'dailyRate']

const cellText = (cell: unknown): string => {
  if (cell === null || cell === undefined) return ''
  if (cell instanceof Date) return String(cell.getUTCFullYear())
  return String(cell).trim()
}

/**
 * An amount as an operator writes it: "1,500", "AED 1500", "1 500.50".
 * Returns fils, or NaN for text that is not an amount and null for a blank.
 */
export function amountToMinor(raw: string): number | null {
  const text = raw.trim()
  if (text === '') return null
  const cleaned = text.replace(/aed|dhs?|د\.إ/gi, '').replace(/[\s, ]/g, '')
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return Number.NaN
  return Math.round(Number(cleaned) * 100)
}

function wholeNumber(raw: string): number | null {
  if (raw === '') return null
  return /^\d+(\.0+)?$/.test(raw) ? Number(raw.replace(/\.0+$/, '')) : Number.NaN
}

export function readFleetSheet(cells: unknown[][], now = new Date()): ReadSheet {
  const rows = cells.map((r) => r.map(cellText))
  // The heading row is the first one with anything in it that we recognise; sheets often open with a title.
  const headerAt = rows.findIndex((r) =>
    r.some((c) => Object.values(HEADINGS).some((names) => names.includes(squashHeading(c)))),
  )
  if (rows.every((r) => r.every((c) => c === ''))) return { ok: false, reason: 'empty' }
  if (headerAt === -1) return { ok: false, reason: 'no_headings' }

  const header = rows[headerAt]!
  const column: Partial<Record<SheetField, number>> = {}
  const matched: Partial<Record<SheetField, string>> = {}
  for (const field of Object.keys(HEADINGS) as SheetField[]) {
    const at = header.findIndex((h, i) => HEADINGS[field].includes(squashHeading(h)) && !Object.values(column).includes(i))
    if (at !== -1) {
      column[field] = at
      matched[field] = header[at]!
    }
  }
  const missing = REQUIRED.filter((f) => column[f] === undefined)

  const out: SheetRow[] = []
  const seenPlates = new Set<string>()
  const seenChassis = new Set<string>()
  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i]!
    if (r.every((c) => c === '')) continue
    const get = (f: SheetField) => (column[f] === undefined ? '' : (r[column[f]!] ?? ''))
    const categoryWord = squashHeading(get('category'))
    const car: SheetCar = {
      make: get('make'),
      model: get('model'),
      variant: get('variant'),
      year: wholeNumber(get('year')) ?? Number.NaN,
      colour: get('colour'),
      category: CATEGORY_WORDS[categoryWord] ?? (get('category') === '' ? '' : get('category')),
      plate: get('plate').replace(/\s+/g, ' '),
      chassisNumber: get('chassis'),
      seats: wholeNumber(get('seats')),
      dailyRateMinor: amountToMinor(get('dailyRate')) ?? 0,
      depositMinor: amountToMinor(get('deposit')),
    }

    let problem: SheetRowProblem | null = problemWithVehicle(
      { ...car, operatorId: '', membershipId: '', confirmedBy: '' },
      now,
    )
    const plateKey = car.plate.toUpperCase().replace(/[\s-]+/g, '')
    const chassisKey = car.chassisNumber.toUpperCase().replace(/[\s-]+/g, '')
    if (problem === null && (seenPlates.has(plateKey) || seenChassis.has(chassisKey))) problem = 'repeated_in_sheet'
    if (problem === null) {
      seenPlates.add(plateKey)
      seenChassis.add(chassisKey)
    }
    out.push({ line: i + 1, car, problem })
  }

  return { ok: true, matched, missing, rows: out }
}
