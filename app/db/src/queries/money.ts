/**
 * Rendering money for a customer-facing sentence.
 *
 * Amounts are integer minor units everywhere in this system, which is right for
 * arithmetic and wrong for a model. If a tool handed back 800000 and a currency
 * the model would have to divide by a hundred and group the thousands itself,
 * and a model doing arithmetic on a price is the failure this whole boundary
 * exists to prevent. So the division happens here, once, and the tool hands
 * over a finished string the model can only repeat.
 */
export function formatMoneyMinor(minor: number, currency: string): string {
  const major = minor / 100
  // Whole amounts print without a decimal tail: rental rates in this market are
  // whole hundreds, and "AED 8,000.00" reads like a software invoice rather
  // than something a salesperson would say.
  const hasFraction = minor % 100 !== 0
  const body = major.toLocaleString('en-US', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  })
  return `${currency} ${body}`
}
