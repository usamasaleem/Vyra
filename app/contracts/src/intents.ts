/**
 * Build plan step 23 — the nine MVP intents, and the ones that must stop
 * automation rather than continue it.
 *
 * The design point: the intents that stop automation are detected by rules
 * that run BEFORE any model call, and a match is final. A model asked "is this
 * an accident report?" will usually be right, and usually is the wrong standard
 * for a customer saying they have crashed a Lamborghini. Section 15 requires
 * immediate escalation for accidents, injuries, threats, fraud and disputes;
 * that is a backend rule, not a prompt instruction — which is also what the
 * roadmap means by enforcing the safety rules in the backend.
 *
 * The bias is deliberately toward stopping. A false stop costs a salesperson a
 * glance at a conversation that turned out to be ordinary. A missed one means
 * an AI discussing rental extensions with someone who has just been in a crash.
 *
 * ---
 *
 * What actually runs, as of wiring this up. For a year this file was imported
 * by nothing but its own test — the rule was written, reviewed and reachable
 * from nowhere, which is the same as not having it.
 *
 * `urgent_support` now runs before the model, in processInboundMessage, beside
 * detectOptOut. A match holds the turn and raises a handoff.
 *
 * The other two stop rules deliberately do NOT run here, because both are
 * already handled better elsewhere and moving them would make the agent worse:
 *
 *   - `discount_request` is caught after the reply by detectDiscountRequest,
 *     which raises the handoff without silencing the agent. See discount.ts:
 *     "a match does not stop the agent replying. Acknowledging the ask and
 *     collecting the context is useful work." Stopping on "cheaper" would
 *     answer an ordinary sales question with silence.
 *   - `human_request` is the model's own request_handoff call. The patterns
 *     here are broad — `\bagent\b`, `\bhuman\b`, `\bmanager\b` — and a
 *     pre-model stop on them would hand over conversations that merely used
 *     the word.
 *
 * They stay in STOP_RULES because classifyIntent is about what a message is,
 * not about what this particular caller does with it.
 */

export const INTENTS = [
  'new_enquiry',
  'vehicle_request',
  'price_question',
  'availability_question',
  'policy_question',
  'discount_request',
  'human_request',
  'urgent_support',
  'unclear',
] as const
export type Intent = (typeof INTENTS)[number]

/**
 * A stable name for the rule that fired.
 *
 * The `reason` beside it is a sentence for a person to read and will be
 * reworded; this will not. A caller choosing a handoff reason branches on this.
 */
export type StopCode = 'accident' | 'payment_dispute' | 'complaint' | 'human' | 'discount'

export type IntentDetection = {
  intent: Intent
  /** Set on a rule match, absent on a hint. */
  code?: StopCode
  /** True when automation must not continue without a person. */
  stopsAutomation: boolean
  /** How this was decided. Rules are final; hints can be overridden by a model. */
  basis: 'rule' | 'hint'
  /** The phrase that triggered it, so a decision can be explained and audited. */
  matched: string | null
  /** Why it stopped, for the handoff reason. */
  reason?: string
}

/**
 * Patterns that stop automation. Word boundaries throughout: "accident" must
 * not fire on "accidentally", which is a real message ("I accidentally picked
 * the wrong date") and would route an ordinary correction to urgent support.
 */
