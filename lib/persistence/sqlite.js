import path from 'node:path'
import fs from 'node:fs/promises'
import Database from 'better-sqlite3'
import {createRxDatabase} from 'rxdb'
import {getRxStorageMemory} from 'rxdb/plugins/storage-memory'
import {replicateRxCollection} from 'rxdb/plugins/replication'
import {Observable} from 'rxjs'

function sanitizeId(id) {
  return String(id).replaceAll(/[^\w-]/g, '_')
}

function stripAttachmentData(attachments) {
  return Object.fromEntries(
    Object.entries(attachments).map(([attachmentId, attachment]) => {
      const {data: _data, ...stub} = attachment
      return [attachmentId, stub]
    }),
  )
}

export class Persistence {
  static rxDbInstanceCount = 0
  #database
  #rxDatabases = []
  #schemas
  #collections = {}

  constructor(databasePath, schemas, {attachmentsDir} = {}) {
    this.#database = new Database(databasePath)
    this.#schemas = schemas

    for (const collectionName of Object.keys(schemas)) {
      this.#collections[collectionName] = new Collection(
        this.#database,
        collectionName,
        attachmentsDir ? path.join(attachmentsDir, collectionName) : null,
      )
    }
  }

  get schemas() {
    return this.#schemas
  }

  subscribe(collectionName, callback) {
    return this.#collections[collectionName].subscribe(callback)
  }

  pull(collectionName, checkpoint) {
    return this.#collections[collectionName].pull(checkpoint)
  }

  push(collectionName, items) {
    return this.#collections[collectionName].push(items)
  }

  async createRxDatabase() {
    const instanceId = ++this.constructor.rxDbInstanceCount

    const db = await createRxDatabase({
      name: `rxdb-${instanceId}`,
      storage: getRxStorageMemory(),
    })
    this.#rxDatabases.push(db)

    await db.addCollections(this.#schemas)

    for (const collectionName of Object.keys(this.#schemas)) {
      const replicationState = replicateRxCollection({
        collection: db[collectionName],
        replicationIdentifier: `${collectionName}-${instanceId}`,
        push: {
          handler: (items) => this.push(collectionName, items),
        },
        pull: {
          handler: (checkpointOrNull, pageSize) => {
            const updatedAt = checkpointOrNull?.updatedAt ?? 0
            const id = checkpointOrNull?.id ?? ''
            return this.pull(collectionName, {updatedAt, id, pageSize})
          },
          stream$: new Observable((subscriber) => {
            this.subscribe(collectionName, (payload) => {
              subscriber.next(payload)
            })
          }),
        },
      })

      await replicationState.awaitInitialReplication()
    }

    return db
  }

  async dispose() {
    this.#database.close()
    for (const db of this.#rxDatabases) {
      await db.close()
    }
  }
}

class Collection {
  #database
  #name
  #attachmentsDir
  #subscribers = new Set()
  #pullStatement
  #pushStatement
  #getStatement

  constructor(database, name, attachmentsDir = null) {
    this.#database = database
    this.#name = name
    this.#attachmentsDir = attachmentsDir

    database.exec(`
      CREATE TABLE IF NOT EXISTS "${name}" (
        id        TEXT PRIMARY KEY,
        updatedAt INTEGER NOT NULL,
        deleted   INTEGER NOT NULL DEFAULT 0,
        data      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "${name}_checkpoint"
        ON "${name}" (updatedAt, id);
    `)

    this.#pullStatement = database.prepare(`
      SELECT id, updatedAt, deleted, data FROM "${name}"
      WHERE (updatedAt > :updatedAt) OR (updatedAt = :updatedAt AND id > :id)
      ORDER BY updatedAt ASC, id ASC
      LIMIT :pageSize
    `)

    this.#pushStatement = database.prepare(`
      INSERT INTO "${name}" (id, updatedAt, deleted, data)
      VALUES (:id, :updatedAt, :deleted, :data)
      ON CONFLICT(id) DO UPDATE SET
        updatedAt = excluded.updatedAt,
        deleted   = excluded.deleted,
        data      = excluded.data
    `)

    this.#getStatement = database.prepare(`
      SELECT id, updatedAt, deleted, data FROM "${name}"
      WHERE id IN (SELECT value FROM json_each(?))
    `)
  }

  subscribe(callback) {
    this.#subscribers.add(callback)
    return () => {
      this.#subscribers.delete(callback)
    }
  }

  async pull({updatedAt, id, pageSize}) {
    const rows = this.#pullStatement.all({updatedAt, id, pageSize})
    const documents = await Promise.all(
      rows.map(async (row) => {
        const doc = {
          ...JSON.parse(row.data),
          id: row.id,
          updatedAt: row.updatedAt,
          _deleted: row.deleted === 1,
        }

        if (this.#attachmentsDir && doc._attachments) {
          for (const [attachmentId, attachment] of Object.entries(
            doc._attachments,
          )) {
            const filePath = this.#attachmentPath(row.id, attachmentId)
            try {
              doc._attachments[attachmentId] = {
                ...attachment,
                data: await fs.readFile(filePath, 'utf8'),
              }
            } catch (error) {
              if (error.code !== 'ENOENT') throw error
            }
          }
        }

        return doc
      }),
    )

    const checkpoint =
      documents.length > 0
        ? {id: documents.at(-1).id, updatedAt: documents.at(-1).updatedAt}
        : null

    return {documents, checkpoint}
  }

  async push(items) {
    const conflicts = []
    const written = []

    const existingRows = this.get(items.map((item) => item.newDocumentState.id))
    const existingRowsById = Object.fromEntries(
      existingRows.map((row) => [row.id, row]),
    )

    for (const {assumedMasterState, newDocumentState} of items) {
      const {id} = newDocumentState
      const existing = existingRowsById[id]

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
          : JSON.stringify(currentMaster) === JSON.stringify(assumedMasterState)

      if (masterMatches) {
        if (this.#attachmentsDir && newDocumentState._attachments) {
          for (const [attachmentId, attachment] of Object.entries(
            newDocumentState._attachments,
          )) {
            if (attachment.data) {
              await this.#saveAttachment(id, attachmentId, attachment.data)
            }
          }
        }

        const docToStore = newDocumentState._attachments
          ? {
              ...newDocumentState,
              _attachments: stripAttachmentData(newDocumentState._attachments),
            }
          : newDocumentState

        this.#pushStatement.run({
          id,
          updatedAt: newDocumentState.updatedAt,
          deleted: newDocumentState._deleted ? 1 : 0,
          data: JSON.stringify(docToStore),
        })
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

      for (const callback of this.#subscribers) {
        callback(payload)
      }
    }

    return conflicts
  }

  async #saveAttachment(docId, attachmentId, data) {
    const filePath = this.#attachmentPath(docId, attachmentId)
    await fs.mkdir(path.dirname(filePath), {recursive: true})
    await fs.writeFile(filePath, data, 'utf8')
  }

  #attachmentPath(docId, attachmentId) {
    return path.join(
      this.#attachmentsDir,
      sanitizeId(docId),
      sanitizeId(attachmentId),
    )
  }

  get(ids) {
    return this.#getStatement.all(JSON.stringify(ids))
  }
}
