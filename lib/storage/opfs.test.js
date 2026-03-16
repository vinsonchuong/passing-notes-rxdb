import test from 'ava'
import {getRxStorageOPFS, prepareQuery} from './opfs.js'

const schema = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: {type: 'string', maxLength: 36},
    updatedAt: {type: 'number', minimum: 0, maximum: 1e15, multipleOf: 1},
    name: {type: 'string'},
    _deleted: {type: 'boolean'},
    _rev: {type: 'string', minLength: 1, maxLength: 100},
    _meta: {
      type: 'object',
      properties: {
        lwt: {type: 'number', minimum: 0, maximum: 1e15, multipleOf: 0.01},
      },
      additionalProperties: true,
      required: ['lwt'],
    },
  },
  required: ['id', '_deleted', '_rev', '_meta'],
  indexes: [['updatedAt', 'id']],
}

function createInMemoryDir() {
  const files = {}

  const dir = {
    async getFileHandle(name, opts = {}) {
      if (!files[name]) {
        if (!opts.create) {
          throw new Error(`File not found: ${name}`)
        }

        files[name] = {content: ''}
      }

      const file = files[name]

      return {
        async getFile() {
          return {
            async text() {
              return file.content
            },
          }
        },
        async createWritable() {
          let buf = ''
          return {
            async write(data) {
              buf += data
            },
            async close() {
              file.content = buf
            },
          }
        },
      }
    },
    async removeEntry(name) {
      delete files[name]
    },
  }

  return dir
}

async function createInstance(dir) {
  const storage = getRxStorageOPFS()
  return storage.createStorageInstance({
    databaseInstanceToken: 'test-token',
    databaseName: 'test-db',
    collectionName: 'heroes',
    schema,
    options: {},
    multiInstance: false,
    devMode: false,
    getDirectory: () => Promise.resolve(dir),
  })
}

function makeDoc(id, name, updatedAt = 1000) {
  return {
    id,
    name,
    updatedAt,
    _deleted: false,
    _rev: '1-abc',
    _meta: {lwt: updatedAt},
  }
}

test('bulkWrite and findDocumentsById', async (t) => {
  const dir = createInMemoryDir()
  const instance = await createInstance(dir)
  t.teardown(() => instance.close())

  const doc = makeDoc('1', 'Batman')
  const result = await instance.bulkWrite([{document: doc}], 'test')
  t.is(result.error.length, 0)

  const found = await instance.findDocumentsById(['1'], false)
  t.is(found.length, 1)
  t.is(found[0].name, 'Batman')
})

test('findDocumentsById excludes deleted docs when withDeleted=false', async (t) => {
  const dir = createInMemoryDir()
  const instance = await createInstance(dir)
  t.teardown(() => instance.close())

  const doc = {
    ...makeDoc('1', 'Batman'),
    _deleted: true,
  }
  await instance.bulkWrite([{document: doc}], 'test')

  const notFound = await instance.findDocumentsById(['1'], false)
  t.is(notFound.length, 0)

  const found = await instance.findDocumentsById(['1'], true)
  t.is(found.length, 1)
})

test('conflict detection', async (t) => {
  const dir = createInMemoryDir()
  const instance = await createInstance(dir)
  t.teardown(() => instance.close())

  const doc = makeDoc('1', 'Batman')
  await instance.bulkWrite([{document: doc}], 'test')

  // Write with wrong previous rev => conflict
  const updatedDoc = {
    ...doc,
    name: 'Superman',
    _rev: '2-xyz',
    _meta: {lwt: 2000},
  }
  const result = await instance.bulkWrite(
    [{document: updatedDoc, previous: {...doc, _rev: 'wrong-rev'}}],
    'test',
  )
  t.is(result.error.length, 1)
  t.is(result.error[0].status, 409)
})

