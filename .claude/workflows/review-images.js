export const meta = {
  name: 'review-images',
  description: 'Vision QA sweep of stored question/answer photos: one image-reviewer per category, mismatches returned as a flagged list',
  whenToUse: 'After bulk image fetches, or when the user asks to review/check the pictures. REPORT-ONLY: never modifies existing images — the flagged list goes to the owner. Pass args: {categories?: ["seerah", ...]} — omit to review every category that has images.',
  phases: [
    { title: 'Review', detail: 'one image-reviewer per category (vision)' },
  ],
}

// args: { categories?: [...] } — omit/empty = every category.
const A = args || {}
const WANTED = Array.isArray(A.categories) ? A.categories.map(String).filter(Boolean) : []

const IDS_SCHEMA = {
  type: 'object', required: ['ids'],
  properties: { ids: { type: 'array', items: { type: 'string' } } },
}
const REVIEW_SCHEMA = {
  type: 'object', required: ['categoryId', 'reviewed', 'flags'],
  properties: {
    categoryId: { type: 'string' },
    reviewed: { type: 'number' },
    flags: {
      type: 'array',
      items: {
        type: 'object', required: ['q', 'a', 'field', 'problem', 'recommendation'],
        properties: {
          q: { type: 'string' }, a: { type: 'string' },
          field: { type: 'string' }, problem: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
  },
}

phase('Review')
let ids = WANTED
if (!ids.length) {
  const listed = await agent(
    'Fetch curl -s "https://firestore.googleapis.com/v1/projects/izzbahgame/databases/(default)/documents/categories?pageSize=100&mask.fieldPaths=name" ' +
    '(follow nextPageToken if present) and return every category document id.',
    { label: 'list-categories', phase: 'Review', schema: IDS_SCHEMA }
  )
  ids = (listed && listed.ids) || []
}
if (!ids.length) throw new Error('no categories found to review')
log(`reviewing images in ${ids.length} categories`)

const results = await parallel(ids.map(id => () =>
  agent(
    `Review the stored images of the عِزبة category with id «${id}». ` +
    `Decode and LOOK at every image and answerImage; report only mismatches.`,
    { agentType: 'image-reviewer', label: `images:${id}`, phase: 'Review', schema: REVIEW_SCHEMA }
  )
))

const clean = results.filter(Boolean)
const flags = clean.flatMap(r => (r.flags || []).map(f => Object.assign({ categoryId: r.categoryId }, f)))
log(`reviewed ${clean.reduce((s, r) => s + (r.reviewed || 0), 0)} images; ${flags.length} flagged`)

return {
  categoriesReviewed: clean.length,
  imagesReviewed: clean.reduce((s, r) => s + (r.reviewed || 0), 0),
  flagged: flags,
}
