#!/usr/bin/env node
/**
 * snapback CLI —— 后悔药
 *
 *   snapback snapshot [-m 说明]      手动立刻存一个还原点
 *   snapback list [--json]           列出还原点
 *   snapback show <id>               看某个还原点的内容摘要
 *   snapback restore <id> [--dry-run] [--delete-extras] [--target Label]
 *   snapback verify <id>             回滚后逐文件校验
 *   snapback status                  存储占用 / 守护状态
 *   snapback prune [--dry-run]       按保留策略清理
 *   snapback init [--store PATH]     初始化存储
 *   snapback daemon                  前台启动守护
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, storeDirs, ensureDirs, defaultStoreRoot } from './config.mjs'
import {
  createSnapshot, listSnapshots, readSnapshot, pruneSnapshots,
  storeStats, gcBlobs,
} from './snapshot.mjs'
import { restoreSnapshot, verifyRestore } from './restore.mjs'
import { checkDelete, describeTarget, defaultSafeRoots, protectedPaths } from './guard.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
function flag(name) { return argv.includes(name) }
function opt(name, def) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : def
}

const storeRoot = process.env.SNAPBACK_STORE || process.env.DSH_UNDO_STORE || opt('--store', defaultStoreRoot())
const cfg = loadConfig(storeRoot)
const dirs = storeDirs(storeRoot)
ensureDirs(dirs)

const kb = (n) => (n < 1024 ? `${n}B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 ** 2).toFixed(1)}MB`)

function printVerify(v, tag = '校验') {
  console.log(`   ${tag}: 校验 ${v.checked} · 一致 ${v.matched} · 不一致 ${v.mismatched.length} · 缺失 ${v.missing.length}` +
    (v.dryRun ? '' : ` · 已修复 ${v.repaired.length} · 修复失败 ${v.failed.length}`))
  if (v.repaired.length) {
    const more = v.repaired.length > 8 ? ` …(+${v.repaired.length - 8})` : ''
    console.log(`     已修复: ${v.repaired.slice(0, 8).join(', ')}${more}`)
  }
  if (v.failed.length) console.log(`     ⚠️ 修复失败: ${v.failed.slice(0, 5).join(' | ')}`)
  const unresolved = v.mismatched.length + v.missing.length - v.repaired.length
  if (unresolved > 0) console.log(`     ⚠️ 仍有 ${unresolved} 个文件未修复`)
}

function table(rows, cols) {
  const w = cols.map((c) => Math.max(c.h.length, ...rows.map((r) => String(c.get(r)).length)))
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ')
  console.log(line(cols.map((c) => c.h)))
  console.log(line(w.map((x) => '-'.repeat(x))))
  for (const r of rows) console.log(line(cols.map((c) => c.get(r))))
}

async function main() {
  switch (cmd) {
    case 'init': {
      console.log(`存储目录: ${dirs.root}`)
      console.log(JSON.stringify(cfg, null, 2))
      break
    }
    case 'snapshot': {
      const reason = opt('-m', opt('--message', 'manual'))
      const meta = await createSnapshot({ cfg, dirs, kind: 'manual', reason })
      console.log(`✅ 已创建还原点 ${meta.id}`)
      console.log(`   文件 ${meta.totals.files} 个 · 新增 blob ${meta.totals.newBlobs} 个 (${kb(meta.totals.newBytes)}) · 复用 ${kb(meta.totals.reusedBytes)} · 耗时 ${meta.durationMs}ms`)
      for (const t of meta.targets) console.log(`   - ${t.label}: ${t.files} 文件${t.missing ? '（目录缺失！）' : ''}`)
      break
    }
    case 'list': {
      const snaps = listSnapshots(dirs)
      if (flag('--json')) { console.log(JSON.stringify(snaps, null, 2)); break }
      if (!snaps.length) { console.log('还没有任何还原点，先运行: snapback snapshot'); break }
      table(snaps.slice(0, Number(opt('--limit', 40))), [
        { h: '时间', get: (s) => s.createdAt.replace('T', ' ').slice(0, 19) },
        { h: '类型', get: (s) => s.kind },
        { h: '文件', get: (s) => s.totals?.files ?? 0 },
        { h: '说明', get: (s) => (s.reason || '').slice(0, 44) },
        { h: 'ID', get: (s) => s.id },
      ])
      break
    }
    case 'show': {
      const id = argv[1]
      const s = readSnapshot(dirs, id)
      console.log(JSON.stringify({
        id: s.id, kind: s.kind, reason: s.reason, createdAt: s.createdAt,
        totals: s.totals,
        targets: s.manifests.map((m) => ({
          label: m.label, root: m.root, files: m.files.length, dirs: m.dirs.length, links: m.links.length,
        })),
      }, null, 2))
      break
    }
    case 'restore': {
      const id = argv[1]
      if (!id) { console.error('用法: snapback restore <id> [--dry-run] [--no-verify]'); process.exit(2) }
      const only = opt('--target')
      const rep = await restoreSnapshot({
        cfg, dirs, id,
        options: {
          dryRun: flag('--dry-run'),
          deleteExtras: flag('--delete-extras'),
          onlyTargets: only ? only.split(',') : null,
          noPreSnapshot: flag('--no-pre-snapshot'),
          verify: !flag('--no-verify'),
        },
      })
      console.log(flag('--dry-run') ? '🔎 预演（未改动任何文件）' : '✅ 回滚完成')
      if (rep.preSnapshot) console.log(`   回滚前已自动存档: ${rep.preSnapshot}（可再次撤回）`)
      for (const t of rep.targets) {
        console.log(`   - ${t.label}: 需写入 ${t.created}(已写 ${t.written}) · 已存在 ${t.unchanged} · 目录 ${t.dirs} · 链接 ${t.links}` +
          (t.deleted ? ` · 删除多余 ${t.deleted}` : '') +
          (t.recoveredMissing ? ' · 目录原本不存在已重建' : ''))
        if (t.missingBlobs.length) console.log(`     ⚠️ 缺 blob ${t.missingBlobs.length} 个: ${t.missingBlobs.slice(0, 5).join(', ')}`)
        if (t.errors.length) console.log(`     ⚠️ 错误 ${t.errors.length} 条: ${t.errors.slice(0, 3).join(' | ')}`)
      }
      if (rep.verify) printVerify(rep.verify, rep.verify.dryRun ? '校验预演' : '自动校验')
      break
    }
    case 'verify': {
      const id = argv[1]
      if (!id) { console.error('用法: snapback verify <id> [--fix] [--dry-run]'); process.exit(2) }
      const doFix = flag('--fix')
      const r = await verifyRestore({ dirs, id, fix: doFix, dryRun: flag('--dry-run') })
      printVerify(r, r.dryRun ? '校验预演' : (doFix ? '校验并修复' : '校验'))
      break
    }
    case 'status': {
      const st = storeStats(dirs)
      console.log(`存储目录 : ${dirs.root}`)
      console.log(`去重后   : ${st.blobs} 个 blob / ${kb(st.blobBytes)}`)
      console.log(`还原点   : ${st.snapshots} 个${st.latest ? `，最近 ${st.latest.id} (${st.latest.createdAt})` : ''}`)
      const dp = join(dirs.root, 'daemon.json')
      if (existsSync(dp)) console.log(`守护状态 : ${readStatus(dp)}`)
      else console.log('守护状态 : 未运行')
      break
    }
    case 'prune': {
      const r = pruneSnapshots({ dirs, retention: cfg.retention, dryRun: flag('--dry-run') })
      console.log(`${flag('--dry-run') ? '将' : '已'}删除 ${r.removed.length} 个还原点，保留 ${r.kept.length} 个`)
      if (r.removed.length) console.log(r.removed.join('\n'))
      break
    }
    case 'gc': {
      const r = gcBlobs(dirs)
      console.log(`清理无人引用的 blob：${r.removed} 个，释放 ${kb(r.freed)}`)
      break
    }
    case 'guard': {
      const target = argv[1]
      if (!target) { console.error('用法: snapback guard <路径>'); process.exit(2) }
      const r = checkDelete(target, { allowOutsideSandbox: flag('--yes') })
      console.log(`目标   : ${r.resolved}`)
      console.log(`层级   : ${r.depth}`)
      console.log(`沙箱根 : ${r.inSafeRoot ?? '(不在任何沙箱根内)'}`)
      if (r.safe) {
        console.log('✅ 通过校验，可安全删除')
      } else {
        console.log('⛔ 拒绝删除：')
        for (const why of r.reasons) console.log('   - ' + why)
        process.exit(1)
      }
      break
    }
    case 'safe-rm': {
      const target = argv[1]
      if (!target) { console.error('用法: snapback safe-rm <路径> [--dry-run] [--yes]'); process.exit(2) }
      const r = checkDelete(target, { allowOutsideSandbox: flag('--yes') })
      console.log(`目标   : ${r.resolved}`)
      console.log(`层级   : ${r.depth}`)
      console.log(`沙箱根 : ${r.inSafeRoot ?? '(不在任何沙箱根内)'}`)
      if (!r.safe) {
        console.log('⛔ 拒绝删除：')
        for (const why of r.reasons) console.log('   - ' + why)
        process.exit(1)
      }
      if (flag('--dry-run')) { console.log('🔎 预演（未删除任何东西）'); break }
      // 删除前强制存一个还原点（事故教训：先备份，再删）
      try {
        const meta = await createSnapshot({ cfg, dirs, kind: 'manual', reason: `before-rm ${r.resolved}` })
        console.log(`✅ 删除前已存还原点 ${meta.id}`)
      } catch (e) {
        console.error(`❌ 备份失败，已中止删除：${e.message}`)
        process.exit(1)
      }
      const { rmSync } = await import('node:fs')
      try {
        rmSync(r.resolved, { recursive: true, force: true })
        console.log(`✅ 已删除 ${r.resolved}`)
      } catch (e) {
        console.error(`❌ 删除失败：${e.message}`)
        process.exit(1)
      }
      break
    }
    case 'sandbox': {
      const name = argv[1] || ('onboard-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14))
      const root = join('E:\\ai-works', '_sandbox')
      const target = join(root, name)
      const r = checkDelete(target, { safeRoots: [root] })
      if (!r.safe) {
        console.log('⛔ 沙箱路径不合法：')
        for (const why of r.reasons) console.log('   - ' + why)
        process.exit(1)
      }
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(target, 'profiles', 'desktop'), { recursive: true })
      console.log(`✅ 沙箱已就绪（只允许删这棵子树）`)
      console.log(`   根目录 : ${target}`)
      console.log(`   profile: ${join(target, 'profiles', 'desktop')}`)
      console.log('')
      console.log('提示：后续所有"删除/重建"只针对上面这个根目录；')
      console.log('      删除一律走 `snapback safe-rm <路径>`（自动先备份 + 强制校验）。')
      break
    }
    case 'protected': {
      console.log('受保护路径（删它们或它们的祖先都会被拒绝）：')
      for (const p of protectedPaths()) console.log('  - ' + p)
      console.log('')
      console.log('允许的沙箱根：')
      for (const p of defaultSafeRoots()) console.log('  - ' + p)
      break
    }
    case 'inspect': {
      const target = argv[1]
      if (!target) { console.error('用法: snapback inspect <路径>'); process.exit(2) }
      console.log(JSON.stringify(describeTarget(target), null, 2))
      break
    }
    default:
      console.log(`snapback —— 目录的「后悔药」：快照 / 回滚 / 校验修复 / 删除护栏

用法：
  snapback snapshot [-m 说明]          立刻存还原点
  snapback list [--limit N] [--json]   列出还原点
  snapback show <id>                   查看还原点摘要
  snapback restore <id> [--dry-run] [--delete-extras] [--no-verify] [--target label]
                                       默认恢复后自动逐文件校验并修复损坏文件
  snapback verify <id> [--fix] [--dry-run]   逐文件校验（--fix 从存量 blob 修复）
  snapback status                      存储占用 / 守护状态
  snapback prune [--dry-run]           按策略清理
  snapback gc                          清理无引用 blob
  snapback init                        初始化（打印配置）

安全护栏（2026-11-02 家目录事故后新增）：
  snapback guard <路径>                只校验：这个路径能不能删
  snapback safe-rm <路径> [--dry-run]  先备份→校验→删除（唯一推荐删法）
  snapback sandbox [名字]              在 E:\\ai-works\\_sandbox 下建受控沙箱
  snapback protected                   看受保护路径与允许的沙箱根
  snapback inspect <路径>              看某个路径会被解析成什么

存储: ${storeRoot}（可用 DSH_UNDO_STORE 覆盖）
`)
  }
}

function readStatus(p) {
  try { return readFileSync(p, 'utf8').replace(/\s+/g, ' ').trim() } catch { return '(读取失败)' }
}

main().catch((e) => { console.error('❌ ' + (e && e.stack || e)); process.exit(1) })
