export const meta = {
  name: 'audit-content',
  description: 'Catalog-wide audit of published عِزبة categories: one auditor per category, adversarial verification of every flagged issue',
  whenToUse: 'When the user asks to audit/verify the questions or distractors across categories. REPORT-ONLY: never modifies existing content — findings go to the owner. Pass args: {categories?: ["seerah", ...]} — omit for the whole catalog.',
  phases: [
    { title: 'Audit', detail: 'one content-auditor per published category' },
    { title: 'Confirm', detail: 'two fact-checkers adversarially verify each flagged issue' },
  ],
}

// args: { categories?: ["seerah", "geo"] }  — omit/empty = audit everything.
const A = args || {}
const WANTED = Array.isArray(A.categories) ? A.categories.map(String).filter(Boolean) : []

const AUDIT_SCHEMA = {
  type: 'object', required: ['categoryId', 'checked', 'issues'],
  properties: {
    categoryId: { type: 'string' },
    checked: { type: 'number' },
    issues: {
      type: 'array',
      items: {
        type: 'object', required: ['q', 'a', 'type', 'detail'],
        properties: {
          q: { type: 'string' }, a: { type: 'string' },
          type: { type: 'string' }, detail: { type: 'string' },
          suggestedFix: { type: 'string' }, source: { type: 'string' },
        },
      },
    },
  },
}
const IDS_SCHEMA = {
  type: 'object', required: ['ids'],
  properties: { ids: { type: 'array', items: { type: 'string' } } },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['verdict', 'reason'],
  properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, reason: { type: 'string' } },
}

// ---- discover the category list (public Firestore read) -----------------
phase('Audit')
let ids = WANTED
if (!ids.length) {
  const listed = await agent(
    'Fetch curl -s "https://firestore.googleapis.com/v1/projects/izzbahgame/databases/(default)/documents/categories?pageSize=100&mask.fieldPaths=name" ' +
    '(follow nextPageToken if present) and return every category document id. Skip nothing.',
    { label: 'list-categories', phase: 'Audit', schema: IDS_SCHEMA }
  )
  ids = (listed && listed.ids) || []
}
if (!ids.length) throw new Error('no categories found to audit')
log(`auditing ${ids.length} categories`)

// ---- one auditor per category; flagged issues verified as they arrive ----
const results = await pipeline(
  ids,
  id => agent(
    `Audit the published عِزبة category with id «${id}». Walk EVERY question.`,
    { agentType: 'content-auditor', label: `audit:${id}`, phase: 'Audit', schema: AUDIT_SCHEMA }
  ),
  (audit, id) => {
    if (!audit || !audit.issues.length) return { id, checked: audit ? audit.checked : 0, confirmed: [] }
    return parallel(audit.issues.map(issue => () =>
      parallel([0, 1].map(n => () =>
        agent(
          `A category auditor flagged this published question. Independently verify the claim (verify #${n + 1}).\n` +
          `Category: ${id}\nQuestion: «${issue.q}»\nStated answer: «${issue.a}»\n` +
          `Claimed problem (${issue.type}): ${issue.detail}\n` +
          `Return verdict "fail" if the flag is CORRECT (the question really is defective), "pass" if the flag is wrong and the question is fine.`,
          { agentType: 'fact-checker', label: `confirm:${id}`, phase: 'Confirm', schema: VERDICT_SCHEMA }
        )
      )).then(votes => {
        const real = votes.filter(Boolean)
        const upheld = real.filter(v => v.verdict === 'fail').length >= Math.max(1, real.length) // unanimous
        return upheld ? issue : null
      })
    )).then(confirmedIssues => ({ id, checked: audit.checked, confirmed: confirmedIssues.filter(Boolean) }))
  }
)

const clean = results.filter(Boolean)
const totalChecked = clean.reduce((s, r) => s + (r.checked || 0), 0)
const allConfirmed = clean.flatMap(r => (r.confirmed || []).map(i => Object.assign({ categoryId: r.id }, i)))
log(`checked ${totalChecked} questions; ${allConfirmed.length} confirmed issues`)

return {
  categoriesAudited: clean.length,
  questionsChecked: totalChecked,
  confirmedIssues: allConfirmed,
  perCategory: clean.map(r => ({ id: r.id, checked: r.checked, confirmed: (r.confirmed || []).length })),
}
