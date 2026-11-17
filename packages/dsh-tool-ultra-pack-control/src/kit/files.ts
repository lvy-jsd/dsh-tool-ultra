import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

/** Read a held regular-file descriptor; refuse symlinks, replacement and growth. */
export async function readTransfer(path: string, name: string, maxTransfer: number): Promise<Buffer> {
  // lstat also refuses links on platforms without O_NOFOLLOW (Windows).
  // Keep O_NOFOLLOW where available to reject a link substituted during open.
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${name} must be a regular file; symlinks are not allowed.`)
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const st = await file.stat()
    if (!st.isFile()) throw new Error(`${name} must be a regular file.`)
    // Compare the opened file with both path checks before reading any data.
    // This detects replacement during open when no atomic no-follow flag exists.
    const after = await lstat(path)
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== st.dev || before.ino !== st.ino || after.dev !== st.dev || after.ino !== st.ino) throw new Error(`${name} changed while opening; symlinks are not allowed.`)
    if (st.size > maxTransfer) throw new Error(`${name} is larger than ${maxTransfer} bytes.`)
    // Read through the held descriptor, bounded even if the source grows.
    const bytes = Buffer.alloc(Math.min(st.size + 1, maxTransfer + 1))
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxTransfer || length > st.size) throw new Error(`${name} grew while reading; retry.`)
    return bytes.subarray(0, length)
  } finally { await file.close() }
}
