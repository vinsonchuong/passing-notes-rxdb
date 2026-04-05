import {Subject} from 'rxjs'
import {
  categorizeBulkWriteRows,
  getQueryMatcher,
  getSortComparator,
  getPrimaryFieldOfPrimaryKey,
  prepareQuery as rxdbPrepareQuery,
} from 'rxdb'

export function prepareQuery(schema, mutateableQuery) {
  return rxdbPrepareQuery(schema, mutateableQuery)
}

export function getRxStorageOPFS() {
  return {
    name: 'opfs',
    rxdbVersion: '16.0.0',
    createStorageInstance(params) {
      return createOPFSStorageInstance(params)
    },
  }
}

async function createOPFSStorageInstance(params) {
  const {databaseName, collectionName, schema, getDirectory} = params
  const primaryPath = getPrimaryFieldOfPrimaryKey(schema.primaryKey)

  const documents = new Map()
  const changes$ = new Subject()

  const io = getDirectory
    ? new DirectoryIO(getDirectory, collectionName)
    : new OPFSDirectoryIO(databaseName, collectionName)

  await io.load(documents)

  return new RxStorageInstanceOPFS({
    params,
    primaryPath,
    documents,
    changes$,
    io,
  })
}

class RxStorageInstanceOPFS {
  #primaryPath
  #documents
  #changes$
  #io
  closed = false
  schema
  databaseName
  collectionName

  constructor({params, primaryPath, documents, changes$, io}) {
    this.schema = params.schema
    this.databaseName = params.databaseName
    this.collectionName = params.collectionName
    this.#primaryPath = primaryPath
    this.#documents = documents
    this.#changes$ = changes$
    this.#io = io
  }

  async bulkWrite(documentWrites, context) {
    const categorized = categorizeBulkWriteRows(
      this,
      this.#primaryPath,
      this.#documents,
      documentWrites,
      context,
    )

    const {bulkInsertDocs, bulkUpdateDocs} = categorized

    for (const writeRow of bulkInsertDocs) {
      const doc = writeRow.document
      this.#documents.set(doc[this.#primaryPath], doc)
    }

    for (const writeRow of bulkUpdateDocs) {
      const doc = writeRow.document
      this.#documents.set(doc[this.#primaryPath], doc)
    }

    if (this.schema.attachments) {
      for (const attachment of categorized.attachmentsAdd) {
        await this.#io.writeAttachment(
          attachment.documentId,
          attachment.attachmentId,
          attachment.attachmentData.data,
        )
      }

      for (const attachment of categorized.attachmentsUpdate) {
        await this.#io.writeAttachment(
          attachment.documentId,
          attachment.attachmentId,
          attachment.attachmentData.data,
        )
      }

      for (const attachment of categorized.attachmentsRemove) {
        await this.#io.removeAttachment(
          attachment.documentId,
          attachment.attachmentId,
        )
      }
    }

    if (bulkInsertDocs.length > 0 || bulkUpdateDocs.length > 0) {
      await this.#io.save(this.#documents)
    }

    if (categorized.eventBulk.events.length > 0) {
      const lastState = categorized.newestRow.document
      categorized.eventBulk.checkpoint = {
        id: lastState[this.#primaryPath],
        lwt: lastState._meta.lwt,
      }
      this.#changes$.next(categorized.eventBulk)
    }

    return {error: categorized.errors}
  }

  findDocumentsById(ids, withDeleted) {
    const result = []
    for (const id of ids) {
      const doc = this.#documents.get(id)
      if (doc && (!doc._deleted || withDeleted)) {
        result.push(doc)
      }
    }

    return Promise.resolve(result)
  }

  query(preparedQuery) {
    const {query, queryPlan} = preparedQuery
    const skip = query.skip ?? 0
    const limit = query.limit ?? Number.POSITIVE_INFINITY
    const queryMatcher = queryPlan.selectorSatisfiedByIndex
      ? false
      : getQueryMatcher(this.schema, query)
    const sortComparator = getSortComparator(this.schema, query)

    let docs = [...this.#documents.values()]

    if (queryMatcher) {
      docs = docs.filter((doc) => queryMatcher(doc))
    }

    docs.sort(sortComparator)

    docs = docs.slice(skip, skip + limit)

    return Promise.resolve({documents: docs})
  }

  async count(preparedQuery) {
    const result = await this.query(preparedQuery)
    return {count: result.documents.length, mode: 'fast'}
  }

  async getAttachmentData(documentId, attachmentId, digest) {
    const doc = this.#documents.get(documentId)
    if (
      !doc ||
      !doc._attachments ||
      !doc._attachments[attachmentId] ||
      doc._attachments[attachmentId].digest !== digest
    ) {
      throw new Error(
        `attachment does not exist: ${documentId}||${attachmentId}`,
      )
    }

    return this.#io.readAttachment(documentId, attachmentId)
  }

  changeStream() {
    return this.#changes$.asObservable()
  }

  async cleanup(minimumDeletedTime) {
    const maxDeletionTime = Date.now() - minimumDeletedTime
    let changed = false
    for (const [id, doc] of this.#documents) {
      if (doc._deleted && doc._meta.lwt < maxDeletionTime) {
        if (doc._attachments) {
          for (const attachmentId of Object.keys(doc._attachments)) {
            await this.#io.removeAttachment(id, attachmentId)
          }
        }

        this.#documents.delete(id)
        changed = true
      }
    }

    if (changed) {
      await this.#io.save(this.#documents)
    }

    return true
  }

  async close() {
    if (this.closed) {
      return
    }

    this.closed = true
    this.#changes$.complete()
  }

  async remove() {
    for (const [id, doc] of this.#documents) {
      if (doc._attachments) {
        for (const attachmentId of Object.keys(doc._attachments)) {
          await this.#io.removeAttachment(id, attachmentId)
        }
      }
    }

    await this.#io.remove()
    this.#documents.clear()
    await this.close()
  }
}

