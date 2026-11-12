/**
 * 回滚：把某个快照的清单还原到 target。
 *
 * 安全策略（默认最保守）：
 *  1. 回滚前先对**当前状态**做一次 pre-restore 快照（可以再撤回）
 *  2. 默认只还原清单里列出的文件，不删除本地新增文件
 *  3. --delete-extras 才删除快照里不存在的文件（显式 opt-in）
 *  4. 每个文件先写临时文件再 rename，避免半截文件
 */
import {
  existsSync, mkdirSync, copyFileSync, renameSync, writeFileSync,
  readlinkSync, symlinkSync, unlinkSync, statSync, lstatSync, readdirSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { blobPath, toPosix } from './config.mjs'
import { readSnapshot, createSnapshot } from './snapshot.mjs'

/** 校验 hash 是否像 sha256（防止清单被篡改后写到奇怪路径）。 */
const HASH_RE = /^[0-9a-f]{64}$/

export async function restoreSnapshot({ cfg, dirs, id, options = {} }) {
  const {
    dryRun = false,
    deleteExtras = false,
    onlyTargets = null,
    noPreSnapshot = false,
    verify = true,
  } = options

  const snap = readSnapshot(dirs, id)

  // 1) 回滚前快照
  let preSnapshot = null
  if (!dryRun && !noPreSnapshot) {
    try {
      preSnapshot = await createSnapshot({
        cfg, dirs, kind: 'pre-restore', reason: `rollback to ${id}`,
      })
    } catch (e) {
      if (e.code === 'ELOCKED') throw new Error('另一个快照正在进行，稍后重试回滚')
      throw e
    }
  }

  const report = {
    id,
    restoredAt: new Date().toISOString(),
    dryRun,
    preSnapshot: preSnapshot?.id ?? null,
    targets: [],
  }

  for (const m of snap.manifests ?? []) {
    if (onlyTargets && !onlyTargets.includes(m.label)) continue
    const root = m.root
    const t = {
      label: m.label, root,
      written: 0, unchanged: 0, created: 0, dirs: 0, links: 0,
      deleted: 0, missingBlobs: [], errors: [], skipped: false,
    }

    // target 目录不存在 → 用快照重建它（这正是事故后要做到的）
    if (m.missing) {
      t.recoveredMissing = true
    }
    if (!dryRun && !existsSync(root)) {
      mkdirSync(root, { recursive: true })
    }

    // 2) 目录
    for (const d of m.dirs ?? []) {
      const abs = join(root, d)
      if (dryRun) { t.dirs++; continue }
      try { mkdirSync(abs, { recursive: true }); t.dirs++ } catch (e) { t.errors.push(`${d}: ${e.message}`) }
    }

    // 3) 文件
    const expect = new Set()
    for (const f of m.files ?? []) {
      const rel = toPosix(f.path)
      expect.add(rel)
      const abs = resolve(root, rel)
      if (!abs.startsWith(resolve(root))) { t.errors.push(`越界路径被拒绝: ${rel}`); continue }
      if (!HASH_RE.test(f.hash || '')) { t.errors.push(`非法 hash: ${rel}`); continue }
      const bp = blobPath(dirs, f.hash)
      if (!existsSync(bp)) { t.missingBlobs.push(rel); continue }

      let same = false
      try {
        const st = statSync(abs)
        same = st.size === f.size && st.isFile()
      } catch { /* not exists */ }
      if (same && f.unchangedGuard !== false) {
        // 尺寸相同也未必内容相同；这里不读全量，交给 --verify 选项
        t.unchanged++
        if (!dryRun) continue
        continue
      }

      t.created++
      if (dryRun) continue
      try {
        mkdirSync(dirname(abs), { recursive: true })
        const tmp = abs + '.restore-tmp-' + process.pid
        copyFileSync(bp, tmp)
        const st0 = statSync(tmp)
        if (st0.size !== f.size) { unlinkSync(tmp); throw new Error(`size mismatch ${st0.size} != ${f.size}`) }
        if (f.mode) { try { chmodBestEffort(tmp, f.mode) } catch { /* ignore */ } }
        renameSync(tmp, abs)
        t.written++
      } catch (e) {
        t.errors.push(`${rel}: ${e.message}`)
      }
    }

    // 4) 符号链接
    for (const l of m.links ?? []) {
      const abs = resolve(root, l.path)
      if (!abs.startsWith(resolve(root))) continue
      if (dryRun) { t.links++; continue }
      try {
        if (existsSync(abs)) {
          try { if (!lstatSync(abs).isSymbolicLink()) continue } catch { /* ignore */ }
          unlinkSync(abs)
        }
        mkdirSync(dirname(abs), { recursive: true })
        symlinkSync(l.target, abs, 'junction')
        t.links++
      } catch (e) { t.errors.push(`link ${l.path}: ${e.message}`) }
    }

    // 5) 可选：删除快照里没有的文件
    if (deleteExtras && existsSync(root)) {
      const extras = []
      walkExtras(root, '', extras)
      for (const rel of extras) {
        if (expect.has(rel)) continue
        if (dryRun) { t.deleted++; continue }
        try { unlinkSync(resolve(root, rel)); t.deleted++ } catch { /* ignore */ }
      }
    }

    report.targets.push(t)
  }

  // 6) 自动校验 + 自动修复（默认开启）：把"大小相同但内容不一致/损坏"的文件从 blob 覆盖回来
  if (verify) {
    report.verify = await verifyRestore({
      dirs, id, onlyTargets, fix: !dryRun, dryRun,
    })
  }

  return report
}

function walkExtras(root, rel, out) {
  const dir = rel ? join(root, rel) : root
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) { walkExtras(root, r, out); continue }
    if (e.isFile() || e.isSymbolicLink()) out.push(toPosix(r))
  }
}

