import Database from 'better-sqlite3'

export function serveRxdb({dbPath, collections}) {
  const db = new Database(dbPath)

  for (const col of collections) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS "${col}" (
        id        TEXT PRIMARY KEY,
        updatedAt INTEGER NOT NULL,
        deleted   INTEGER NOT NULL DEFAULT 0,
        data      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "${col}_checkpoint"
        ON "${col}" (updatedAt, id);
    `)
  }

  // Map<collectionName, Set<(payload) => void>>
  const listeners = new Map(collections.map((col) => [col, new Set()]))

  return (next) => async (request) => {
    const url = new URL(request.url, 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean) // ['heroes', 'pull']

    if (parts.length !== 2) return next(request)

    const [collection, action] = parts

    if (!collections.includes(collection)) return next(request)

    // ── PULL ──────────────────────────────────────────────────────────────
    if (request.method === 'GET' && action === 'pull') {
      const id = url.searchParams.get('id') ?? ''
      const updatedAt = Number(url.searchParams.get('updatedAt') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 20)

      const rows = db
        .prepare(
          `SELECT id, updatedAt, deleted, data FROM "${collection}"
           WHERE (updatedAt > ?) OR (updatedAt = ? AND id > ?)
           ORDER BY updatedAt ASC, id ASC
           LIMIT ?`,
        )
        .all(updatedAt, updatedAt, id, limit)

      const documents = rows.map((row) => ({
        ...JSON.parse(row.data),
        id: row.id,
        updatedAt: row.updatedAt,
        _deleted: row.deleted === 1,
      }))

      const checkpoint =
        documents.length > 0
          ? {id: documents.at(-1).id, updatedAt: documents.at(-1).updatedAt}
          : null

      return {
        status: 200,
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({documents, checkpoint}),
      }
    }

    // ── PUSH ──────────────────────────────────────────────────────────────
    if (request.method === 'POST' && action === 'push') {
      const items = JSON.parse(request.body)
      const conflicts = []
      const written = []

      const upsert = db.prepare(
        `INSERT INTO "${collection}" (id, updatedAt, deleted, data)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updatedAt = excluded.updatedAt,
           deleted   = excluded.deleted,
           data      = excluded.data`,
      )

      for (const {assumedMasterState, newDocumentState} of items) {
        const {id} = newDocumentState
        const existing = db
          .prepare(
            `SELECT id, updatedAt, deleted, data FROM "${collection}" WHERE id = ?`,
          )
          .get(id)

        const currentMaster = existing
          ? {
              ...JSON.parse(existing.data),
              id: existing.id,
              updatedAt: existing.updatedAt,
              _deleted: existing.deleted === 1,
            }
          : null

        const masterMatches =
          currentMaster === null
            ? assumedMasterState === null || assumedMasterState === undefined
            : JSON.stringify(currentMaster) ===
              JSON.stringify(assumedMasterState)

        if (masterMatches) {
          upsert.run(
            id,
            newDocumentState.updatedAt,
            newDocumentState._deleted ? 1 : 0,
            JSON.stringify(newDocumentState),
          )
          written.push(newDocumentState)
        } else {
          conflicts.push(currentMaster)
        }
      }

      if (written.length > 0) {
        const last = written.at(-1)
        const payload = {
          documents: written,
          checkpoint: {id: last.id, updatedAt: last.updatedAt},
        }

        for (const cb of listeners.get(collection)) {
          cb(payload)
        }
      }

      return {
        status: 200,
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(conflicts),
      }
    }

    // ── PULL STREAM ───────────────────────────────────────────────────────
    if (request.method === 'GET' && action === 'pullStream') {
      let controller

      const body = new ReadableStream({
        start(c) {
          controller = c
          // Initial heartbeat
          controller.enqueue(
            `data: ${JSON.stringify({documents: [], checkpoint: null})}\n\n`,
          )

          const cb = (payload) => {
            controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`)
          }

          listeners.get(collection).add(cb)

          // Store cb on the controller so we can remove it on cancel
          controller._cb = cb
          controller._collection = collection
        },
        cancel() {
          if (controller._cb) {
            listeners.get(controller._collection).delete(controller._cb)
          }
        },
      })

      return {
        status: 200,
        headers: {'content-type': 'text/event-stream'},
        body,
      }
    }

    return next(request)
  }
}
