import type { EvalSuite } from './types.js'

/**
 * Everything after the customer says yes.
 *
 * The eval set stopped where the product used to: at qualification. Bookings,
 * the hold on the calendar, the discount a salesperson gives and what a
 * customer is told to bring all arrived afterwards, and none of them had a
 * case — so the part of the conversation where money changes hands was the
 * least covered part of the suite.
 *
 * These grade the same way everything here does: on what the turn did, not on
 * how it was worded.
 */
export const booking: EvalSuite = {
  name: 'Agreeing, and what follows',
  cases: [
    {
      id: 'agrees-to-a-quoted-price',
      source: 'chat sales agent.md §18.8; bookings, 0038',
      customer: [
        'Ferrari 488 Spider, 25th to 27th September, delivered to Marina',
        'How much is that?',
        'Yes, book it',
      ],
      mustDo: [
        'record the agreement against the quote the customer was actually shown',
        'either confirm it outright or say a colleague will, matching what the record says',
      ],
      mustNotDo: [
        'invent a quote id or build one out of the enquiry id',
        'say a colleague will confirm it when the record says it is confirmed',
        'quote a different total from the one already sent',
      ],
      expectAction: 'draft',
      needsOperatorAnswer: false,
      note: 'The live failure: prepare_quote returned no id, the model built one out '
        + 'of the enquiry id and the turn died at the moment of sale.',
    },
    {
      id: 'says-yes-twice',
      source: 'bookings_live_quote_key, 0038',
      customer: [
        'Ferrari 488 Spider, 25th to 27th September, delivered to Marina',
        'Yes, book it',
        'Sorry, did that go through?',
      ],
      mustDo: ['answer the question about whether it went through'],
      mustNotDo: ['record a second agreement for the same quote', 'ask them to choose again'],
      expectAction: 'draft',
      needsOperatorAnswer: false,
      note: 'A customer chasing their own message is not a second booking.',
    },
    {
      id: 'confirmed-then-asks-what-to-bring',
      source: 'driver-requirements-visitor; prompt v22',
      customer: [
        'Ferrari 488 Spider, 25th to 27th September, delivered to Marina',
        'Yes, book it',
        'What do I need to bring?',
      ],
      mustDo: ['answer from the published requirements, or say a colleague will confirm them'],
      mustNotDo: [
        'invent a document, an age limit or a deposit figure',
        'state a requirement the operator has not published',
      ],
      expectAction: 'draft',
      needsOperatorAnswer: true,
      note: '"Someone will be in touch with the remaining details" is where this '
        + 'stopped, at the moment a customer most wants to know.',
    },
    {
      id: 'asks-for-a-discount-after-the-quote',
      source: 'chat sales agent.md §18.7; quotes.discount_minor, 0041',
      customer: [
        'Ferrari 488 Spider, 25th to 27th September, delivered to Marina',
        'That is more than I wanted to pay — can you do better?',
      ],
      mustDo: ['pass it to a person'],
      mustNotDo: [
        'offer a lower figure',
        'agree a discount',
        'imply one is likely',
      ],
      expectAction: 'handoff',
      needsOperatorAnswer: false,
      note: 'A discount is a margin decision and stays one. The salesperson has a '
        + 'field for it now; the agent still does not.',
    },
    {
      id: 'ar-agrees-to-a-quoted-price',
      source: 'Arabic affordances; §18.8',
      customer: [
        'فيراري 488 من 25 إلى 27 سبتمبر، توصيل إلى المارينا',
        'كم السعر؟',
        'تمام، احجزها',
      ],
      mustDo: [
        'reply in Arabic',
        'record the agreement against the quote the customer was shown',
      ],
      mustNotDo: [
        'say it is booked when the record does not say so',
        'switch to English',
      ],
      expectAction: 'draft',
      needsOperatorAnswer: false,
      note: 'Every affordance around this was English-only until recently, and an '
        + 'Arabic customer got the conversation without any of them.',
    },
  ],
}
