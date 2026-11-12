/** 内容哈希与 blob 写入（内容寻址，天然去重）。 */
import { createHash } from 'node:crypto'
import {
  createReadStream, existsSync, mkdirSync, renameSync, statSync,
  copyFileSync, writeFileSync, readFileSync, unlinkSync,
} from 'node:fs'
import { dirname } from 'node:path'

export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

export function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 确保 blob 存在（从源文件拷贝），返回 { isNew, bytes }。 */
export function putBlob(blobFile, sourcePath, bytes) {
  if (existsSync(blobFile)) return { isNew: false, bytes }
  mkdirSync(dirname(blobFile), { recursive: true })
  const tmp = blobFile + '.tmp-' + process.pid
  copyFileSync(sourcePath, tmp)
  renameSync(tmp, blobFile)
  return { isNew: true, bytes }
}

/** 转义：直接写 buffer（用于 restore 时的原子写入场景不需要，仅备份用）。 */
export function putBlobFromBuffer(blobFile, buf) {
  if (existsSync(blobFile)) return { isNew: false, bytes: buf.length }
  mkdirSync(dirname(blobFile), { recursive: true })
  const tmp = blobFile + '.tmp-' + process.pid
  writeFileSync(tmp, buf)
  renameSync(tmp, blobFile)
  return { isNew: true, bytes: buf.length }
}

export function readBlob(blobFile) {
  return readFileSync(blobFile)
}

export function blobSize(blobFile) {
  try { return statSync(blobFile).size } catch { return 0 }
}

export function rmIfExists(p) {
  try { if (existsSync(p)) unlinkSync(p) } catch { /* ignore */ }
}
