import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'ava'
import {createBlob} from 'rxdb'
import {useTmpDir} from '../../test-lib/tmp.js'
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
      attachments: {},
    },
  },
}

test('serving as the backing store for RxDatabase instances', async (t) => {
  const tmpDir = useTmpDir(t)

  const persistence = new Persistence(':memory:', tmpDir, schemas)
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

  {
    const db1Batman = await db1.heroes
      .findOne({selector: {name: 'Batman'}})
      .exec()

    const db2Updated = new Promise((resolve) => {
      db2.heroes.$.subscribe((event) => {
        const newDoc = event.documentData
        if (newDoc && 'doc.txt' in newDoc._attachments) {
          resolve()
        }
      })
    })

    await db1Batman.putAttachment({
      id: 'doc.txt',
      type: 'text/plain',
      data: createBlob('contents', 'text/plain'),
    })

    await db2Updated

    const db2Batman = await db2.heroes
      .findOne({selector: {name: 'Batman'}})
      .exec()
    const attachment = await db2Batman.getAttachment('doc.txt')
    const blob = await attachment.getData()
    t.is(await blob.text(), 'contents')

    const storedData = await fs.readFile(
      path.join(tmpDir, 'heroes', db1Batman.id, 'doc-txt'),
      'utf8',
    )
    t.is(storedData, 'contents')
  }

  const db3 = await persistence.createRxDatabase()

  {
    // Test pulling a doc that has an attachment
    const db3Batman = await new Promise((resolve) => {
      db3.heroes.find().$.subscribe((docs) => {
        if (docs.length === 3) {
          resolve(docs.find((doc) => doc.name === 'Batman'))
        }
      })
    })

    const attachment = await db3Batman.getAttachment('doc.txt')
    const blob = await attachment.getData()
    t.is(await blob.text(), 'contents')

    // Test pushing a doc with an attachment
    // Attachment data is not pushed and should not result in a conflict
    await db3Batman.patch({name: 'The Batman'})

    const db2Batman = await new Promise((resolve) => {
      db2.heroes
        .findOne({selector: {name: 'The Batman'}})
        .$.subscribe((doc) => {
          if (doc) {
            resolve(doc)
          }
        })
    })

    t.is(db2Batman.name, 'The Batman')
    {
      const attachment = await db2Batman.getAttachment('doc.txt')
      const blob = await attachment.getData()
      t.is(await blob.text(), 'contents')
    }
  }
})