const STOP_RULES: ReadonlyArray<{
  intent: Intent
  code: StopCode
  reason: string
  patterns: RegExp[]
}> = [
  {
    intent: 'urgent_support',
    code: 'accident',
    reason: 'Possible accident, injury or safety issue',
    patterns: [
      /\baccident\b/, /\bcrashed?\b/, /\bcollision\b/, /\bhit (?:a|an|the|another)\b/,
      /\binjur(?:ed|y|ies)\b/, /\bhospital\b/, /\bambulance\b/, /\bpolice\b/,
      /\bbroke down\b/, /\bbreakdown\b/, /\bstranded\b/, /\btowed?\b/,
      /\bfire\b/, /\bsmoke coming\b/, /\bstolen\b/, /\btheft\b/,
    ],
  },
  {
    intent: 'urgent_support',
    code: 'payment_dispute',
    reason: 'Payment, refund or fraud dispute',
    patterns: [
      /\brefund\b/, /\bchargeback\b/, /\bdispute\b/, /\bdisputing\b/,
      /\bfraud\b/, /\bscam(?:med)?\b/, /\bunauthoris?zed charge\b/,
      /\bovercharged\b/, /\bdouble[- ]charged\b/,
      // "charged me twice", "charged twice", "charged us twice" — people
      // rarely phrase a complaint the way a pattern author expects.
      /\bcharged (?:me |us |him |her |them )?twice\b/,
      /\bmoney back\b/, /\bdeposit (?:not|hasn'?t|has not) (?:been )?return/,
    ],
  },
  {
    intent: 'urgent_support',
    code: 'complaint',
    reason: 'Complaint or legal escalation',
    patterns: [
      /\bcomplaint\b/, /\bcomplain\b/, /\blawyer\b/, /\blegal action\b/,
      /\bsue\b/, /\bsuing\b/, /\bcourt\b/, /\bconsumer protection\b/,
      /\bunacceptable\b/, /\bdisgusting\b/,
    ],
  },
  {
    intent: 'human_request',
    code: 'human',
    reason: 'The customer asked for a person',
    patterns: [
      /\b(?:speak|talk|chat) (?:to|with) (?:a |an |someone|somebody|a real |a human)/,
      /\breal person\b/, /\bhuman\b/, /\bagent\b/, /\bmanager\b/,
      /\bcall me\b/, /\bphone me\b/, /\bcustomer service\b/,
      /\bis (?:this|it) (?:a )?(?:bot|robot|ai)\b/, /\bare you (?:a )?(?:bot|robot|ai|human|real)\b/,
    ],
  },
  {
    intent: 'discount_request',
    code: 'discount',
    reason: 'Discount or exception requested — needs human approval',
    patterns: [
      /\bdiscount\b/, /\bcheaper\b/, /\bbest price\b/, /\bbetter price\b/,
      /\bany deal\b/, /\bspecial (?:price|rate|offer)\b/, /\bnegotiat/,
      /\bwaive\b/, /\bfree upgrade\b/, /\bmake it\b.*\b(?:instead|please)\b/,
    ],
  },
]

/** Best-effort hints for the intents that do not stop anything. */
const HINT_RULES: ReadonlyArray<{ intent: Intent; patterns: RegExp[] }> = [
  {
    intent: 'availability_question',
    patterns: [/\bavailable\b/, /\bavailability\b/, /\bfree (?:on|this|next|for)\b/, /\bin stock\b/, /\bdo you have\b/],
  },
  {
    intent: 'price_question',
    patterns: [/\bhow much\b/, /\bprice\b/, /\bcost\b/, /\brate\b/, /\bquote\b/, /\bper day\b/, /\bdaily\b/],
  },
  {
    intent: 'policy_question',
    patterns: [
      /\bdeposit\b/, /\binsurance\b/, /\bkilometres?\b/, /\bkilometers?\b/, /\bkm\b/,
      /\bmileage\b/, /\bfuel\b/, /\bsalik\b/, /\bfines?\b/, /\bdelivery\b/, /\bdeliver\b/,
      /\blicen[cs]e\b/, /\bdocuments?\b/, /\bage\b/, /\bidp\b/, /\bemirates id\b/, /\bvisa\b/,
    ],
  },
  {
    intent: 'vehicle_request',
    patterns: [
      /\bferrari\b/, /\blamborghini\b/, /\blambo\b/, /\bporsche\b/, /\bmclaren\b/,
      /\brolls[- ]?royce\b/, /\bbentley\b/, /\bmercedes\b/, /\bbmw\b/, /\baudi\b/,
      /\bsupercar\b/, /\bsports car\b/, /\bconvertible\b/, /\bsuv\b/,
    ],
  },
]

const normalise = (text: string) =>
  text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim()

/**
 * Runs before any model call. A match here is final: the model is not asked
 * for a second opinion on whether someone has had an accident.
 */
export function detectStopSignal(text: string): IntentDetection | null {
  const normalised = normalise(text)
  for (const rule of STOP_RULES) {
    for (const pattern of rule.patterns) {
      const match = normalised.match(pattern)
      if (match !== null) {
        return {
          intent: rule.intent,
          code: rule.code,
          stopsAutomation: true,
          basis: 'rule',
          matched: match[0],
          reason: rule.reason,
        }
      }
    }
  }
  return null
}

/**
 * Classifies a message.
 *
 * Stop rules first and unconditionally. Everything else is a hint the AI turn
 * may revise — section 18.8 puts interpretation behind a model, but not the
 * decision to stop.
 */
export function classifyIntent(text: string): IntentDetection {
  const stop = detectStopSignal(text)
  if (stop !== null) return stop

  const normalised = normalise(text)
  for (const rule of HINT_RULES) {
    for (const pattern of rule.patterns) {
      const match = normalised.match(pattern)
      if (match !== null) {
        return { intent: rule.intent, stopsAutomation: false, basis: 'hint', matched: match[0] }
      }
    }
  }

  return { intent: 'unclear', stopsAutomation: false, basis: 'hint', matched: null }
}
