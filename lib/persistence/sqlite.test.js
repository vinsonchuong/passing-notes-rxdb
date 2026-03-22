import {Buffer} from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

const schemasWithAttachments = {
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

test('storing attachments on the filesystem when pushing documents', async (t) => {
  const attachmentsDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'rxdb-attachments-'),
  )
  t.teardown(() => fs.rm(attachmentsDir, {recursive: true, force: true}))

  const persistence = new Persistence(':memory:', schemasWithAttachments, {
    attachmentsDir,
  })
  t.teardown(() => {
    persistence.dispose()
  })

  const docId = 'hero-1'
  const attachmentData = Buffer.from('hello world').toString('base64')

  await persistence.push('heroes', [
    {
      assumedMasterState: null,
      newDocumentState: {
        id: docId,
        updatedAt: 1,
        _deleted: false,
        name: 'Batman',
        _attachments: {
          'bio.txt': {
            data: attachmentData,
            length: 11,
            type: 'text/plain',
            digest: 'sha256-abc123',
          },
        },
      },
    },
  ])

  const storedData = await fs.readFile(
    path.join(attachmentsDir, 'heroes', docId, 'bio_txt'),
    'utf8',
  )
  t.is(storedData, attachmentData)
})

test('including attachment data when pulling documents', async (t) => {
  const attachmentsDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'rxdb-attachments-'),
  )
  t.teardown(() => fs.rm(attachmentsDir, {recursive: true, force: true}))

  const persistence = new Persistence(':memory:', schemasWithAttachments, {
    attachmentsDir,
  })
  t.teardown(() => {
    persistence.dispose()
  })

  const docId = 'hero-2'
  const attachmentData = Buffer.from('cape details').toString('base64')

  await persistence.push('heroes', [
    {
      assumedMasterState: null,
      newDocumentState: {
        id: docId,
        updatedAt: 1,
        _deleted: false,
        name: 'Superman',
        _attachments: {
          'cape.txt': {
            data: attachmentData,
            length: 12,
            type: 'text/plain',
            digest: 'sha256-def456',
          },
        },
      },
    },
  ])

  const {documents} = await persistence.pull('heroes', {
    updatedAt: 0,
    id: '',
    pageSize: 10,
  })

  t.is(documents.length, 1)
  t.is(documents[0]._attachments['cape.txt'].data, attachmentData)
  t.is(documents[0]._attachments['cape.txt'].type, 'text/plain')
})

test('sanitizing document and attachment IDs to prevent path traversal', async (t) => {
  const attachmentsDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'rxdb-attachments-'),
  )
  t.teardown(() => fs.rm(attachmentsDir, {recursive: true, force: true}))

  const persistence = new Persistence(':memory:', schemasWithAttachments, {
    attachmentsDir,
  })
  t.teardown(() => {
    persistence.dispose()
  })

  const maliciousDocId = '../../../etc/passwd'
  const maliciousAttachmentId = '../../secrets/key'
  const attachmentData = Buffer.from('data').toString('base64')

  await persistence.push('heroes', [
    {
      assumedMasterState: null,
      newDocumentState: {
        id: maliciousDocId,
        updatedAt: 1,
        _deleted: false,
        name: 'Villain',
        _attachments: {
          [maliciousAttachmentId]: {
            data: attachmentData,
            length: 4,
            type: 'text/plain',
            digest: 'sha256-xyz',
          },
        },
      },
    },
  ])

  const safeDocId = '_________etc_passwd'
  const safeAttachmentId = '______secrets_key'
  const storedData = await fs.readFile(
    path.join(attachmentsDir, 'heroes', safeDocId, safeAttachmentId),
    'utf8',
  )
  t.is(storedData, attachmentData)
})

test('not storing attachment data in SQLite (only stubs)', async (t) => {
  const attachmentsDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'rxdb-attachments-'),
  )
  t.teardown(() => fs.rm(attachmentsDir, {recursive: true, force: true}))

  const persistence = new Persistence(':memory:', schemasWithAttachments, {
    attachmentsDir,
  })
  t.teardown(() => {
    persistence.dispose()
  })

  const docId = 'hero-3'
  const attachmentData = Buffer.from('large binary content').toString('base64')

  await persistence.push('heroes', [
    {
      assumedMasterState: null,
      newDocumentState: {
        id: docId,
        updatedAt: 1,
        _deleted: false,
        name: 'Flash',
        _attachments: {
          'profile.txt': {
            data: attachmentData,
            length: 20,
            type: 'text/plain',
            digest: 'sha256-ghi789',
          },
        },
      },
    },
  ])

  // Push again – conflict detection must work (stubs match, not full data)
  const conflicts = await persistence.push('heroes', [
    {
      assumedMasterState: {
        id: docId,
        updatedAt: 1,
        _deleted: false,
        name: 'Flash',
        _attachments: {
          'profile.txt': {
            length: 20,
            type: 'text/plain',
            digest: 'sha256-ghi789',
          },
        },
      },
      newDocumentState: {
        id: docId,
        updatedAt: 2,
        _deleted: false,
        name: 'The Flash',
        _attachments: {
          'profile.txt': {
            length: 20,
            type: 'text/plain',
            digest: 'sha256-ghi789',
          },
        },
      },
    },
  ])

  t.deepEqual(conflicts, [])
})
