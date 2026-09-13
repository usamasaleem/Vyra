import type { KnowledgeEntry } from '../knowledge.js'

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  EVERY ANSWER IN THIS FILE IS INVENTED.
 *
 *  Not one of these figures came from a rental operator. They exist so that
 *  Phase 4 can be built and evaluated before the real policy has been
 *  collected, and they are shaped like plausible Dubai terms precisely so the
 *  system is exercised realistically — which is also what makes them
 *  dangerous. A plausible invented deposit is harder to spot than an obviously
 *  wrong one.
 *
 *  `assertPublishable` refuses every entry below while provenance is
 *  'placeholder'. Replacing a value means also recording who at the operator
 *  confirmed it and when.
 *
 *  The market research in knowledge/docs/ contains daily rate examples, but it
 *  marks them as directional and they are rates, not deposits or kilometre
 *  allowances. Nothing here is derived from them.
 * ─────────────────────────────────────────────────────────────────────────
 */
export const placeholderPolicy: readonly KnowledgeEntry[] = [
  {
    topic: 'deposit',
    covers: 'What deposit is required, how it is held, and when it is returned',
    answer:
      'A refundable security deposit is held on a credit card for the rental period: AED 5,000 for luxury vehicles and AED 15,000 for exotic vehicles. It is released within 14 working days of return, after Salik and any fines are settled.',
    provenance: 'placeholder',
    unblocksEvalCase: 'deposit-question',
  },
  {
    topic: 'included-kilometres',
    covers: 'Daily kilometre allowance and the charge beyond it',
    answer:
      '250 km per day are included. Additional kilometres are charged at AED 10 per km for luxury vehicles and AED 25 per km for exotic vehicles.',
    provenance: 'placeholder',
    unblocksEvalCase: 'included-kilometres',
  },
  {
    topic: 'driver-requirements-resident',
    covers: 'What a UAE resident must present, and the minimum age',
    answer:
      'UAE residents need a valid UAE driving licence, Emirates ID, and a credit card in the driver’s own name. Minimum age is 23 for luxury vehicles and 25 for exotic vehicles.',
    provenance: 'placeholder',
    unblocksEvalCase: 'driver-requirements-visitor',
  },
  {
    topic: 'driver-requirements-visitor',
    covers: 'What a visitor must present, and the minimum age',
    answer:
      'Visitors need their passport, UAE entry stamp or visa, a licence from their home country together with an International Driving Permit, and a credit card in the driver’s own name. Minimum age is 23 for luxury vehicles and 25 for exotic vehicles.',
    provenance: 'placeholder',
    unblocksEvalCase: 'driver-requirements-visitor',
  },
  {
    topic: 'delivery-areas',
    covers: 'Where vehicles are delivered and what it costs',
    answer:
      'Delivery and collection anywhere in Dubai is complimentary. Abu Dhabi and Sharjah are AED 300 each way. Other emirates are arranged case by case. Cross-emirate travel during the rental is permitted and must be declared in advance.',
    provenance: 'placeholder',
    unblocksEvalCase: 'delivery-area',
  },
  {
    topic: 'business-hours',
    covers: 'When the team is reachable and what to tell customers outside those hours',
    answer:
      'The showroom is open 09:00–21:00 Sunday to Thursday and 10:00–22:00 Friday and Saturday, Dubai time. Messages received outside those hours are answered when the team is next in, usually first thing in the morning.',
    provenance: 'placeholder',
    unblocksEvalCase: 'out-of-hours',
  },
  {
    topic: 'follow-up-timing',
    covers: 'When and how often to follow up an enquiry that goes quiet',
    answer:
      'Follow up once after four hours if the customer has not replied, and once more the following day. Stop after that unless the customer responds.',
    provenance: 'placeholder',
    unblocksEvalCase: 'goes-quiet',
  },
]
