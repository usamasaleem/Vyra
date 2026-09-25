/**
 * Whether a driver's licence and ID are good enough to hand over a car.
 *
 * The model reads the photos; this decides. Reading is the part a model is
 * good at and a rule is not. Deciding is the part a rule is good at and a
 * model is not: "25 or over on the day", "valid until the car comes back",
 * "the same person on both" are arithmetic and comparison, and a model asked
 * to judge them will one day judge them generously.
 *
 * Three outcomes, and the middle one is what makes this safe to automate:
 *
 *   approved   every rule passed on fields that were actually read.
 *   unreadable a photo could not be used — the customer is asked for a
 *              clearer one, which is what a person would ask.
 *   problem    something is wrong or cannot be confirmed — a person decides,
 *              with the reasons in front of them. Never the customer told
 *              "no" by a machine.
 */

export type DocumentKind = 'driving_licence' | 'passport' | 'emirates_id' | 'visa' | 'other'

/** What one photo was read as. Dates are YYYY-MM-DD, null when not shown or not legible. */
export type ReadDocument = {
  kind: DocumentKind
  legible: boolean
  /** The country that issued it, in English. */
  country: string | null
  fullName: string | null
  dateOfBirth: string | null
  expiryDate: string | null
  /** For a licence, when it was first issued, if shown. */
  issueDate: string | null
}

export type DocumentVerdict =
  | { verdict: 'approved'; reasons: string[] }
  | { verdict: 'unreadable'; reasons: string[]; /** What to ask the customer for, as a phrase. */ ask: string }
  | { verdict: 'problem'; reasons: string[] }

const DAY = 24 * 60 * 60 * 1000
const ISO = /^\d{4}-\d{2}-\d{2}$/

function date(value: string | null): Date | null {
  if (value === null || !ISO.test(value)) return null
  const d = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Whole years between a birth date and a day. */
export function ageOn(dateOfBirth: Date, day: Date): number {
  let years = day.getUTCFullYear() - dateOfBirth.getUTCFullYear()
  const beforeBirthday = day.getUTCMonth() < dateOfBirth.getUTCMonth()
    || (day.getUTCMonth() === dateOfBirth.getUTCMonth() && day.getUTCDate() < dateOfBirth.getUTCDate())
  if (beforeBirthday) years--
  return years
}

/**
 * The same person on both documents.
 *
 * Names are written differently across documents — a middle name on one, the
 * order swapped on an Emirates ID, an accent dropped on a licence. So this asks
 * whether the shorter name's parts all appear in the longer one, and at least
 * two parts are shared; it does not ask for identical strings.
 */
export function sameName(a: string, b: string): boolean {
  const parts = (name: string) => name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/).filter((p) => p.length > 1)
  const [short, long] = [parts(a), parts(b)].sort((x, y) => x.length - y.length) as [string[], string[]]
  if (short.length === 0) return false
  const shared = short.filter((p) => long.includes(p)).length
  return shared === short.length && shared >= Math.min(2, short.length)
}

/**
 * Which licences are accepted on their own for a visitor, read from the
 * operator's own answer rather than from a list kept here — the operator's
 * rule is the rule. Each country is known by the words an answer would use
 * for it; a country the answer does not name needs a person to check.
 */
const EU = ['Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czech', 'Denmark', 'Estonia', 'Finland',
  'France', 'Germany', 'Greece', 'Hungary', 'Ireland', 'Italy', 'Latvia', 'Lithuania', 'Luxembourg', 'Malta',
  'Netherlands', 'Poland', 'Portugal', 'Romania', 'Slovakia', 'Slovenia', 'Spain', 'Sweden']
const GCC = ['Saudi Arabia', 'Kuwait', 'Qatar', 'Bahrain', 'Oman']
const NAMED_AS: Array<{ country: RegExp; words: RegExp }> = [
  { country: /united kingdom|great britain|^uk$|england|scotland|wales/i, words: /\bUK\b|United Kingdom|Britain|British/i },
  { country: /united states|^usa?$|america/i, words: /\bUS\b|\bUSA\b|United States|America/i },
  { country: /canada/i, words: /Canada/i },
  { country: /australia/i, words: /Australia/i },
  { country: /new zealand/i, words: /New Zealand/i },
  { country: /japan/i, words: /Japan/i },
  { country: /korea/i, words: /Korea/i },
  { country: /switzerland/i, words: /Switzerland|Swiss/i },
  { country: /turkey|t[uü]rkiye/i, words: /Turkey|Türkiye/i },
  { country: /china/i, words: /China/i },
  { country: /hong kong/i, words: /Hong Kong/i },
  { country: /singapore/i, words: /Singapore/i },
  { country: /south africa/i, words: /South Africa/i },
  ...EU.map((c) => ({ country: new RegExp(c, 'i'), words: new RegExp(`\\bEU\\b|European Union|${c}`, 'i') })),
  ...GCC.map((c) => ({ country: new RegExp(c, 'i'), words: new RegExp(`\\bGCC\\b|Gulf|${c}`, 'i') })),
]

