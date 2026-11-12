/**
 * snapback — 配置与存储布局
 *
 * 关键设计：存储根目录**不在** ~/.dsh 里面，也不在用户目录里。
 * 上次事故是 `Remove-Item C:\Users\niukl -Recurse`，任何放在用户目录下的备份都会被一起删掉。
 */
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

/** 默认存储根：放在 E: 盘（与 C: 的 profile 不同盘），可用 SNAPBACK_STORE（旧 DSH_UNDO_STORE 兼容）覆盖。 */
export function defaultStoreRoot() {
  return process.env.SNAPBACK_STORE || process.env.DSH_UNDO_STORE || 'E:\\dsh-undo-store'
}

export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.pnpm/**',
  '**/cache/**',
  '**/.cache/**',
  '**/tmp/**',
  '**/*.log',
  '**/*.tmp',
]

export function defaultConfig() {
  return {
    version: 1,
    storeRoot: defaultStoreRoot(),
    targets: [
      // 一个 target = 一个快照根；label 会作为清单里的路径前缀
      { label: 'dsh-home', path: join(homedir(), '.dsh') },
    ],
    excludes: [...DEFAULT_EXCLUDES],
    maxFileBytes: 128 * 1024 * 1024,
    retention: {
      keepAuto: 48,        // 自动快照保留最近 N 个
      keepDailyDays: 14,   // 另外每天至少保留 1 个，保留 N 天
      keepManualDays: 0,   // 0 = 手动快照永久保留
    },
    watch: {
      debounceMs: 4000,    // 变更后静默多久再快照
      intervalSec: 600,    // 兜底周期性快照（哪怕没检测到变更）
      settleMs: 1500,      // 快照前等待写入稳定
    },
  }
}

export function storeDirs(storeRoot) {
  return {
    root: storeRoot,
    blobs: join(storeRoot, 'blobs'),
    snapshots: join(storeRoot, 'snapshots'),
    logs: join(storeRoot, 'logs'),
    config: join(storeRoot, 'config.json'),
    index: join(storeRoot, 'index.jsonl'),
    lock: join(storeRoot, 'snapshot.lock'),
  }
}

export function loadConfig(storeRoot = defaultStoreRoot()) {
  const dirs = storeDirs(storeRoot)
  mkdirSync(dirs.root, { recursive: true })
  if (!existsSync(dirs.config)) {
    const cfg = defaultConfig()
    cfg.storeRoot = storeRoot
    writeFileSync(dirs.config, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    return cfg
  }
  const raw = JSON.parse(readFileSync(dirs.config, 'utf8'))
  const base = defaultConfig()
  return {
    ...base,
    ...raw,
    storeRoot,
    targets: raw.targets ?? base.targets,
    excludes: raw.excludes ?? base.excludes,
    retention: { ...base.retention, ...(raw.retention ?? {}) },
    watch: { ...base.watch, ...(raw.watch ?? {}) },
  }
}

export function ensureDirs(dirs) {
  for (const key of ['root', 'blobs', 'snapshots', 'logs']) mkdirSync(dirs[key], { recursive: true })
}

export function blobPath(dirs, hash) {
  return join(dirs.blobs, hash.slice(0, 2), hash)
}

/** 把 glob（只支持 * / ** / ?）转成正则，用于路径排除。 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' }
        else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$', 'i')
}

export function makeExcluder(patterns) {
  const regs = patterns.map(globToRegExp)
  return (posixRel) => regs.some((r) => r.test(posixRel))
}

export function toPosix(p) {
  return p.replace(/\\/g, '/')
}

export { join, dirname }
