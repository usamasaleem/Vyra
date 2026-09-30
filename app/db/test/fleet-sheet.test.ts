import { describe, expect, it } from 'vitest'
import { amountToMinor, readFleetSheet } from '../src/fleet-sheet.ts'

const HEAD = ['Make', 'Model', 'Year', 'Colour', 'Type', 'Plate Number', 'VIN', 'Daily Rate (AED)', 'Deposit']

describe('amountToMinor', () => {
  it('reads amounts the way operators write them', () => {
    expect(amountToMinor('1,500')).toBe(150000)
    expect(amountToMinor('AED 1 500.50')).toBe(150050)
    expect(amountToMinor('')).toBeNull()
    expect(amountToMinor('call us')).toBeNaN()
  })
})

describe('readFleetSheet', () => {
  it('matches common headings and reads a car', () => {
    const sheet = readFleetSheet([
      HEAD,
      ['Lamborghini', 'Urus', 2024, 'Nero', 'Supercar', 'Dubai A 12345', 'zpbua1zl9rlh12345', '2,500', '5000'],
    ])
    if (!sheet.ok) throw new Error('expected a sheet')
    expect(sheet.missing).toEqual([])
    expect(sheet.matched.dailyRate).toBe('Daily Rate (AED)')
    expect(sheet.rows).toHaveLength(1)
    expect(sheet.rows[0]).toMatchObject({
      line: 2,
      problem: null,
      car: { make: 'Lamborghini', year: 2024, category: 'exotic', dailyRateMinor: 250000, depositMinor: 500000 },
    })
  })

  it('skips a title above the headings and blank rows', () => {
    const sheet = readFleetSheet([
      ['Our fleet'], [], HEAD, [],
      ['Ferrari', 'Roma', '2023', 'Rosso', 'Sports', 'Dubai B 1', 'VIN1', '1800', ''],
    ])
    if (!sheet.ok) throw new Error('expected a sheet')
    expect(sheet.rows.map((r) => r.line)).toEqual([5])
    expect(sheet.rows[0]!.car.depositMinor).toBeNull()
  })

  it('says what is wrong with a row instead of guessing', () => {
    const sheet = readFleetSheet([
      HEAD,
      ['Ferrari', 'Roma', '2023', 'Rosso', 'Hatchback', 'Dubai B 1', 'VIN1', '1800', ''],
      ['Ferrari', 'Roma', '2023', 'Rosso', 'Sports', '', 'VIN2', '1800', ''],
      ['Ferrari', 'Roma', '2023', 'Rosso', 'Sports', 'Dubai B 3', 'VIN3', 'ask', ''],
      ['Ferrari', 'Roma', 'n/a', 'Rosso', 'Sports', 'Dubai B 4', 'VIN4', '1800', ''],
    ])
    if (!sheet.ok) throw new Error('expected a sheet')
    expect(sheet.rows.map((r) => r.problem)).toEqual(['category', 'plate', 'rate', 'year'])
  })

  it('flags a car listed twice, ignoring case and spacing', () => {
    const sheet = readFleetSheet([
      HEAD,
      ['Ferrari', 'Roma', '2023', 'Rosso', 'Sports', 'Dubai B 1', 'VIN1', '1800', ''],
      ['Ferrari', 'Roma', '2023', 'Rosso', 'Sports', 'DUBAI B1', 'VIN9', '1800', ''],
    ])
    if (!sheet.ok) throw new Error('expected a sheet')
    expect(sheet.rows.map((r) => r.problem)).toEqual([null, 'repeated_in_sheet'])
  })

  it('names the columns a sheet lacks rather than failing every row', () => {
    const sheet = readFleetSheet([['Make', 'Model', 'Year'], ['Kia', 'K5', '2024']])
    if (!sheet.ok) throw new Error('expected a sheet')
    expect(sheet.missing).toEqual(['colour', 'category', 'plate', 'chassis', 'dailyRate'])
  })

  it('reports an empty sheet and one with no recognisable headings', () => {
    expect(readFleetSheet([[], ['', '']])).toEqual({ ok: false, reason: 'empty' })
    expect(readFleetSheet([['Foo', 'Bar'], ['1', '2']])).toEqual({ ok: false, reason: 'no_headings' })
  })
})
