# passing-notes-rxdb
[![npm](https://img.shields.io/npm/v/passing-notes-rxdb.svg)](https://www.npmjs.com/package/passing-notes-rxdb)
[![CI Status](https://github.com/vinsonchuong/passing-notes-rxdb/workflows/CI/badge.svg)](https://github.com/vinsonchuong/passing-notes-rxdb/actions?query=workflow%3ACI)

An HTTP replication middleware for [RxDB](https://rxdb.info/) that persists to SQLite, for use with [passing-notes](https://github.com/vinsonchuong/passing-notes).

## Usage

Install by running:

```sh
yarn add passing-notes-rxdb
```

Then compose it with other middleware:

```js
import {compose} from 'passing-notes'
import {serveRxdb} from 'passing-notes-rxdb'

export default compose(
  serveRxdb({
    dbPath: './data.db',
    collections: ['heroes', 'items'],
  }),
  () => () => ({status: 404}),
)
```

On the client side, use RxDB's HTTP replication plugin pointing at the server:

```js
import {replicateRxCollection} from 'rxdb/plugins/replication-http'

replicateRxCollection({
  collection: myCollection,
  replicationIdentifier: 'my-http-replication',
  pull: {
    handler: async (lastCheckpoint, batchSize) => {
      const {id = '', updatedAt = 0} = lastCheckpoint ?? {}
      const res = await fetch(
        `/heroes/pull?id=${id}&updatedAt=${updatedAt}&limit=${batchSize}`,
      )
      return res.json()
    },
    stream$: /* EventSource pointing at /heroes/pullStream */, 
  },
  push: {
    handler: async (rows) => {
      const res = await fetch('/heroes/push', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(rows),
      })
      return res.json()
    },
  },
})
```

## API

### `serveRxdb({ dbPath, collections })`

Returns a passing-notes middleware.

- `dbPath` — Path to the SQLite database file. Use `':memory:'` for an in-memory database (useful for tests).
- `collections` — Array of collection name strings. A SQLite table is created for each on startup.

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/:collection/pull` | Pull documents since a checkpoint |
| `POST` | `/:collection/push` | Push new document states, returns conflicts |
| `GET` | `/:collection/pullStream` | SSE stream of live updates |