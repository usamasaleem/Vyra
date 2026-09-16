import { describe, expect, it } from 'vitest'
import { carChosenInFlow, carFlowItems, CAR_FLOW_LIMITS } from '../src/car-flow.ts'

const car = (over: Partial<Parameters<typeof carFlowItems>[0][number]> = {}) => ({
  make: 'Lamborghini', model: 'Huracán', variant: 'Tecnica', colour: 'Verde',
  engine: '5.2 L naturally aspirated V10', dayRate: 'AED 5,500', image: null,
  ...over,
})

describe('carFlowItems', () => {
  it('names the car, its colour and what it is', () => {
    const [item] = carFlowItems([car()])

    expect(item!['main-content']).toEqual({
      title: 'Lamborghini Huracán Tecnica',
      description: 'Verde',
      metadata: '5.2 L naturally aspirated V10 · AED 5,500/day',
    })
  })

  /**
   * The same identifier the list rows use, so a car chosen through either
   * surface arrives at the turn as the same sentence.
   */
  it('uses the identifier the list rows use', () => {
    const [item] = carFlowItems([car()])
    expect(item!.id).toBe('vehicle:Lamborghini Huracán Tecnica')
    expect(item!['on-click-action']).toEqual({
      name: 'complete', payload: { car: 'Lamborghini Huracán Tecnica' },
    })
  })

  /** Meta's limits are tight, and a title cut mid-word reads as a bug. */
  it('fits the title and description to the limits, on a word', () => {
    const [item] = carFlowItems([car({
      make: 'Mercedes-Benz', model: 'AMG G 63 Edition', variant: 'One Magno',
      colour: 'Obsidian Black Metallic',
    })])

    const content = item!['main-content']
    expect(content.title.length).toBeLessThanOrEqual(CAR_FLOW_LIMITS.title)
    expect(content.description!.length).toBeLessThanOrEqual(CAR_FLOW_LIMITS.description)
    expect(content.title.endsWith(' ')).toBe(false)
  })

  /** "Verde Mantis (green)" is over the limit before it starts. */
  it('drops the gloss from a colour', () => {
    const [item] = carFlowItems([car({ colour: 'Giallo Modena (yellow)' })])
    expect(item!['main-content'].description).toBe('Giallo Modena')
  })

  it('says nothing about a price nobody confirmed', () => {
    const [item] = carFlowItems([car({ dayRate: null })])
    expect(item!['main-content'].metadata).toBe('5.2 L naturally aspirated V10')
  })

  it('attaches a photograph when there is one', () => {
    const [item] = carFlowItems([car({ image: 'aGVsbG8=' })])
    expect(item!.start).toEqual({ image: 'aGVsbG8=', 'alt-text': 'Lamborghini Huracán Tecnica' })
  })

  /**
   * Over the cap the whole message is rejected, so the picture goes and the car
   * stays. A line-up missing a car is worse than a car missing its picture.
   */
  it('drops an image over the cap rather than the car', () => {
    const [item] = carFlowItems([car({ image: 'a'.repeat(CAR_FLOW_LIMITS.image + 1) })])
    expect(item!.start).toBeUndefined()
    expect(item!['main-content'].title).toBe('Lamborghini Huracán Tecnica')
  })

  /** A car with no photograph is still part of the fleet. */
  it('keeps a car that has no photograph at all', () => {
    expect(carFlowItems([car({ image: null })])).toHaveLength(1)
  })

  it('stops at the twenty Meta allows', () => {
    expect(carFlowItems(Array.from({ length: 25 }, () => car()))).toHaveLength(20)
  })
})

describe('carChosenInFlow', () => {
  it('reads the car out of the reply', () => {
    expect(carChosenInFlow('{"car":"Lamborghini Huracán Tecnica"}'))
      .toBe('Lamborghini Huracán Tecnica')
  })

  /**
   * Null rather than a guess. The customer definitely chose something, and a
   * message with no body is held for a person — which is the right outcome when
   * we cannot tell which car they meant.
   */
  it.each(['not json at all', '{}', '{"car":""}', '{"car":123}', 'null', '[]'])(
    'returns nothing for %j rather than guessing',
    (payload) => {
      expect(carChosenInFlow(payload)).toBeNull()
    },
  )
})
