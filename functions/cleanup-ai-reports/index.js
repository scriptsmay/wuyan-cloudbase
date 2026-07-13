'use strict'

const cloudbase = require('@cloudbase/node-sdk')

exports.main = async () => {
  const app = cloudbase.init({
    env: process.env.TCB_ENV || 'trial-sh-d1gqznm4577d6a062'
  })
  const db = app.database()

  const now = new Date().toISOString()
  let deleted = 0

  for (let page = 0; page < 20; page += 1) {
    const result = await db.collection('ai_reports')
      .where({
        expires_at: db.command.lte(now),
        status: db.command.neq('under_review')
      })
      .limit(100)
      .get()

    const documents = Array.isArray(result.data) ? result.data : []
    if (documents.length === 0) break

    for (const document of documents) {
      if (!document || typeof document._id !== 'string') continue
      await db.collection('ai_reports').doc(document._id).remove()
      deleted += 1
    }

    if (documents.length < 100) break
  }

  console.log('[cleanup-ai-reports] completed', { deleted, now })
  return { ok: true, deleted, now }
}
