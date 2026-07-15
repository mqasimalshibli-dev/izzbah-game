export const meta = {
  name: 'author-category',
  description: 'Draft, adversarially fact-check, and curate a full question bank for one عِزبة category',
  whenToUse: 'When the user asks to generate/write questions for a category (e.g. مواقع في عمان، دين، ميمز). Drafts a NEW bank only — never touches existing questions or pictures; publishing stays a separate, explicit step. Pass args: {name, guidance?, perTier?, strict?}.',
  phases: [
    { title: 'Draft', detail: 'one question-writer per point tier' },
    { title: 'Verify', detail: 'adversarial fact-check panel per question' },
    { title: 'Curate', detail: 'dedupe vs live catalog, style pass, final bank' },
  ],
}

// args: { name: "مواقع في عمان", guidance?: "focus on...", perTier?: 6, strict?: true }
// strict=true (default for religious topics) => 3 refuters/question, 0 tolerated fails.
const A = args || {}
const CATEGORY = String(A.name || '').trim()
if (!CATEGORY) throw new Error('author-category needs args.name (the category name)')
const GUIDANCE = String(A.guidance || '')
const PER_TIER = Math.max(2, Math.min(26, Number(A.perTier) || 6))
const STRICT = A.strict === undefined ? /دين|سيره|سيرة|إسلام|اسلام|قرآن|قران/.test(CATEGORY) : !!A.strict
const TIERS = [100, 200, 300, 400, 500]

const QUESTIONS_SCHEMA = {
  type: 'object', required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object', required: ['points', 'q', 'a', 'distractors'],
        properties: {
          points: { type: 'number' }, q: { type: 'string' }, a: { type: 'string' },
          distractors: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
          source: { type: 'string' },
        },
      },
    },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    reason: { type: 'string' },
    badDistractor: { type: ['string', 'null'] },
    suggestedFix: { type: ['object', 'null'] },
  },
}
const BANK_SCHEMA = {
  type: 'object', required: ['bank', 'report'],
  properties: {
    bank: QUESTIONS_SCHEMA.properties.questions,
    report: { type: 'string' },
  },
}

// ---- Draft: one writer per tier, all concurrent -------------------------
phase('Draft')
const drafts = await parallel(TIERS.map(tier => () =>
  agent(
    `Category: «${CATEGORY}». ${GUIDANCE ? 'Guidance from the game owner: ' + GUIDANCE + '. ' : ''}` +
    `Write exactly ${PER_TIER} questions for the ${tier}-point tier ` +
    `(difficulty: ${tier <= 200 ? 'easy, common knowledge' : tier <= 400 ? 'medium, a fan knows it' : 'hard, specialist'}). ` +
    `Every question must have points=${tier}. Research and verify each fact before including it.`,
    { agentType: 'question-writer', label: `draft:${tier}`, phase: 'Draft', schema: QUESTIONS_SCHEMA }
  )
))
const drafted = drafts.filter(Boolean).flatMap(d => d.questions)
log(`drafted ${drafted.length} questions across ${TIERS.length} tiers`)

// ---- Verify: adversarial refuter panel per question (no barrier) --------
const REFUTERS = STRICT ? 3 : 2
const verified = await pipeline(
  drafted,
  q => parallel(Array.from({ length: REFUTERS }, (_, i) => () =>
    agent(
      `Question: «${q.q}»\nStated answer: «${q.a}»\nDistractors: ${JSON.stringify(q.distractors)}\n` +
      `Category: «${CATEGORY}». ${STRICT ? 'STRICT mode: religious/historical content — reject on ANY scholarly dispute.' : ''} ` +
      `Attack it as refuter #${i + 1}.`,
      { agentType: 'fact-checker', label: `verify:${q.a}`.slice(0, 40), phase: 'Verify', schema: VERDICT_SCHEMA }
    )
  )).then(votes => {
    const real = votes.filter(Boolean)
    const fails = real.filter(v => v.verdict === 'fail')
    const keep = STRICT ? fails.length === 0 : fails.length < Math.ceil(real.length / 2)
    return { q, keep, fails: fails.map(f => f.reason).slice(0, 3) }
  })
)
const survivors = verified.filter(Boolean).filter(v => v.keep).map(v => v.q)
const rejected = verified.filter(Boolean).filter(v => !v.keep)
log(`${survivors.length}/${drafted.length} questions survived the panel (${rejected.length} rejected)`)

// ---- Curate: dedupe against the live catalog + style pass ---------------
phase('Curate')
const final = await agent(
  `You are curating the final question bank for the عِزبة category «${CATEGORY}». ` +
  `Below are ${survivors.length} fact-checked questions. Your tasks: ` +
  `1) fetch the LIVE catalog meta docs (curl -s "https://firestore.googleapis.com/v1/projects/izzbahgame/databases/(default)/documents/categories?pageSize=100") ` +
  `and drop any question that duplicates existing published content; ` +
  `2) unify Arabic style (short, speakable, «؟» endings, consistent digits); ` +
  `3) confirm each question's distractors are same-kind and clearly wrong; ` +
  `4) keep tiers balanced. Return the final bank plus a short report of what you dropped/changed.\n\n` +
  JSON.stringify(survivors),
  { label: 'curate', phase: 'Curate', schema: BANK_SCHEMA }
)

return {
  category: CATEGORY,
  bank: final ? final.bank : survivors,
  curatorReport: final ? final.report : 'curator unavailable — returning raw survivors',
  drafted: drafted.length,
  survived: survivors.length,
  rejectedSamples: rejected.slice(0, 10).map(r => ({ q: r.q.q, why: r.fails[0] || '' })),
}
