import test from 'ava'
import {Persistence} from './sqlite.js'

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

test('serving as the backing store for RxDatabase instances', async (t) => {
  const persistence = new Persistence(':memory:', schemas)
  t.teardown(() => {
    persistence.dispose()
  })

  const db1 = await persistence.createRxDatabase()

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

  const db2 = await persistence.createRxDatabase()

  {
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
  }

  await db2.heroes.insert({
    id: crypto.randomUUID(),
    updatedAt: Date.now(),
    name: 'Superman',
  })

  {
    const docs = await new Promise((resolve) => {
      db1.heroes.find().$.subscribe((docs) => {
        if (docs.length === 3) {
          resolve(docs)
        }
      })
    })

    t.is(docs.length, 3)
    t.truthy(docs.find((d) => d.name === 'Wonder Woman'))
    t.truthy(docs.find((d) => d.name === 'Batman'))
    t.truthy(docs.find((d) => d.name === 'Superman'))
  }
})