function chmodBestEffort(p, mode) {
  // 动态导入避免顶层副作用
  import('node:fs').then(({ chmodSync }) => { try { chmodSync(p, mode) } catch { /* ignore */ } })
}

/**
 * 文件级校验：比对快照与当前磁盘内容（用于回滚后自检）。
 * fix=true 时，对不一致/缺失的文件从内容寻址 blob 自动覆盖修复。
 * dryRun=true 时只报告、不写盘。
 */
export async function verifyRestore({ dirs, id, onlyTargets = null, fix = false, dryRun = false }) {
  const { hashFile } = await import('./blob.mjs')
  const snap = readSnapshot(dirs, id)
  const out = {
    id, dryRun, checked: 0, matched: 0,
    mismatched: [], missing: [], repaired: [], failed: [],
  }
  for (const m of snap.manifests ?? []) {
    if (onlyTargets && !onlyTargets.includes(m.label)) continue
    const rootAbs = resolve(m.root)
    for (const f of m.files ?? []) {
      const rel = toPosix(f.path)
      const abs = resolve(m.root, rel)
      if (!abs.startsWith(rootAbs)) { out.failed.push(`${rel}: 越界路径`); continue }
      if (!HASH_RE.test(f.hash || '')) { out.failed.push(`${rel}: 非法 hash`); continue }
      out.checked++
      let cur = null
      try { cur = await hashFile(abs) } catch { cur = null }
      if (cur === f.hash) { out.matched++; continue }
      if (cur === null) out.missing.push(rel); else out.mismatched.push(rel)
      if (!fix || dryRun) continue

      // 修复：从 blob 覆盖（先写 tmp 再 rename，失败不留半截文件）
      const bp = blobPath(dirs, f.hash)
      if (!existsSync(bp)) { out.failed.push(`${rel}: blob 缺失`); continue }
      try {
        mkdirSync(dirname(abs), { recursive: true })
        const tmp = abs + '.repair-tmp-' + process.pid
        copyFileSync(bp, tmp)
        const st0 = statSync(tmp)
        if (typeof f.size === 'number' && st0.size !== f.size) {
          unlinkSync(tmp); throw new Error(`size mismatch ${st0.size} != ${f.size}`)
        }
        if (f.mode) { try { chmodBestEffort(tmp, f.mode) } catch { /* ignore */ } }
        renameSync(tmp, abs)
        out.repaired.push(rel)
      } catch (e) { out.failed.push(`${rel}: ${e.message}`) }
    }
  }
  return out
}
