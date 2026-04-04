import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function useTmpDir(t) {
  const dir = path.join(os.tmpdir(), `test-${crypto.randomUUID()}`)
  t.teardown(() => {
    fs.rm(dir, {recursive: true, force: true})
  })
  return dir
}
