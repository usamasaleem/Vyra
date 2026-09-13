import { describe, expect, it } from 'vitest'
import { classifyIntent, detectStopSignal } from '../src/intents.ts'

describe('messages that must stop automation', () => {
  it.each([
    ['I had an accident in the car', 'Possible accident'],
    ['the car crashed on sheikh zayed road', 'Possible accident'],
    ['my friend is injured, we are at the hospital', 'Possible accident'],
    ['the car broke down and we are stranded', 'Possible accident'],
    ['the car has been stolen', 'Possible accident'],
  ])('escalates %j', (message, reasonPrefix) => {
    const result = detectStopSignal(message)
    expect(result?.stopsAutomation).toBe(true)
    expect(result?.intent).toBe('urgent_support')
    expect(result?.reason).toContain(reasonPrefix)
  })

  it.each([
    'I want a refund',
    'I am disputing this charge',
    'you charged me twice',
    'my deposit has not been returned',
    'this is a scam',
  ])('escalates the payment dispute %j', (message) => {
    expect(detectStopSignal(message)).toMatchObject({
      stopsAutomation: true, intent: 'urgent_support',
    })
  })

  it.each([
    'can I speak to someone',
    'I want to talk to a human',
    'put me through to a manager',
    'are you a bot?',
    'call me please',
  ])('routes %j to a person', (message) => {
    expect(detectStopSignal(message)).toMatchObject({
      stopsAutomation: true, intent: 'human_request',
    })
  })

  it.each([
    'any discount available?',
    'can you do it cheaper',
    'what is your best price',
    'can you waive the delivery fee',
  ])('sends the discount request %j for approval', (message) => {
    expect(detectStopSignal(message)).toMatchObject({
      stopsAutomation: true, intent: 'discount_request',
    })
  })

  it('records what triggered it, so the decision can be explained', () => {
    expect(detectStopSignal('there has been an accident')).toMatchObject({
      matched: 'accident', basis: 'rule',
    })
  })
})

describe('what must NOT trigger an escalation', () => {
  /**
   * The false positives that would matter. Each of these is an ordinary
   * message that a careless substring match would route to urgent support.
   */
  it.each([
    'I accidentally picked the wrong date',
    'sorry, sent that accidentally',
    'is the Ferrari available on Friday',
    'how much for three days',
    'what deposit do you need',
    'can you deliver to the Marina',
    'I need a car for a wedding',
    'do you have a convertible',
  ])('leaves %j alone', (message) => {
    expect(detectStopSignal(message)).toBeNull()
  })

  it('does not fire on a vehicle name containing a rule word', () => {
    expect(detectStopSignal('do you have the Huracan Performante')).toBeNull()
  })
})

describe('hints for the ordinary intents', () => {
  it.each([
    ['is the Huracan available next weekend', 'availability_question'],
    ['how much per day', 'price_question'],
    ['what is the deposit', 'policy_question'],
    ['how many km included', 'policy_question'],
    ['I want a Lamborghini', 'vehicle_request'],
  ])('reads %j as %s', (message, intent) => {
    expect(classifyIntent(message)).toMatchObject({ intent, stopsAutomation: false, basis: 'hint' })
  })

  it('says unclear rather than guessing', () => {
    expect(classifyIntent('hi')).toMatchObject({ intent: 'unclear', basis: 'hint', matched: null })
  })

  /** A hint is revisable by the model; a rule is not. */
  it('marks ordinary intents as hints and stop signals as rules', () => {
    expect(classifyIntent('how much per day').basis).toBe('hint')
    expect(classifyIntent('I had an accident').basis).toBe('rule')
  })
})

describe('stop rules win over everything', () => {
  it('escalates even when the message is mostly an ordinary enquiry', () => {
    const message =
      'Hi, I would like to book a Ferrari for three days from Friday, delivered to the Marina. ' +
      'Also I am still waiting for my refund from last time.'
    expect(classifyIntent(message)).toMatchObject({
      stopsAutomation: true, intent: 'urgent_support', basis: 'rule',
    })
  })

  it('escalates a request for a person buried in a long message', () => {
    expect(classifyIntent('thanks for the info, the prices look fine, but can I speak to someone about the insurance'))
      .toMatchObject({ stopsAutomation: true, intent: 'human_request' })
  })
})
