# passing-notes-rxdb
[![npm](https://img.shields.io/npm/v/passing-notes-rxdb.svg)](https://www.npmjs.com/package/passing-notes-rxdb)
[![CI Status](https://github.com/vinsonchuong/passing-notes-rxdb/workflows/CI/badge.svg)](https://github.com/vinsonchuong/passing-notes-rxdb/actions?query=workflow%3ACI)

An HTTP replication middleware for [RxDB](https://rxdb.info/) that persists to SQLite, for use with [passing-notes](https://github.com/vinsonchuong/passing-notes).

## Usage

Install by running:

```sh
yarn add passing-notes-rxdb better-sqlite3
```

Then compose it with other middleware:

```js
import {compose} from 'passing-notes'
import {serveRxdb} from 'passing-notes-rxdb'
import {Persistence} from 'passing-notes-rxdb/sqlite'

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

const persistence = new Persistence(':memory:', schemas)

export default compose(
  serveRxdb({persistence, path: '/data'}),
  () => () => ({status: 404}),
)
```

On the client:

```js
import {createRxDatabase} from 'rxdb'
import {getRxStorageMemory} from 'rxdb/plugins/storage-memory'
import {replicateCollection} from 'passing-notes-rxdb/client'

const db = await createRxDatabase({
  name: 'heroes',
  storage: getRxStorageMemory(),
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
  url: 'http://localhost:8080/data',
  EventSource,
})

await replicationState.awaitInitialReplication()
```

## OPFS Storage (Browser)

Store RxDB data locally in the browser using the [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) (OPFS). This enables fully offline-capable, persistent RxDB databases in the browser without relying on IndexedDB or any server.

Install by running:

```sh
yarn add passing-notes-rxdb
```

Then use it as the storage for an RxDB database:

```js
import {getRxStorageOPFS} from 'passing-notes-rxdb/opfs'
import {createRxDatabase} from 'rxdb'

const db = await createRxDatabase({
  name: 'mydb',
  storage: getRxStorageOPFS(),
})
```
