/**
 * 快照写入 / 读取 / 清理。
 *
 * 落盘布局：
 *   <store>/blobs/ab/abcdef...           内容寻址（sha256），天然去重
 *   <store>/snapshots/<id>.json          清单（manifest）
 *   <store>/index.jsonl                  追加式索引（快速 list）
 */
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, appendFileSync, openSync, closeSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { scanTarget } from './scan.mjs'
import { putBlob, blobSize } from './blob.mjs'
import { blobPath } from './config.mjs'

export function newSnapshotId(date = new Date(), kind = 'auto') {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const ts = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  return `${ts}-${kind}`
}

/** 取锁（同进程互斥，跨进程用独占创建）。返回释放函数。 */
export function acquireLock(lockPath, staleMs = 10 * 60 * 1000) {
  try {
    const st = statSync(lockPath)
    if (Date.now() - st.mtimeMs > staleMs) unlinkSync(lockPath)
  } catch { /* not exists */ }
  try {
    const fd = openSync(lockPath, 'wx')
    writeSync(fd, String(process.pid))
    closeSync(fd)
  } catch {
    return null
  }
  return () => { try { unlinkSync(lockPath) } catch { /* ignore */ } }
}

/**
 * 创建一个快照。
 * @param {object} opts
 * @param {object} opts.cfg
 * @param {object} opts.dirs
 * @param {'auto'|'manual'|'pre-restore'} [opts.kind]
 * @param {string} [opts.reason]
 * @returns {Promise<object>} 快照元数据
 */
export async function createSnapshot({ cfg, dirs, kind = 'auto', reason = '' }) {
  const release = acquireLock(dirs.lock)
  if (!release) {
    const err = new Error('另一个快照正在进行（lock 被占用）')
    err.code = 'ELOCKED'
    throw err
  }
  try {
    const started = Date.now()
    const id = uniqueId(dirs, newSnapshotId(new Date(), kind))
    const manifests = []
    const seen = new Set()
    let newBlobs = 0
    let newBytes = 0
    let reusedBytes = 0
    let totalFiles = 0

    for (const target of cfg.targets) {
      const m = await scanTarget(target, cfg)
      manifests.push(m)
      for (const f of m.files) {
        totalFiles++
        if (seen.has(f.hash)) { reusedBytes += f.size; continue }
        seen.add(f.hash)
        const bp = blobPath(dirs, f.hash)
        const src = join(target.path, f.path)
        const r = putBlob(bp, src, f.size)
        if (r.isNew) { newBlobs++; newBytes += f.size } else reusedBytes += f.size
      }
    }

    const meta = {
      id,
      kind,
      reason,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      host: process.env.COMPUTERNAME || 'unknown',
      targets: manifests.map((m) => ({
        label: m.label,
        root: m.root,
        files: m.files.length,
        dirs: m.dirs.length,
        links: m.links.length,
        missing: m.missing.length > 0,
      })),
      totals: { files: totalFiles, newBlobs, newBytes, reusedBytes },
    }

    // 先写 manifest（原子），再写索引，最后落 meta
    const payload = { ...meta, manifests }
    const snapFile = join(dirs.snapshots, `${id}.json`)
    atomicWrite(snapFile, JSON.stringify(payload))
    appendFileSync(dirs.index, JSON.stringify(meta) + '\n', 'utf8')
    return meta
  } finally {
    release()
  }
}

function uniqueId(dirs, base) {
  let id = base
  let n = 1
  while (existsSync(join(dirs.snapshots, `${id}.json`))) id = `${base}-${++n}`
  return id
}

