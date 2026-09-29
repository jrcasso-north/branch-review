import { rename, writeFile } from 'node:fs/promises'

/** Rename is atomic, so a reader never observes a half-written file. */
export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}