export function licenceAcceptedAlone(country: string, visitorRules: string): boolean | null {
  if (/emirates|\buae\b/i.test(country)) return true
  const known = NAMED_AS.find((n) => n.country.test(country.trim()))
  if (known === undefined) return false
  return known.words.test(visitorRules)
}

export function evaluateDocuments(input: {
  documents: ReadDocument[]
  /** YYYY-MM-DD, the first and last day of the rental. */
  rentalStart: string
  rentalEnd: string
  minimumAge: number | null
  /** How long the licence must have been held. */
  minimumLicenceYears: number
  visitor: boolean
  /** The operator's published answer for visitors, which names the licences accepted alone. */
  visitorRules: string | null
}): DocumentVerdict {
  const start = date(input.rentalStart)
  const end = date(input.rentalEnd) ?? start
  if (start === null || end === null) return { verdict: 'problem', reasons: ['The rental dates are not on file.'] }

  const readable = input.documents.filter((d) => d.legible)
  const licence = readable.find((d) => d.kind === 'driving_licence')
  const identity = readable.find((d) => d.kind === 'passport' || d.kind === 'emirates_id')

  if (licence === undefined) {
    return {
      verdict: 'unreadable',
      reasons: ['No readable driving licence among the photos.'],
      ask: 'a clear photo of the front of your driving licence, flat and in good light',
    }
  }
  if (identity === undefined) {
    return {
      verdict: 'unreadable',
      reasons: ['No readable passport or Emirates ID among the photos.'],
      ask: input.visitor
        ? 'a clear photo of your passport’s photo page'
        : 'a clear photo of your Emirates ID (or passport photo page)',
    }
  }

  const reasons: string[] = []
  const problems: string[] = []

  const licenceExpiry = date(licence.expiryDate)
  if (licenceExpiry === null) problems.push('Could not read when the licence expires.')
  else if (licenceExpiry < end) problems.push(`The licence expires on ${licence.expiryDate}, before the car comes back.`)
  else reasons.push(`Licence valid until ${licence.expiryDate}.`)

  const identityExpiry = date(identity.expiryDate)
  const identityName = identity.kind === 'passport' ? 'passport' : 'Emirates ID'
  if (identityExpiry === null) problems.push(`Could not read when the ${identityName} expires.`)
  else if (identityExpiry < end) problems.push(`The ${identityName} expires on ${identity.expiryDate}, before the car comes back.`)
  else reasons.push(`${identityName[0]!.toUpperCase()}${identityName.slice(1)} valid until ${identity.expiryDate}.`)

  const born = date(identity.dateOfBirth) ?? date(licence.dateOfBirth)
  if (input.minimumAge !== null) {
    if (born === null) problems.push('Could not read the date of birth.')
    else {
      const age = ageOn(born, start)
      if (age < input.minimumAge) problems.push(`The driver is ${age} on the first day; the minimum is ${input.minimumAge}.`)
      else reasons.push(`Driver is ${age} on the first day.`)
    }
  }

  const issued = date(licence.issueDate)
  if (issued !== null) {
    const heldYears = (start.getTime() - issued.getTime()) / (365.25 * DAY)
    if (heldYears < input.minimumLicenceYears) {
      problems.push(`The licence was issued on ${licence.issueDate}, less than ${input.minimumLicenceYears} year${input.minimumLicenceYears === 1 ? '' : 's'} before the rental.`)
    } else reasons.push(`Licence held since ${licence.issueDate}.`)
  }

  if (licence.fullName === null || identity.fullName === null) problems.push('Could not read the name on both documents.')
  else if (!sameName(licence.fullName, identity.fullName)) {
    problems.push(`The names differ: "${licence.fullName}" on the licence, "${identity.fullName}" on the ${identityName}.`)
  } else reasons.push('Same name on both.')

  if (input.visitor && licence.country !== null && input.visitorRules !== null) {
    const alone = licenceAcceptedAlone(licence.country, input.visitorRules)
    if (alone === false) problems.push(`The licence is from ${licence.country}; check whether an International Driving Permit is needed.`)
  }

  return problems.length > 0 ? { verdict: 'problem', reasons: problems } : { verdict: 'approved', reasons }
}
