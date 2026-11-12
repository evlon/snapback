/**
 * 扫描 target → 生成清单（manifest）。
 * manifest = { label, root, truncate(bool), files: [{ path, hash, size, mode }] }
 * path 为相对 root 的 posix 路径。
 */
import { readdirSync, lstatSync, readlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { hashFile } from './blob.mjs'
import { makeExcluder, toPosix } from './config.mjs'

/**
 * @param {{ label:string, path:string }} target
 * @param {object} cfg - 已加载配置
 * @param {(info:{label:string,path:string,added:number,bytes:number})=>void} [onProgress]
 */
export async function scanTarget(target, cfg, onProgress) {
  const excluded = makeExcluder(cfg.excludes)
  const files = []
  const dirs = []
  const links = []
  const missing = []

  if (!lstatExists(target.path)) {
    missing.push(target.label)
    return { label: target.label, root: target.path, files, dirs, links, missing }
  }

  await walk(target.path)

  async function walk(dir) {
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    // 目录本身也记下来（空目录才能在恢复时还原）
    dirs.push(toPosix(relative(target.path, dir)))
    for (const e of ents) {
      const full = join(dir, e.name)
      const rel = toPosix(relative(target.path, full))
      if (excluded(rel)) continue
      let st
      try { st = lstatSync(full) } catch { continue }

      if (st.isSymbolicLink()) {
        links.push({ path: rel, target: readlinkSync(full) })
        continue
      }
      if (st.isDirectory()) { await walk(full); continue }
      if (!st.isFile()) continue
      if (st.size > cfg.maxFileBytes) continue

      let hash
      try { hash = await hashFile(full) } catch { continue }
      files.push({ path: rel, hash, size: st.size, mode: st.mode & 0o777 })
      if (onProgress) onProgress({ label: target.label, path: rel, size: st.size })
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  dirs.sort()
  return { label: target.label, root: target.path, files, dirs, links, missing }
}

function lstatExists(p) {
  try { lstatSync(p); return true } catch { return false }
}
