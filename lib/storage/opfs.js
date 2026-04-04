import {Subject} from 'rxjs'
import {
  categorizeBulkWriteRows,
  getQueryMatcher,
  getSortComparator,
  getPrimaryFieldOfPrimaryKey,
  prepareQuery as rxdbPrepareQuery,
} from 'rxdb'

function attachmentMapKey(documentId, attachmentId) {
  return `${documentId}||${attachmentId}`
}

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
  const attachments = new Map()
  const changes$ = new Subject()

  const io = getDirectory
    ? new DirectoryIO(getDirectory, collectionName)
    : new OPFSDirectoryIO(databaseName, collectionName)

  await io.load(documents)
  await io.loadAttachments(attachments)

  return new RxStorageInstanceOPFS({
    params,
    primaryPath,
    documents,
    attachments,
    changes$,
    io,
  })
}

class RxStorageInstanceOPFS {
  #primaryPath
  #documents
  #attachments
  #changes$
  #io
  closed = false
  schema
  databaseName
  collectionName

  constructor({params, primaryPath, documents, attachments, changes$, io}) {
    this.schema = params.schema
    this.databaseName = params.databaseName
    this.collectionName = params.collectionName
    this.#primaryPath = primaryPath
    this.#documents = documents
    this.#attachments = attachments
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

    let attachmentsChanged = false
    if (this.schema.attachments) {
      for (const attachment of categorized.attachmentsAdd) {
        this.#attachments.set(
          attachmentMapKey(attachment.documentId, attachment.attachmentId),
          {writeData: attachment.attachmentData, digest: attachment.digest},
        )
        attachmentsChanged = true
      }

      for (const attachment of categorized.attachmentsUpdate) {
        this.#attachments.set(
          attachmentMapKey(attachment.documentId, attachment.attachmentId),
          {writeData: attachment.attachmentData, digest: attachment.digest},
        )
        attachmentsChanged = true
      }

      for (const attachment of categorized.attachmentsRemove) {
        this.#attachments.delete(
          attachmentMapKey(attachment.documentId, attachment.attachmentId),
        )
        attachmentsChanged = true
      }
    }

    if (bulkInsertDocs.length > 0 || bulkUpdateDocs.length > 0) {
      await this.#io.save(this.#documents)
    }

    if (attachmentsChanged) {
      await this.#io.saveAttachments(this.#attachments)
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

  getAttachmentData(documentId, attachmentId, digest) {
    const key = attachmentMapKey(documentId, attachmentId)
    const attachment = this.#attachments.get(key)
    if (!attachment || !digest || attachment.digest !== digest) {
      throw new Error(`attachment does not exist: ${key}`)
    }

    return Promise.resolve(attachment.writeData.data)
  }

  changeStream() {
    return this.#changes$.asObservable()
  }

  async cleanup(minimumDeletedTime) {
    const maxDeletionTime = Date.now() - minimumDeletedTime
    let changed = false
    for (const [id, doc] of this.#documents) {
      if (doc._deleted && doc._meta.lwt < maxDeletionTime) {
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
    await this.#io.remove()
    this.#documents.clear()
    this.#attachments.clear()
    await this.close()
  }
}

class OPFSDirectoryIO {
  #databaseName
  #fileName
  #attachmentsFileName

  constructor(databaseName, collectionName) {
    this.#databaseName = databaseName
    this.#fileName = `${collectionName}.json`
    this.#attachmentsFileName = `${collectionName}-attachments.json`
  }

  async #getFileHandle(name, create = false) {
    const root = await navigator.storage.getDirectory()
    const dbDir = await root.getDirectoryHandle(this.#databaseName, {
      create: true,
    })
    return dbDir.getFileHandle(name, {create})
  }

  async load(documents) {
    try {
      const fileHandle = await this.#getFileHandle(this.#fileName, false)
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
    const fileHandle = await this.#getFileHandle(this.#fileName, true)
    const writable = await fileHandle.createWritable()
    const data = Object.fromEntries(documents)
    await writable.write(JSON.stringify(data))
    await writable.close()
  }

  async loadAttachments(attachments) {
    try {
      const fileHandle = await this.#getFileHandle(
        this.#attachmentsFileName,
        false,
      )
      const file = await fileHandle.getFile()
      const text = await file.text()
      const data = JSON.parse(text)
      for (const [key, value] of Object.entries(data)) {
        attachments.set(key, value)
      }
    } catch {
      // File doesn't exist yet — start with empty state
    }
  }

  async saveAttachments(attachments) {
    const fileHandle = await this.#getFileHandle(
      this.#attachmentsFileName,
      true,
    )
    const writable = await fileHandle.createWritable()
    const data = Object.fromEntries(attachments)
    await writable.write(JSON.stringify(data))
    await writable.close()
  }

  async remove() {
    try {
      const root = await navigator.storage.getDirectory()
      const dbDir = await root.getDirectoryHandle(this.#databaseName, {
        create: false,
      })
      await dbDir.removeEntry(this.#fileName)
      await dbDir.removeEntry(this.#attachmentsFileName)
    } catch {
      // Files may not exist
    }
  }
}

class DirectoryIO {
  #getDirectory
  #fileName
  #attachmentsFileName

  constructor(getDirectory, collectionName) {
    this.#getDirectory = getDirectory
    this.#fileName = `${collectionName}.json`
    this.#attachmentsFileName = `${collectionName}-attachments.json`
  }

  async #getFileHandle(name, create = false) {
    const dir = await this.#getDirectory()
    return dir.getFileHandle(name, {create})
  }

  async load(documents) {
    try {
      const fileHandle = await this.#getFileHandle(this.#fileName, false)
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
    const fileHandle = await this.#getFileHandle(this.#fileName, true)
    const writable = await fileHandle.createWritable()
    const data = Object.fromEntries(documents)
    await writable.write(JSON.stringify(data))
    await writable.close()
  }

  async loadAttachments(attachments) {
    try {
      const fileHandle = await this.#getFileHandle(
        this.#attachmentsFileName,
        false,
      )
      const file = await fileHandle.getFile()
      const text = await file.text()
      const data = JSON.parse(text)
      for (const [key, value] of Object.entries(data)) {
        attachments.set(key, value)
      }
    } catch {
      // File doesn't exist yet — start with empty state
    }
  }

  async saveAttachments(attachments) {
    const fileHandle = await this.#getFileHandle(
      this.#attachmentsFileName,
      true,
    )
    const writable = await fileHandle.createWritable()
    const data = Object.fromEntries(attachments)
    await writable.write(JSON.stringify(data))
    await writable.close()
  }

  async remove() {
    try {
      const dir = await this.#getDirectory()
      await dir.removeEntry(this.#fileName)
      await dir.removeEntry(this.#attachmentsFileName)
    } catch {
      // Files may not exist
    }
  }
}