test('query returns non-deleted documents', async (t) => {
  const dir = createInMemoryDir()
  const instance = await createInstance(dir)
  t.teardown(() => instance.close())

  await instance.bulkWrite(
    [
      {document: makeDoc('1', 'Batman', 1000)},
      {document: makeDoc('2', 'Wonder Woman', 2000)},
      {document: {...makeDoc('3', 'Deleted', 3000), _deleted: true}},
    ],
    'test',
  )

  const preparedQ = prepareQuery(schema, {
    selector: {_deleted: {$eq: false}},
    sort: [{id: 'asc'}],
  })
  const {documents} = await instance.query(preparedQ)
  t.is(documents.length, 2)
  t.is(documents[0].name, 'Batman')
  t.is(documents[1].name, 'Wonder Woman')
})

test('count returns number of matching documents', async (t) => {
  const dir = createInMemoryDir()
  const instance = await createInstance(dir)
  t.teardown(() => instance.close())

  await instance.bulkWrite(
    [
      {document: makeDoc('1', 'Batman', 1000)},
      {document: makeDoc('2', 'Wonder Woman', 2000)},
    ],
    'test',
  )

  const preparedQ = prepareQuery(schema, {
    selector: {_deleted: {$eq: false}},
    sort: [{id: 'asc'}],
  })
  const {count} = await instance.count(preparedQ)
  t.is(count, 2)
})

test('changeStream emits events on write', async (t) => {
  const dir = createInMemoryDir()
  const instance = await createInstance(dir)
  t.teardown(() => instance.close())

  const events = []
  const sub = instance.changeStream().subscribe((bulk) => {
    events.push(bulk)
  })
  t.teardown(() => sub.unsubscribe())

  await instance.bulkWrite([{document: makeDoc('1', 'Batman')}], 'test')

  t.is(events.length, 1)
  t.is(events[0].events[0].operation, 'INSERT')
})

test('cleanup removes soft-deleted documents older than minimumDeletedTime', async (t) => {
  const dir = createInMemoryDir()
  const instance = await createInstance(dir)
  t.teardown(() => instance.close())

  const oldDeletedDoc = {
    ...makeDoc('1', 'OldDeleted', 1000),
    _deleted: true,
    _meta: {lwt: 1000},
  }
  const recentDeletedDoc = {
    ...makeDoc('2', 'RecentDeleted', Date.now()),
    _deleted: true,
    _meta: {lwt: Date.now()},
  }
  const aliveDoc = makeDoc('3', 'Alive', 1000)

  await instance.bulkWrite(
    [
      {document: oldDeletedDoc},
      {document: recentDeletedDoc},
      {document: aliveDoc},
    ],
    'test',
  )

  // Minimum deleted time of 1 second; old doc was deleted at lwt=1000 which is way in the past
  await instance.cleanup(1000)

  const allDocs = await instance.findDocumentsById(['1', '2', '3'], true)
  t.is(allDocs.length, 2)
  t.truthy(allDocs.find((d) => d.id === '2'))
  t.truthy(allDocs.find((d) => d.id === '3'))
})

test('data persists between instances using the same directory', async (t) => {
  const dir = createInMemoryDir()

  const instance1 = await createInstance(dir)
  await instance1.bulkWrite([{document: makeDoc('1', 'Batman', 1000)}], 'test')
  await instance1.close()

  const instance2 = await createInstance(dir)
  t.teardown(() => instance2.close())

  const found = await instance2.findDocumentsById(['1'], false)
  t.is(found.length, 1)
  t.is(found[0].name, 'Batman')
})

test('remove deletes all data', async (t) => {
  const dir = createInMemoryDir()
  const instance = await createInstance(dir)

  await instance.bulkWrite([{document: makeDoc('1', 'Batman')}], 'test')
  await instance.remove()

  const instance2 = await createInstance(dir)
  t.teardown(() => instance2.close())

  const found = await instance2.findDocumentsById(['1'], false)
  t.is(found.length, 0)
})
