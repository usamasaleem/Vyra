import { describe, expect, it } from 'vitest'
import { buttonsFor, invitesACarChoice, offersAChoice } from '../src/confirmations.ts'
import { mightNeedTheFleet } from '../src/fleet-questions.ts'
import { asksToSeePhotos } from '../src/photo-requests.ts'
import { wantsToBook } from '../src/car-choice.ts'
import { detectOptOut } from '../src/opt-out.ts'

/**
 * Dubai, and every matcher in this codebase was written in English.
 *
 * The model replies in Arabic perfectly well and the booking tool does not
 * care what language a customer writes in, so an Arabic conversation was
 * never broken — it was bare. No tappable car list, no photographs, no
 * buttons at the moment of confirming, no fleet looked up before the reply.
 * Everything that makes the English experience quick was simply absent, and
 * nothing said so.
 *
 * ⚠️ These patterns are model-written and want a native speaker's eye, the
 * caveat opt-out.ts already carries. The stakes are much lower here: a wrong
 * match offers a photograph nobody asked for, and a miss leaves the plain
 * text that is the only thing available today.
 */
describe('a customer writing Arabic', () => {
  it('asking what cars there are reaches the fleet', () => {
    expect(mightNeedTheFleet('ايش السيارات المتوفرة عندكم؟')).not.toBeNull()
    expect(mightNeedTheFleet('كم سعر الإيجار باليوم؟')).not.toBeNull()
    expect(mightNeedTheFleet('عندكم سيارات رياضية؟')).not.toBeNull()
  })

  it('asking to see one reaches the photographs', () => {
    expect(asksToSeePhotos('ممكن صور للسيارة؟')).toBe(true)
    expect(asksToSeePhotos('ابعتلي صورة من الداخل')).toBe(true)
    expect(asksToSeePhotos('شكلها كيف؟')).toBe(true)
  })

  it('saying yes to a price is read as a booking', () => {
    expect(wantsToBook('تمام، احجزها')).toBe(true)
    expect(wantsToBook('أريد الحجز')).toBe(true)
    expect(wantsToBook('ثبت الحجز')).toBe(true)
  })

  /** A question about booking is still not a booking, in either language. */
  it('does not read a question about booking as one', () => {
    expect(wantsToBook('كيف أحجز؟')).toBe(false)
  })

  /** The one with legal weight, and the one that already worked. */
  it('is still able to stop the messages', () => {
    expect(detectOptOut('توقف')).not.toBeNull()
    expect(detectOptOut('لا ترسل لي')).not.toBeNull()
  })
})

/**
 * The reply side matters as much: the model answers in the language it was
 * written to, and every surface in confirmations.ts reads the reply.
 */
describe('an Arabic reply', () => {
  it('still carries delivery buttons when it offers the choice', () => {
    expect(buttonsFor('هل نوصلها لك أم تستلمها من المعرض؟'))
      .toEqual([
        expect.objectContaining({ id: 'prefers_delivery' }),
        expect.objectContaining({ id: 'prefers_collection' }),
      ])
  })

  it('still carries the car list when it asks which one', () => {
    expect(invitesACarChoice('عندنا ثلاث سيارات تناسبك — أي سيارة تفضل؟')).toBe(true)
  })

  /** Arabic ends a question with ؟, which the counter did not know about. */
  it('refuses buttons on a reply that asks two things', () => {
    expect(buttonsFor('هل نوصلها أم تستلمها؟ وكم يوم تحتاجها؟')).toBeNull()
  })

  it('reads an Arabic either-or as a choice', () => {
    expect(offersAChoice('يومين أم ثلاثة أيام؟')).toBe(true)
    expect(offersAChoice('تم تأكيد الحجز.')).toBe(false)
  })
})
