/**
 * 用 node --test 跑的核心回归测试。
 * 全部在临时目录做，不碰真实 ~/.dsh。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig, storeDirs, ensureDirs, defaultConfig } from '../src/config.mjs'
import { createSnapshot, listSnapshots } from '../src/snapshot.mjs'
import { restoreSnapshot, verifyRestore } from '../src/restore.mjs'
import { hashFile } from '../src/blob.mjs'

function makeEnv() {
  const base = mkdtempSync(join(tmpdir(), 'snapback-test-'))
  const data = join(base, 'data')
  const store = join(base, 'store')
  mkdirSync(join(data, 'sub'), { recursive: true })
  mkdirSync(join(data, 'empty'), { recursive: true })
  writeFileSync(join(data, 'a.txt'), 'alpha')
  writeFileSync(join(data, 'sub', 'b.txt'), 'beta')
  const cfgPath = join(store, 'config.json')
  mkdirSync(store, { recursive: true })
  const cfg = defaultConfig()
  cfg.storeRoot = store
  cfg.targets = [{ label: 'data', path: data }]
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  const loaded = loadConfig(store)
  const dirs = storeDirs(store)
  ensureDirs(dirs)
  return { base, data, store, cfg: loaded, dirs }
}

test('快照记录全部文件与目录', async () => {
  const e = makeEnv()
  const meta = await createSnapshot({ cfg: e.cfg, dirs: e.dirs, kind: 'manual', reason: 't1' })
  assert.equal(meta.totals.files, 2)
  const snaps = listSnapshots(e.dirs)
  assert.equal(snaps.length, 1)
  const j = JSON.parse(readFileSync(join(e.dirs.snapshots, `${meta.id}.json`), 'utf8'))
  // 根目录本身记为 ''（relative(root, root) === ''），恢复时建 root 目录
  assert.deepEqual(j.manifests[0].dirs.sort(), ['', 'empty', 'sub'])
  rmSync(e.base, { recursive: true, force: true })
})

test('内容去重：同样内容只存一份 blob', async () => {
  const e = makeEnv()
  await createSnapshot({ cfg: e.cfg, dirs: e.dirs, kind: 'manual', reason: 'a' })
  const second = await createSnapshot({ cfg: e.cfg, dirs: e.dirs, kind: 'manual', reason: 'b' })
  assert.equal(second.totals.newBlobs, 0, '第二次不应产生新 blob')
  assert.ok(second.totals.reusedBytes >= 9)
  rmSync(e.base, { recursive: true, force: true })
})

test('整目录被删后能完整重建（含空目录）', async () => {
  const e = makeEnv()
  const meta = await createSnapshot({ cfg: e.cfg, dirs: e.dirs, kind: 'manual', reason: 'baseline' })
  const bHash = await hashFile(join(e.data, 'sub', 'b.txt'))

  rmSync(e.data, { recursive: true, force: true })
  assert.equal(existsSync(e.data), false)

  const rep = await restoreSnapshot({ cfg: e.cfg, dirs: e.dirs, id: meta.id, options: { noPreSnapshot: true } })
  assert.equal(rep.targets[0].written, 2)
  assert.equal(readFileSync(join(e.data, 'a.txt'), 'utf8'), 'alpha')
  assert.equal(await hashFile(join(e.data, 'sub', 'b.txt')), bHash)
  assert.ok(existsSync(join(e.data, 'empty')), '空目录应被重建')
  rmSync(e.base, { recursive: true, force: true })
})

test('修改后的文件被还原；默认不删多余文件', async () => {
  const e = makeEnv()
  const meta = await createSnapshot({ cfg: e.cfg, dirs: e.dirs, kind: 'manual', reason: 'baseline' })

  writeFileSync(join(e.data, 'a.txt'), 'CHANGED')
  rmSync(join(e.data, 'sub', 'b.txt'))
  writeFileSync(join(e.data, 'extra.txt'), 'new')

  await restoreSnapshot({ cfg: e.cfg, dirs: e.dirs, id: meta.id, options: { noPreSnapshot: true } })
  assert.equal(readFileSync(join(e.data, 'a.txt'), 'utf8'), 'alpha')
  assert.ok(existsSync(join(e.data, 'sub', 'b.txt')))
  assert.ok(existsSync(join(e.data, 'extra.txt')), '默认不删多余文件')
  rmSync(e.base, { recursive: true, force: true })
})

test('--delete-extras 才删除多余文件；dry-run 不改动', async () => {
  const e = makeEnv()
  const meta = await createSnapshot({ cfg: e.cfg, dirs: e.dirs, kind: 'manual', reason: 'baseline' })
  writeFileSync(join(e.data, 'extra.txt'), 'new')

  await restoreSnapshot({ cfg: e.cfg, dirs: e.dirs, id: meta.id, options: { dryRun: true, noPreSnapshot: true } })
  assert.ok(existsSync(join(e.data, 'extra.txt')), 'dry-run 不应删除')

  const rep = await restoreSnapshot({
    cfg: e.cfg, dirs: e.dirs, id: meta.id,
    options: { deleteExtras: true, noPreSnapshot: true },
  })
  assert.equal(rep.targets[0].deleted, 1)
  assert.equal(existsSync(join(e.data, 'extra.txt')), false)
  rmSync(e.base, { recursive: true, force: true })
})

test('回滚前自动存档，可用它撤回回滚', async () => {
  const e = makeEnv()
  const meta = await createSnapshot({ cfg: e.cfg, dirs: e.dirs, kind: 'manual', reason: 'baseline' })
  writeFileSync(join(e.data, 'a.txt'), 'v2')

  const rep = await restoreSnapshot({ cfg: e.cfg, dirs: e.dirs, id: meta.id })
  assert.ok(rep.preSnapshot, '应产生 pre-restore 快照')
  assert.equal(readFileSync(join(e.data, 'a.txt'), 'utf8'), 'alpha')

  await restoreSnapshot({ cfg: e.cfg, dirs: e.dirs, id: rep.preSnapshot, options: { noPreSnapshot: true } })
  assert.equal(readFileSync(join(e.data, 'a.txt'), 'utf8'), 'v2', '撤回回滚应回到回滚前')
  rmSync(e.base, { recursive: true, force: true })
})

test('verify 逐文件校验能发现不一致', async () => {
  const e = makeEnv()
  const meta = await createSnapshot({ cfg: e.cfg, dirs: e.dirs, kind: 'manual', reason: 'baseline' })
  let v = await verifyRestore({ dirs: e.dirs, id: meta.id })
  assert.equal(v.matched, 2)
  writeFileSync(join(e.data, 'a.txt'), 'tampered')
  v = await verifyRestore({ dirs: e.dirs, id: meta.id })
  assert.equal(v.mismatched.length, 1)
  rmSync(e.base, { recursive: true, force: true })
})

test('排除规则生效（node_modules / *.log）', async () => {
  const e = makeEnv()
  mkdirSync(join(e.data, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(e.data, 'node_modules', 'x', 'index.js'), 'nope')
  writeFileSync(join(e.data, 'debug.log'), 'log')
  const meta = await createSnapshot({ cfg: e.cfg, dirs: e.dirs, kind: 'manual', reason: 'ex' })
  assert.equal(meta.totals.files, 2, 'node_modules 与 *.log 应被排除')
  rmSync(e.base, { recursive: true, force: true })
})
