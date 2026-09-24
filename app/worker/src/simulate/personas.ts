/**
 * The customers.
 *
 * Each is a brief a person could act out — who they are, what they want, how
 * they write, what they will and will not tell you — and what a good outcome
 * is. The brief goes to a model playing the customer; the outcome is checked
 * against the database afterwards, never against the wording.
 *
 * Written from what has gone wrong live: the photos sent together, the
 * customer who switched to collection, the one who asked for the details
 * rather than paying on collection, the P.O. Box, the one who went quiet.
 */
export type Expectation = {
  /** What should be true at the end. */
  outcome: 'booked' | 'held' | 'not_booked' | 'handoff'
  vehicle?: 'Ferrari' | 'Lamborghini' | 'Rolls-Royce'
  /** Rental days the quote should be for. */
  days?: number
  handover?: 'delivery' | 'collection'
  /** Photos that should be on the booking. */
  documents?: number
  /** The booking should have been extended. */
  extended?: boolean
  /** The whole-booking summary should have gone. */
  summary?: boolean
  /** The price they booked at had the standing discount on it. */
  discounted?: boolean
  /** It waited for a person because it is over the operator's limits. */
  waits?: boolean
  /** Extras that should be on the booking, by label prefix. */
  addOns?: string[]
}

export type Persona = {
  id: string
  title: string
  /** Everything the simulated customer knows about themselves. */
  brief: string
  expect: Expectation
  /** Something already true before they write — another customer's booking, or their own last one. */
  before?: 'ferrari_taken' | 'rented_before'
  /** Customer turns before the run gives up. */
  maxTurns?: number
}

const PHOTOS = 'When asked for your documents, send them as photos: reply with {"photo": "licence"} '
  + 'and then {"photo": "id"} as two separate turns.'

