import test from 'ava'
import {compose, startServer, stopServer, sendRequest} from 'passing-notes'
import {serveRxdb} from './index.js'

test('push and pull documents', async (t) => {
  const server = await startServer(
    {port: 10_200},
    compose(
      serveRxdb({dbPath: ':memory:', collections: ['heroes']}),
      () => () => ({status: 404}),
    ),
  )
  t.teardown(() => stopServer(server))

  const pushResponse = await sendRequest({
    method: 'POST',
    url: 'http://localhost:10200/heroes/push',
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
    url: 'http://localhost:10200/heroes/pull?id=&updatedAt=0&limit=10',
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
  const server = await startServer(
    {port: 10_201},
    compose(
      serveRxdb({dbPath: ':memory:', collections: ['heroes']}),
      () => () => ({status: 404}),
    ),
  )
  t.teardown(() => stopServer(server))

  await sendRequest({
    method: 'POST',
    url: 'http://localhost:10201/heroes/push',
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
    url: 'http://localhost:10201/heroes/push',
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
  const server = await startServer(
    {port: 10_202},
    compose(
      serveRxdb({dbPath: ':memory:', collections: ['heroes']}),
      () => () => ({status: 404}),
    ),
  )
  t.teardown(() => stopServer(server))

  const streamResponse = await sendRequest({
    method: 'GET',
    url: 'http://localhost:10202/heroes/pullStream',
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
    url: 'http://localhost:10202/heroes/push',
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