class OPFSDirectoryIO {
  #databaseName
  #collectionName
  #fileName

  constructor(databaseName, collectionName) {
    this.#databaseName = databaseName
    this.#collectionName = collectionName
    this.#fileName = `${collectionName}.json`
  }

  #attachmentFileName(documentId, attachmentId) {
    return `${this.#collectionName}-att-${documentId}||${attachmentId}`
  }

  async #getDbDir() {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle(this.#databaseName, {create: true})
  }

  async load(documents) {
    try {
      const dbDir = await this.#getDbDir()
      const fileHandle = await dbDir.getFileHandle(this.#fileName, {
        create: false,
      })
      const file = await fileHandle.getFile()
      const text = await file.text()
      const data = JSON.parse(text)
      for (const [id, doc] of Object.entries(data)) {
        documents.set(id, doc)
      }
    } catch {
      // File doesn't exist yet — start with empty state
    }
  }

  async save(documents) {
    const dbDir = await this.#getDbDir()
    const fileHandle = await dbDir.getFileHandle(this.#fileName, {create: true})
    const writable = await fileHandle.createWritable()
    const data = Object.fromEntries(documents)
    await writable.write(JSON.stringify(data))
    await writable.close()
  }

  async writeAttachment(documentId, attachmentId, data) {
    const dbDir = await this.#getDbDir()
    const name = this.#attachmentFileName(documentId, attachmentId)
    const fileHandle = await dbDir.getFileHandle(name, {create: true})
    const writable = await fileHandle.createWritable()
    await writable.write(data)
    await writable.close()
  }

  async readAttachment(documentId, attachmentId) {
    const dbDir = await this.#getDbDir()
    const name = this.#attachmentFileName(documentId, attachmentId)
    const fileHandle = await dbDir.getFileHandle(name, {create: false})
    const file = await fileHandle.getFile()
    return file.text()
  }

  async removeAttachment(documentId, attachmentId) {
    try {
      const dbDir = await this.#getDbDir()
      const name = this.#attachmentFileName(documentId, attachmentId)
      await dbDir.removeEntry(name)
    } catch {
      // File may not exist
    }
  }

  async remove() {
    try {
      const root = await navigator.storage.getDirectory()
      const dbDir = await root.getDirectoryHandle(this.#databaseName, {
        create: false,
      })
      await dbDir.removeEntry(this.#fileName)
    } catch {
      // File may not exist
    }
  }
}

class DirectoryIO {
  #getDirectory
  #collectionName
  #fileName

  constructor(getDirectory, collectionName) {
    this.#getDirectory = getDirectory
    this.#collectionName = collectionName
    this.#fileName = `${collectionName}.json`
  }

  #attachmentFileName(documentId, attachmentId) {
    return `${this.#collectionName}-att-${documentId}||${attachmentId}`
  }

  async load(documents) {
    try {
      const dir = await this.#getDirectory()
      const fileHandle = await dir.getFileHandle(this.#fileName, {
        create: false,
      })
      const file = await fileHandle.getFile()
      const text = await file.text()
      const data = JSON.parse(text)
      for (const [id, doc] of Object.entries(data)) {
        documents.set(id, doc)
      }
    } catch {
      // File doesn't exist yet — start with empty state
    }
  }

  async save(documents) {
    const dir = await this.#getDirectory()
    const fileHandle = await dir.getFileHandle(this.#fileName, {create: true})
    const writable = await fileHandle.createWritable()
    const data = Object.fromEntries(documents)
    await writable.write(JSON.stringify(data))
    await writable.close()
  }

  async writeAttachment(documentId, attachmentId, data) {
    const dir = await this.#getDirectory()
    const name = this.#attachmentFileName(documentId, attachmentId)
    const fileHandle = await dir.getFileHandle(name, {create: true})
    const writable = await fileHandle.createWritable()
    await writable.write(data)
    await writable.close()
  }

  async readAttachment(documentId, attachmentId) {
    const dir = await this.#getDirectory()
    const name = this.#attachmentFileName(documentId, attachmentId)
    const fileHandle = await dir.getFileHandle(name, {create: false})
    const file = await fileHandle.getFile()
    return file.text()
  }

  async removeAttachment(documentId, attachmentId) {
    try {
      const dir = await this.#getDirectory()
      const name = this.#attachmentFileName(documentId, attachmentId)
      await dir.removeEntry(name)
    } catch {
      // File may not exist
    }
  }

  async remove() {
    try {
      const dir = await this.#getDirectory()
      await dir.removeEntry(this.#fileName)
    } catch {
      // File may not exist
    }
  }
}
