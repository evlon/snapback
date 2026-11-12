/**
 * 守护进程：监视 targets，变更后防抖快照 + 兜底定时快照。
 *
 * 用法：node src/daemon.mjs [--store E:\dsh-undo-store] [--once]
 *
 * 设计取舍：
 *  - 只监听**存在**的目录；目录被整体删除时无法收到事件（Windows 特性），
 *    因此另有 intervalSec 兜底周期快照 + 每次快照前检查 target 是否消失。
 *  - 单个进程串行快照（锁），失败只记录不退出。
 */
import { existsSync, watch, appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, storeDirs, ensureDirs, defaultStoreRoot } from './config.mjs'
import { createSnapshot, pruneSnapshots, storeStats } from './snapshot.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : def
}

const storeRoot = arg('--store', defaultStoreRoot())
const cfg = loadConfig(storeRoot)
const dirs = storeDirs(storeRoot)
ensureDirs(dirs)
mkdirSync(dirs.logs, { recursive: true })
const logFile = join(dirs.logs, 'daemon.log')

function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`
  console.log(line)
  try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* ignore */ }
}

let timer = null
let busy = false
let queued = false
let lastError = null

async function takeSnapshot(trigger) {
  if (busy) { queued = true; return }
  busy = true
  try {
    const meta = await createSnapshot({
      cfg, dirs, kind: 'auto', reason: trigger,
    })
    log('info', 'snapshot', {
      id: meta.id, files: meta.totals.files,
      newBlobs: meta.totals.newBlobs, ms: meta.durationMs,
    })
    const pr = pruneSnapshots({ dirs, retention: cfg.retention })
    if (pr.removed.length) log('info', 'pruned', { removed: pr.removed.length })
    lastError = null
  } catch (e) {
    if (e.code === 'ELOCKED') { log('warn', 'snapshot skipped: lock held') }
    else { lastError = String(e && e.message || e); log('error', 'snapshot failed', { error: lastError }) }
  } finally {
    busy = false
    if (queued) { queued = false; schedule('queued', 200) }
  }
}

function schedule(trigger, delay = cfg.watch.debounceMs) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; takeSnapshot(trigger) }, delay)
}

function startWatchers() {
  for (const t of cfg.targets) {
    if (!existsSync(t.path)) { log('warn', 'target missing, skip watch', { target: t.label, path: t.path }); continue }
    try {
      const w = watch(t.path, { recursive: true }, (evt, file) => {
        if (!file) return
        if (/(\\|\/)(node_modules|\.pnpm|cache|tmp)(\\|\/)/i.test(file)) return
        if (/\.(log|tmp)$/i.test(file)) return
        schedule(`change:${evt}:${file}`)
      })
      w.on('error', (e) => log('error', 'watcher error', { target: t.label, error: String(e.message || e) }))
      log('info', 'watching', { target: t.label, path: t.path })
    } catch (e) {
      log('error', 'watch failed', { target: t.label, error: String(e.message || e) })
    }
  }
}

// 状态文件，便于外部查询守护是否健康
function writeStatus(status) {
  try {
    writeFileSync(join(dirs.root, 'daemon.json'), JSON.stringify({
      pid: process.pid, updatedAt: new Date().toISOString(), ...status,
    }, null, 2), 'utf8')
  } catch { /* ignore */ }
}

async function main() {
  if (process.argv.includes('--once')) {
    await takeSnapshot('one-shot')
    log('info', 'stats', storeStats(dirs))
    return
  }
  log('info', 'snapback daemon start', { store: storeRoot, pid: process.pid })
  writeStatus({ event: 'start', lastError: null })
  await takeSnapshot('startup')
  startWatchers()
  setInterval(() => { takeSnapshot('interval') }, Math.max(60, cfg.watch.intervalSec) * 1000)
  setInterval(() => {
    const st = storeStats(dirs)
    writeStatus({ event: 'tick', lastError, stats: st })
  }, 60_000)
  process.on('SIGINT', () => { log('info', 'SIGINT, exiting'); process.exit(0) })
  process.on('SIGTERM', () => { log('info', 'SIGTERM, exiting'); process.exit(0) })
}

main().catch((e) => { log('fatal', String(e && e.stack || e)); process.exit(1) })