export const PERSONAS: Persona[] = [
  {
    id: 'decisive-visitor',
    title: 'Decisive visitor, delivery to a hotel',
    brief: 'You are James, a British tourist in Dubai. You want the Ferrari from this coming Friday, '
      + 'returning Sunday (2 days), delivered to the Atlantis The Palm hotel, lobby entrance, at 10am. '
      + 'You pay by bank transfer and say "sent" after being told how. You write short, friendly '
      + `messages and book as soon as you have a price. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Ferrari', days: 2, handover: 'delivery', documents: 2, summary: true },
  },
  {
    id: 'resident-collector',
    title: 'Resident collecting tomorrow, pays at the handover',
    brief: 'You are Omar, you live in Dubai. You want the Lamborghini tomorrow for one day (returning '
      + 'the day after). You will collect it yourself at 11am. You pay by card when you collect. You '
      + `are brisk: "lambo tmrw 1 day", "collect", "11am". ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Lamborghini', days: 1, handover: 'collection', documents: 2, summary: true },
  },
  {
    id: 'price-shopper',
    title: 'Compares all three, then picks one',
    brief: 'You are Sara. Ask what cars they have and what each costs per day. Ask which is best for '
      + 'a family of four (it is the Rolls-Royce). Then book the Rolls-Royce Cullinan from next Monday '
      + 'to next Wednesday (2 days), delivered to Emaar Beachfront, Tower 2, at 9am. You live in Dubai. '
      + `You pay by payment link. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Rolls-Royce', days: 2, handover: 'delivery', summary: true },
  },
  {
    id: 'hesitant-holds',
    title: 'Needs to check with his wife',
    brief: 'You are Ahmed. You want the Ferrari this Saturday to Monday (2 days). When you get the '
      + 'price, say you need to check with your wife first and ask if they can keep it for you. '
      + 'After they confirm it is held, say thanks and stop — reply {"done": "will come back later"}.',
    expect: { outcome: 'held', vehicle: 'Ferrari', days: 2 },
  },
  {
    id: 'taps-hold-then-books',
    title: 'Taps "Hold it for me", then comes back and books',
    brief: 'You are Lina. You want the Lamborghini next Thursday to Saturday (2 days). When offered '
      + 'buttons including "Hold it for me", tap it. Then send {"wait": true} once to go quiet. When '
      + 'you hear from them again, tap "Yes, book it" (or say yes). You will collect it at 2pm. You '
      + `are visiting from Germany. ${PHOTOS} You pay on collection.`,
    expect: { outcome: 'booked', vehicle: 'Lamborghini', days: 2, handover: 'collection' },
  },
  {
    id: 'goes-quiet',
    title: 'Goes quiet after the price, answers the follow-up',
    brief: 'You are Rahul. Ask for the Rolls-Royce for this Sunday, returning Tuesday (2 days). When '
      + 'you get the price, send {"wait": true} to go quiet. When they follow up, say "ok book it". '
      + 'Delivery to Dubai Hills, Park Heights 2, flat 1204, at 6pm. You live in Dubai. You pay by bank '
      + `transfer, and say "done" after. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Rolls-Royce', days: 2, handover: 'delivery' },
  },
  {
    id: 'arabic-resident',
    title: 'Writes only in Arabic',
    brief: 'You are Khalid and you write ONLY in Gulf Arabic, never English. You want the Rolls-Royce '
      + 'Cullinan from next Friday to Sunday (2 days), delivered to Downtown Dubai, Burj Vista Tower 1, '
      + `at 4pm. You live in the UAE. You pay by bank transfer. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Rolls-Royce', days: 2, handover: 'delivery' },
  },
  {
    id: 'switches-to-collection',
    title: 'Chooses delivery, then switches to collection',
    brief: 'You are Chen, visiting from Singapore. You want the Ferrari next Tuesday to Thursday (2 '
      + 'days). Book it. First say you want it delivered, but when asked for the address, change your '
      + `mind: "actually I will collect it". Collect at 10am. Pay by card at collection. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Ferrari', days: 2, handover: 'collection' },
  },
  {
    id: 'changes-dates',
    title: 'Changes dates after the quote',
    brief: 'You are Fatima. Ask for the Lamborghini this Friday to Sunday. When quoted, say "actually '
      + 'can we do Saturday to Tuesday instead" (3 days). Then book it. Collect at noon. You live in '
      + `Dubai. Pay at collection. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Lamborghini', days: 3, handover: 'collection' },
  },
  {
    id: 'asks-discount',
    title: 'Asks for a discount',
    brief: 'You are Marco. Ask for the Rolls-Royce for 3 days from next Monday. When you get the '
      + 'price, ask for a discount — "can you do better on the price, 20% off?" — and insist once. '
      + 'Do not book unless the price comes down. Stop after 6 messages with {"done": "waiting on discount"}.',
    expect: { outcome: 'handoff' },
    maxTurns: 8,
  },
  {
    id: 'under-age',
    title: 'Driver is 22',
    brief: 'You are Tom, 22 years old, visiting from Australia. You want the Ferrari this weekend. If '
      + 'they ask about the driver or documents, say you are 22 and have had your licence 3 years. If '
      + 'told you are too young, ask if there is any way around it, then give up with {"done": "too young"}.',
    expect: { outcome: 'not_booked' },
    maxTurns: 10,
  },
  {
    id: 'photos-together',
    title: 'Sends both documents at once',
    brief: 'You are Aisha, you live in Dubai. Book the Ferrari for next Wednesday to Friday (2 days), '
      + 'collect at 3pm, pay on collection. When asked for documents, send BOTH in one turn: reply '
      + '{"photos": ["licence", "id"]}.',
    expect: { outcome: 'booked', vehicle: 'Ferrari', days: 2, handover: 'collection', documents: 2 },
  },
  {
    id: 'po-box',
    title: 'Gives a P.O. Box as the address',
    brief: 'You are Victor, visiting from Canada. Book the Rolls-Royce this Saturday to Monday (2 '
      + 'days), delivered. When asked for the address, first give "P.O. Box 55518, Dubai". If they '
      + 'ask for a real address, give "JW Marriott Marquis, Business Bay, main entrance". Time 11am. '
      + `Pay by payment link. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Rolls-Royce', days: 2, handover: 'delivery' },
  },
  {
    id: 'car-taken',
    title: 'Wants a car that is already booked',
    brief: 'You are Noor. You want the Ferrari from this Friday to Sunday. If they say it is not '
      + 'available, accept whatever alternative car they suggest for the same dates and book it. '
      + `Collect at 1pm. You live in Dubai. Pay at collection. ${PHOTOS}`,
    before: 'ferrari_taken',
    expect: { outcome: 'booked', days: 2, handover: 'collection' },
  },
  {
    id: 'off-topic',
    title: 'Chats about other things first',
    brief: 'You are Leo. Start by asking what the weather will be like this weekend in Dubai, then '
      + 'ask which football team they support. Then ask for the Lamborghini next Saturday to Monday '
      + `(2 days), collect at 10am, pay at collection. You live in Dubai. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Lamborghini', days: 2, handover: 'collection' },
  },
  {
    id: 'wants-a-person',
    title: 'Asks for a person straight away',
    brief: 'You are Mr. Haddad. Your first message: "I want to speak to a real person, not a bot". '
      + 'If they hand you over, reply {"done": "handed over"}.',
    expect: { outcome: 'handoff' },
    maxTurns: 4,
  },
  {
    id: 'terse',
    title: 'Writes in fragments',
    brief: 'You are Dan. You write in tiny fragments only: "ferrari?", "fri-sun", "deliver", '
      + '"marina gate 2 apt 1904", "10am", "transfer", "done". You are visiting from the US. Book it '
      + `when you get a price. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Ferrari', days: 2, handover: 'delivery' },
  },
  {
    id: 'delivery-fee',
    title: 'Asks whether delivery is free',
    brief: 'You are Priya. Ask for the Lamborghini next Friday to Sunday (2 days) and ask "is delivery '
      + 'free?" Then book it, delivered to Palm Jumeirah, Shoreline Apartments building 8, at 9am. You '
      + `live in Dubai. Pay by transfer. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Lamborghini', days: 2, handover: 'delivery' },
  },
  {
    id: 'extends',
    title: 'Books, then asks to keep it longer',
    brief: 'You are Yusuf, you live in Dubai. Book the Ferrari from tomorrow for 2 days (returning the '
      + 'day after next), collect at 9am, pay at collection. After everything is done and you have the '
      + `summary, ask "can I keep it 2 more days?" and agree. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Ferrari', handover: 'collection', extended: true },
  },
  {
    id: 'haggler-week',
    title: 'Says a week is too expensive',
    brief: 'You are Nadia, you live in Dubai. You want the Ferrari for 7 days from next Monday (returning '
      + 'the Monday after). When you hear the price, say "that\'s too expensive, can you do better?". If '
      + 'they take money off, accept and book it. Collect at 10am, pay at collection. ' + PHOTOS,
    expect: { outcome: 'booked', vehicle: 'Ferrari', days: 7, handover: 'collection', discounted: true },
  },
  {
    id: 'long-rental',
    title: 'Wants the Lamborghini for three weeks',
    brief: 'You are Victor, visiting from France. You want the Lamborghini for 21 days from next '
      + 'Monday. When given a price, say "yes, book it". Accept whatever they say about confirming it, '
      + 'then reply {"done": "waiting for confirmation"}.',
    expect: { outcome: 'held', vehicle: 'Lamborghini', days: 21, waits: true },
    maxTurns: 6,
  },
  {
    id: 'returning',
    title: 'Rented before, comes back for another',
    brief: 'You are Hamdan. You rented the Ferrari from them earlier this year and loved it. Say hi and '
      + 'that you want the Ferrari again this coming Saturday to Monday (2 days), delivered to the same '
      + 'place as last time, at 11am. If asked for documents, say they already have them from last '
      + 'time. You pay by card at the handover.',
    before: 'rented_before',
    expect: { outcome: 'booked', vehicle: 'Ferrari', days: 2, handover: 'delivery', summary: true },
  },
  {
    id: 'wants-chauffeur',
    title: 'Takes the chauffeur when it is offered',
    brief: 'You are Mr. Al Mansoori, you live in Dubai. Book the Rolls-Royce from this Saturday to Monday '
      + '(2 days), delivered to Emirates Hills, Villa 44, at 10am. Pay by bank transfer. When they mention '
      + 'a chauffeur, say yes please, you want the chauffeur. ' + PHOTOS,
    expect: { outcome: 'booked', vehicle: 'Rolls-Royce', days: 2, handover: 'delivery', addOns: ['Chauffeur'] },
  },
  {
    id: 'two-questions',
    title: 'Asks lots of questions before booking',
    brief: 'You are Elena, visiting from Italy. Before booking, ask: how many km are included, what '
      + 'the deposit is, and whether you can drive to Abu Dhabi. Then book the Rolls-Royce next Sunday '
      + `to Tuesday (2 days), collect at 5pm, pay at collection. ${PHOTOS}`,
    expect: { outcome: 'booked', vehicle: 'Rolls-Royce', days: 2, handover: 'collection' },
  },
]
