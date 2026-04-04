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
import path from 'node:path'
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
      attachments: {}
    },
  },
}

const persistence = new Persistence(
':memory:',
  path.resolve('attachments'),
  schemas
)

export default compose(
  serveRxdb({persistence, path: '/data'}),
  () => () => ({status: 404}),
)
```

On the client:

```js
import {createRxDatabase, addRxPlugin} from 'rxdb'
import {RxDBAttachmentsPlugin} from 'rxdb/plugins/attachments'
import {getRxStorageMemory} from 'rxdb/plugins/storage-memory'
import {replicateCollection} from 'passing-notes-rxdb/client'

addRxPlugin(RxDBAttachmentsPlugin)

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
      attachments: {}
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
