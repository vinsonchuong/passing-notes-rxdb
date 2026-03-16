import test from 'ava'
import {compose, startServer, stopServer, sendRequest} from 'passing-notes'
import {createRxDatabase} from 'rxdb'
import {getRxStorageMemory} from 'rxdb/plugins/storage-memory'
import {EventSource} from 'eventsource'
import {Persistence} from './lib/persistence/sqlite.js'
import {replicateCollection} from './lib/client.js'
import {serveRxdb} from './index.js'

const schemas = {
  heroes: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: {
        id: {type: 'string', maxLength: 36},
        updatedAt: {type: 'integer'},
        name: {type: 'string'},
      },
    },
  },
}

test('push and pull documents', async (t) => {
  const persistence = new Persistence(':memory:', schemas)
  t.teardown(() => {
    persistence.dispose()
  })

  const server = await startServer(
    {port: 10_200},
    compose(serveRxdb({persistence}), () => () => ({
      status: 404,
    })),
  )
  t.teardown(() => stopServer(server))

  const pushResponse = await sendRequest({
    method: 'POST',
    url: 'http://localhost:10200/heroes',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify([
      {
        assumedMasterState: null,
        newDocumentState: {
          id: 'h1',
          updatedAt: 1,
          _deleted: false,
          name: 'Superman',
        },
      },
    ]),
  })
  t.is(pushResponse.status, 200)
  t.deepEqual(JSON.parse(pushResponse.body), [])

  const pullResponse = await sendRequest({
    method: 'GET',
    url: 'http://localhost:10200/heroes?id=&updatedAt=0&limit=10',
    headers: {},
    body: '',
  })
  t.is(pullResponse.status, 200)
  const {documents, checkpoint} = JSON.parse(pullResponse.body)
  t.is(documents.length, 1)
  t.is(documents[0].id, 'h1')
  t.is(documents[0].name, 'Superman')
  t.deepEqual(checkpoint, {id: 'h1', updatedAt: 1})
})

test('conflict detection on push', async (t) => {
  const persistence = new Persistence(':memory:', schemas)
  t.teardown(() => {
    persistence.dispose()
  })

  const server = await startServer(
    {port: 10_201},
    compose(serveRxdb({persistence}), () => () => ({
      status: 404,
    })),
  )
  t.teardown(() => stopServer(server))

  await sendRequest({
    method: 'POST',
    url: 'http://localhost:10201/heroes',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify([
      {
        assumedMasterState: null,
        newDocumentState: {
          id: 'h2',
          updatedAt: 1,
          _deleted: false,
          name: 'Batman',
        },
      },
    ]),
  })

  const conflictResponse = await sendRequest({
    method: 'POST',
    url: 'http://localhost:10201/heroes',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify([
      {
        assumedMasterState: null,
        newDocumentState: {
          id: 'h2',
          updatedAt: 2,
          _deleted: false,
          name: 'Bruce Wayne',
        },
      },
    ]),
  })
  t.is(conflictResponse.status, 200)
  const conflicts = JSON.parse(conflictResponse.body)
  t.is(conflicts.length, 1)
  t.is(conflicts[0].id, 'h2')
  t.is(conflicts[0].name, 'Batman')
})

test('pullStream receives live updates via SSE', async (t) => {
  const persistence = new Persistence(':memory:', schemas)
  t.teardown(() => {
    persistence.dispose()
  })

  const server = await startServer(
    {port: 10_202},
    compose(serveRxdb({persistence}), () => () => ({
      status: 404,
    })),
  )
  t.teardown(() => stopServer(server))

  const streamResponse = await sendRequest({
    method: 'GET',
    url: 'http://localhost:10202/heroes',
    headers: {accept: 'text/event-stream'},
    body: '',
  })
  t.is(streamResponse.status, 200)

  const reader = streamResponse.body.getReader()
  const decoder = new TextDecoder()

  const {value: firstChunk} = await reader.read()
  t.true(decoder.decode(firstChunk).includes('documents'))

  await sendRequest({
    method: 'POST',
    url: 'http://localhost:10202/heroes',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify([
      {
        assumedMasterState: null,
        newDocumentState: {
          id: 'h3',
          updatedAt: 1,
          _deleted: false,
          name: 'Wonder Woman',
        },
      },
    ]),
  })

  const {value: secondChunk} = await reader.read()
  t.true(decoder.decode(secondChunk).includes('h3'))

  await reader.cancel()
})

test('providing a base URL path', async (t) => {
  const persistence = new Persistence(':memory:', schemas)
  t.teardown(() => {
    persistence.dispose()
  })

  const server = await startServer(
    {port: 10_204},
    compose(serveRxdb({persistence, path: '/data'}), () => () => ({
      status: 404,
    })),
  )
  t.teardown(() => stopServer(server))

  const pushResponse = await sendRequest({
    method: 'POST',
    url: 'http://localhost:10204/data/heroes',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify([
      {
        assumedMasterState: null,
        newDocumentState: {
          id: 'h1',
          updatedAt: 1,
          _deleted: false,
          name: 'Superman',
        },
      },
    ]),
  })
  t.is(pushResponse.status, 200)
  t.deepEqual(JSON.parse(pushResponse.body), [])

  const pullResponse = await sendRequest({
    method: 'GET',
    url: 'http://localhost:10204/data/heroes?id=&updatedAt=0&limit=10',
    headers: {},
    body: '',
  })
  t.is(pullResponse.status, 200)
  const {documents, checkpoint} = JSON.parse(pullResponse.body)
  t.is(documents.length, 1)
  t.is(documents[0].id, 'h1')
  t.is(documents[0].name, 'Superman')
  t.deepEqual(checkpoint, {id: 'h1', updatedAt: 1})
})

test('syncing with real clients', async (t) => {
  const persistence = new Persistence(':memory:', schemas)
  t.teardown(() => {
    persistence.dispose()
  })

  const server = await startServer(
    {port: 10_203},
    compose(serveRxdb({persistence}), () => () => ({
      status: 404,
    })),
  )
  t.teardown(() => stopServer(server))

  let count = 0
  async function makeClient() {
    const instance = count++

    const db = await createRxDatabase({
      name: `heroes-${instance}`,
      storage: getRxStorageMemory(),
    })
    t.teardown(() => {
      db.close()
    })

    await db.addCollections({
      heroes: {
        schema: {
          version: 0,
          primaryKey: 'id',
          type: 'object',
          properties: {
            id: {type: 'string', maxLength: 36},
            updatedAt: {type: 'integer'},
            name: {type: 'string'},
          },
        },
      },
    })

    const replicationState = replicateCollection({
      collection: db.heroes,
      replicationIdentifier: 'heroes',
      url: 'http://localhost:10203',
      EventSource,
    })

    await replicationState.awaitInitialReplication()

    return {db, replicationState}
  }

  const {db: db1} = await makeClient()
  const {db: db2} = await makeClient()

  await db1.heroes.insert({
    id: crypto.randomUUID(),
    updatedAt: Date.now(),
    name: 'Batman',
  })

  await db1.heroes.insert({
    id: crypto.randomUUID(),
    updatedAt: Date.now(),
    name: 'Wonder Woman',
  })

  const docs = await new Promise((resolve) => {
    db2.heroes.find().$.subscribe((docs) => {
      if (docs.length === 2) {
        resolve(docs)
      }
    })
  })

  t.is(docs.length, 2)
  t.truthy(docs.find((d) => d.name === 'Wonder Woman'))
  t.truthy(docs.find((d) => d.name === 'Batman'))
})
