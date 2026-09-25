import { evaluateDocuments, type DocumentVerdict, type ReadDocument } from '@vyra/contracts'
import type { DocumentReader } from '@vyra/agent'
import { documentsToCheck, getApprovedAnswer, recordDocumentCheck, type QueryRunner } from '@vyra/db'
import type { WhatsAppClient } from './whatsapp/client.js'

/**
 * Checking a booking's licence and ID without a person, where it is safe to.
 *
 * Reads each filed photo into fields, lets the rules decide, and writes the
 * verdict on the booking. Approved marks the documents checked; anything else
 * leaves them for a person with the reasons. Returns null when it could not
 * run at all — no reader, a photo that would not download — and the caller
 * then says what it always said: the team checks them before the handover.
 */
export type CheckDocuments = (input: { operatorId: string; bookingId: string; visitor: boolean }) =>
  Promise<DocumentVerdict | null>

export function documentChecker(deps: {
  run: QueryRunner
  whatsapp: WhatsAppClient
  reader: DocumentReader
  log: (fields: Record<string, unknown>) => void
  now?: () => Date
}): CheckDocuments {
  return async ({ operatorId, bookingId, visitor }) => {
    const began = Date.now()
    const booking = await documentsToCheck(deps.run, { operatorId, bookingId })
    if (booking === null || booking.alreadyChecked || booking.rentalStart === null || booking.rentalEnd === null) return null
    if (booking.photos.length === 0) return null

    const documents: ReadDocument[] = []
    for (const photo of booking.photos) {
      const file = await deps.whatsapp.fetchMedia({ mediaId: photo.mediaId })
      if (file === null) return null
      const read = await deps.reader({ bytes: file.bytes, mimeType: file.mimeType })
      if (read !== null) documents.push(read)
    }

    const now = deps.now?.() ?? new Date()
    const [visitorRules, residentRules] = await Promise.all([
      getApprovedAnswer(deps.run, operatorId, 'driver-requirements-visitor', now),
      getApprovedAnswer(deps.run, operatorId, 'driver-requirements-resident', now),
    ])
    const rules = visitor ? visitorRules?.answer ?? null : residentRules?.answer ?? null
    // The operator's own words set the thresholds, as they do for the agent.
    const minimumAge = Number(rules?.match(/minimum age(?: for this car)? is (\d{2})\b/i)?.[1] ?? NaN)
    const years = rules?.match(/held (?:it |your licence |the licence )?for at least (a|one|\d+) years?/i)?.[1]

    const verdict = evaluateDocuments({
      documents,
      rentalStart: booking.rentalStart,
      rentalEnd: booking.rentalEnd,
      minimumAge: Number.isFinite(minimumAge) ? minimumAge : null,
      minimumLicenceYears: years === undefined ? 0 : /a|one/i.test(years) ? 1 : Number(years),
      visitor,
      visitorRules: visitorRules?.answer ?? null,
    })

    await recordDocumentCheck(deps.run, {
      operatorId, bookingId,
      approved: verdict.verdict === 'approved',
      check: {
        ...verdict,
        at: now.toISOString(),
        // What was read, for the person who looks next — kept on the booking only.
        documents: documents.map((d) => ({
          kind: d.kind, legible: d.legible, country: d.country, fullName: d.fullName,
          dateOfBirth: d.dateOfBirth, expiryDate: d.expiryDate, issueDate: d.issueDate,
        })),
      },
    })
    deps.log({ event: 'documents.checked', booking: bookingId, verdict: verdict.verdict, photos: booking.photos.length, ms: Date.now() - began })
    return verdict
  }
}