function atomicWrite(path, text) {
  const tmp = path + '.tmp-' + process.pid
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/** 读取快照元数据 + 清单。 */
export function readSnapshot(dirs, id) {
  const f = join(dirs.snapshots, `${id}.json`)
  if (!existsSync(f)) throw new Error(`快照不存在: ${id}`)
  return JSON.parse(readFileSync(f, 'utf8'))
}

/** 列出所有快照（按时间倒序）。以 manifest 文件为准，index.jsonl 仅用于快速摘要。 */
export function listSnapshots(dirs) {
  if (!existsSync(dirs.snapshots)) return []
  const out = []
  for (const name of readdirSync(dirs.snapshots)) {
    if (!name.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(join(dirs.snapshots, name), 'utf8'))
      out.push({
        id: j.id, kind: j.kind, reason: j.reason, createdAt: j.createdAt,
        durationMs: j.durationMs, targets: j.targets, totals: j.totals,
        file: join(dirs.snapshots, name),
      })
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return out
}

/** 存储占用统计。 */
export function storeStats(dirs) {
  let blobs = 0, blobBytes = 0
  const shardDirs = existsSync(dirs.blobs) ? readdirSync(dirs.blobs) : []
  for (const s of shardDirs) {
    const d = join(dirs.blobs, s)
    let st
    try { st = statSync(d) } catch { continue }
    if (!st.isDirectory()) continue
    for (const f of readdirSync(d)) {
      blobs++
      blobBytes += blobSize(join(d, f))
    }
  }
  const snaps = listSnapshots(dirs)
  return { blobs, blobBytes, snapshots: snaps.length, latest: snaps[0] ?? null }
}

/**
 * 按保留策略清理旧快照。
 * - auto：保留最近 keepAuto 个；另外每天至少留 1 个（keepDailyDays 天内）
 * - manual / pre-restore：保留 keepManualDays 天（0=永久）
 */
export function pruneSnapshots({ dirs, retention, dryRun = false }) {
  const snaps = listSnapshots(dirs)
  const keep = new Set()
  const dayKey = (iso) => iso.slice(0, 10)

  // 每天保留最新一个（限制在天数内）
  const seenDay = new Set()
  const dayLimit = retention.keepDailyDays > 0
    ? Date.now() - retention.keepDailyDays * 24 * 3600 * 1000
    : 0
  for (const s of snaps) {
    const t = Date.parse(s.createdAt)
    if (dayLimit && t < dayLimit) continue
    const dk = dayKey(s.createdAt)
    if (!seenDay.has(dk)) { seenDay.add(dk); keep.add(s.id) }
  }

  // auto 保留最近 N 个
  let n = 0
  for (const s of snaps) {
    if (s.kind !== 'auto') continue
    if (++n <= (retention.keepAuto ?? 48)) keep.add(s.id)
  }

  // 手动/回滚前快照
  const manualLimit = retention.keepManualDays > 0
    ? Date.now() - retention.keepManualDays * 24 * 3600 * 1000
    : 0
  for (const s of snaps) {
    if (s.kind === 'auto') continue
    if (!manualLimit || Date.parse(s.createdAt) >= manualLimit) keep.add(s.id)
  }

  const removed = []
  for (const s of snaps) {
    if (keep.has(s.id)) continue
    removed.push(s.id)
    if (!dryRun) {
      try { unlinkSync(s.file) } catch { /* ignore */ }
    }
  }
  if (!dryRun) gcBlobs(dirs)
  return { kept: [...keep], removed }
}

/** 删除没有任何快照引用的 blob。 */
export function gcBlobs(dirs) {
  const referenced = new Set()
  for (const s of listSnapshots(dirs)) {
    const j = JSON.parse(readFileSync(s.file, 'utf8'))
    for (const m of j.manifests ?? []) for (const f of m.files ?? []) referenced.add(f.hash)
  }
  let removed = 0, freed = 0
  if (!existsSync(dirs.blobs)) return { removed, freed }
  for (const shard of readdirSync(dirs.blobs)) {
    const d = join(dirs.blobs, shard)
    let st
    try { st = statSync(d) } catch { continue }
    if (!st.isDirectory()) continue
    for (const name of readdirSync(d)) {
      if (referenced.has(name)) continue
      try {
        const sz = blobSize(join(d, name))
        unlinkSync(join(d, name))
        removed++; freed += sz
      } catch { /* ignore */ }
    }
  }
  return { removed, freed }
}
