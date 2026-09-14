/**
 * ─────────────────────────────────────────────────────────────────────────
 *  EVERY CAR IN THIS FILE IS INVENTED.
 *
 *  No operator supplied these. The chassis numbers are not valid VINs, the
 *  plates belong to nobody, and the odometer readings are made up. They exist
 *  so the fleet path can be built and demonstrated before a real operator has
 *  entered their cars.
 *
 *  They are shaped like real Dubai rental stock on purpose, which is exactly
 *  what makes them dangerous — a plausible invented Ferrari is harder to spot
 *  than an obviously wrong one. `searchFleet` returns operator_confirmed rows
 *  only, so nothing here can reach a customer while its provenance says
 *  placeholder.
 *
 *  Note what is absent: no daily rate, no deposit, no mileage allowance. Those
 *  are commercial terms, they belong to the operator, and a plausible invented
 *  price is the single failure this whole system is built to prevent. Specs
 *  can be mocked; money cannot.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type PlaceholderVehicle = {
  make: string
  model: string
  variant: string | null
  year: number
  colour: string
  category: 'exotic' | 'luxury' | 'suv' | 'sports' | 'convertible' | 'sedan'
  plate: string
  chassisNumber: string
  engine: string
  powerHp: number
  transmission: string
  drivetrain: string
  seats: number
  doors: number
  odometerKm: number
}

export const placeholderFleet: readonly PlaceholderVehicle[] = [
  {
    make: 'Lamborghini',
    model: 'Huracán',
    variant: 'EVO Spyder',
    year: 2023,
    colour: 'Arancio Borealis (orange)',
    category: 'exotic',
    plate: 'Dubai P 41785',
    chassisNumber: 'ZHWUT4ZF0PLA14872',
    engine: '5.2 L naturally aspirated V10',
    powerHp: 631,
    transmission: '7-speed dual-clutch',
    drivetrain: 'All-wheel drive',
    seats: 2,
    doors: 2,
    odometerKm: 18420,
  },
  {
    make: 'Ferrari',
    model: '488',
    variant: 'Spider',
    year: 2022,
    colour: 'Giallo Modena (yellow)',
    category: 'exotic',
    plate: 'Dubai K 20933',
    chassisNumber: 'ZFF80AMA9N0273641',
    engine: '3.9 L twin-turbo V8',
    powerHp: 661,
    transmission: '7-speed dual-clutch',
    drivetrain: 'Rear-wheel drive',
    seats: 2,
    doors: 2,
    odometerKm: 24780,
  },
  {
    make: 'Rolls-Royce',
    model: 'Cullinan',
    variant: null,
    year: 2024,
    colour: 'English White',
    category: 'suv',
    plate: 'Dubai M 7714',
    chassisNumber: 'SLA664S59RU216503',
    engine: '6.75 L twin-turbo V12',
    powerHp: 571,
    transmission: '8-speed automatic',
    drivetrain: 'All-wheel drive',
    seats: 5,
    doors: 4,
    odometerKm: 9130,
  },
]
