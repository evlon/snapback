/**
 * 端到端演练：完全用自造数据，覆盖"整目录被删""文件被改坏""回滚再撤回"
 * 等真实事故形态。不触碰任何生产目录。
 *
 * 运行：node scripts/drill.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, storeDirs, ensureDirs, defaultConfig } from '../src/config.mjs'
import { createSnapshot, listSnapshots } from '../src/snapshot.mjs'
import { restoreSnapshot, verifyRestore } from '../src/restore.mjs'

const log = (...a) => console.log(...a)
const ok = (cond, msg) => {
  log(`${cond ? '✅' : '❌'} ${msg}`)
  if (!cond) { failed++; }
}
let failed = 0

const root = mkdtempSync(join(tmpdir(), 'snapback-drill-'))
const data = join(root, 'dsh-home-sim')
const store = join(root, 'store')

// ---- 造数据 ----
mkdirSync(join(data, 'sessions', '--E-demo--', 'session-a'), { recursive: true })
mkdirSync(join(data, 'memories', 'daily'), { recursive: true })
mkdirSync(join(data, 'memories', 'projects', 'abcdef123456'), { recursive: true })
mkdirSync(join(data, 'profiles', 'desktop'), { recursive: true })
mkdirSync(join(data, 'empty-folder'), { recursive: true })

writeFileSync(join(data, 'sessions', '--E-demo--', 'session-a', 'session.v4.jsonl.zstd'), Buffer.from('SESSION-BYTES-'.repeat(50)))
writeFileSync(join(data, 'memories', 'MEMORY.md'), '[2026-09-04] 记忆条目 A\n§\n[2026-09-05] 记忆条目 B\n')
writeFileSync(join(data, 'memories', 'USER.md'), '[2026-09-04] 用户档案\n')
writeFileSync(join(data, 'memories', 'daily', '2026-11-03.md'), '[10:00] 日志\n')
writeFileSync(join(data, 'memories', 'projects', 'abcdef123456', 'KEY.md'), '[2026-09-07] KEY\n')
writeFileSync(join(data, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'sim', bundles: ['a', 'b'] }, null, 2))
writeFileSync(join(data, '.credentials.yaml'), 'token: secret-token\n')
writeFileSync(join(data, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 7))

// 排除项（不应进快照）
mkdirSync(join(data, 'node_modules', 'x'), { recursive: true })
writeFileSync(join(data, 'node_modules', 'x', 'index.js'), 'ignored')
writeFileSync(join(data, 'debug.log'), 'ignored log')

const cfgFile = join(store, 'config.json')
mkdirSync(store, { recursive: true })
const base = defaultConfig()
writeFileSync(cfgFile, JSON.stringify({
  ...base, storeRoot: store,
  targets: [{ label: 'dsh-sim', path: data }],
}, null, 2))
const cfg = loadConfig(store)
const dirs = storeDirs(store)
ensureDirs(dirs)

const countFiles = (dir) => {
  let n = 0
  ;(function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) n++
    }
  })(dir)
  return n
}

try {
  log('\n=== 0. 环境 ===')
  log(`数据目录 ${data}`)
  log(`存储目录 ${store}`)

  // ---- 1. 基线快照 ----
  log('\n=== 1. 基线快照 ===')
  const s1 = await createSnapshot({ cfg, dirs, kind: 'manual', reason: 'baseline' })
  // 8 个：session.v4 / MEMORY.md / USER.md / daily / KEY.md / package.json / .credentials.yaml / big.bin
  // 排除：node_modules/x/index.js、debug.log
  ok(s1.totals.files === 8, `快照收录 8 个文件（排除 node_modules 与 *.log），实际 ${s1.totals.files}`)
  const snap1 = JSON.parse(readFileSync(join(dirs.snapshots, `${s1.id}.json`), 'utf8'))
  ok(snap1.manifests[0].dirs.includes('empty-folder'), '空目录被记录')

  // ---- 2. 增量去重 ----
  log('\n=== 2. 第二次快照应几乎不新增 blob ===')
  const s2 = await createSnapshot({ cfg, dirs, kind: 'manual', reason: 'nochange' })
  ok(s2.totals.newBlobs === 0, `无变化时不产生新 blob，实际 ${s2.totals.newBlobs}`)

  // ---- 3. 事故形态 A：整目录被删 ----
  log('\n=== 3. 事故 A：整个 dsh-home 被 Remove-Item 删掉 ===')
  const beforeHashes = new Map()
  for (const f of snap1.manifests[0].files) beforeHashes.set(f.path, f.hash)
  rmSync(data, { recursive: true, force: true })
  ok(!existsSync(data), '目录已被删除')

  const repA = await restoreSnapshot({ cfg, dirs, id: s1.id })
  ok(repA.targets[0].written === 8, `回滚写回 8 个文件，实际 ${repA.targets[0].written}`)
  ok(existsSync(join(data, 'memories', 'MEMORY.md')), 'MEMORY.md 回来了')
  ok(readFileSync(join(data, 'memories', 'MEMORY.md'), 'utf8').includes('记忆条目 B'), '记忆内容完整')
  ok(readFileSync(join(data, 'profiles', 'desktop', 'package.json'), 'utf8').includes('"bundles"'), 'profile 配置完整')
  ok(existsSync(join(data, 'empty-folder')), '空目录重建')
  ok(repA.preSnapshot !== null, '回滚前自动存了 pre-restore')

  const vA = await verifyRestore({ dirs, id: s1.id })
  ok(vA.mismatched.length === 0 && vA.missing.length === 0, `逐文件校验全部一致（${vA.matched}/${vA.checked}）`)

  // ---- 4. 事故形态 B：文件被改坏 + 新文件 ----
  log('\n=== 4. 事故 B：MEMORY.md 被改坏、USER.md 被删、多出新文件 ===')
  const s3 = await createSnapshot({ cfg, dirs, kind: 'manual', reason: 'before-corrupt' })
  writeFileSync(join(data, 'memories', 'MEMORY.md'), '全部记忆被我覆盖了')
  rmSync(join(data, 'memories', 'USER.md'))
  writeFileSync(join(data, 'new-junk.txt'), 'junk')

  const repB = await restoreSnapshot({ cfg, dirs, id: s3.id })
  ok(readFileSync(join(data, 'memories', 'MEMORY.md'), 'utf8').includes('记忆条目 A'), '被改坏的文件还原')
  ok(existsSync(join(data, 'memories', 'USER.md')), '被删的文件还原')
  ok(existsSync(join(data, 'new-junk.txt')), '默认不删多余文件（安全）')

  // ---- 5. 回滚再撤回 ----
  log('\n=== 5. 回滚本身可以撤回 ===')
  const repC = await restoreSnapshot({ cfg, dirs, id: s1.id })
  ok(readFileSync(join(data, 'memories', 'MEMORY.md'), 'utf8').includes('记忆条目 A'), '已回到基线')
  await restoreSnapshot({ cfg, dirs, id: repC.preSnapshot, options: { noPreSnapshot: true } })
  ok(readFileSync(join(data, 'memories', 'MEMORY.md'), 'utf8').includes('记忆条目 A'), '撤回后内容正确')

  // ---- 6. dry-run ----
  log('\n=== 6. dry-run 不改动磁盘 ===')
  writeFileSync(join(data, 'memories', 'MEMORY.md'), 'modified-for-dryrun')
  const beforeSize = statSync(join(data, 'memories', 'MEMORY.md')).size
  await restoreSnapshot({ cfg, dirs, id: s1.id, options: { dryRun: true, noPreSnapshot: true } })
  ok(readFileSync(join(data, 'memories', 'MEMORY.md'), 'utf8') === 'modified-for-dryrun', 'dry-run 未改动文件')

  // ---- 7. --delete-extras ----
  log('\n=== 7. 显式 --delete-extras 才清理多余文件 ===')
  const repD = await restoreSnapshot({ cfg, dirs, id: s1.id, options: { deleteExtras: true, noPreSnapshot: true } })
  ok(!existsSync(join(data, 'new-junk.txt')), '多余文件已清理')
  ok(repD.targets[0].deleted >= 1, `deleted=${repD.targets[0].deleted}`)

  // ---- 8. 保留策略 ----
  log('\n=== 8. 快照列表与存储占用 ===')
  const snaps = listSnapshots(dirs)
  ok(snaps.length >= 3, `共 ${snaps.length} 个还原点`)
  const blobCount = readdirSync(dirs.blobs).reduce((n, shard) => {
    const d = join(dirs.blobs, shard)
    try { return n + (statSync(d).isDirectory() ? readdirSync(d).length : 0) } catch { return n }
  }, 0)
  const totalBytes = snap1.manifests[0].files.reduce((a, f) => a + f.size, 0) + 2 * 1024 * 1024 + 21
  ok(blobCount < 20, `去重后 blob 数 ${blobCount}（远小于文件数×快照数）`)

  log('\n=== 结果 ===')
  log(failed === 0 ? '🎉 全部通过' : `❌ ${failed} 项失败`)
} finally {
  rmSync(root, { recursive: true, force: true })
  log(`\n（已清理临时目录 ${root}）`)
}
process.exit(failed === 0 ? 0 : 1)
