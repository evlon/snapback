/**
 * snapback — 受控沙箱环境
 *
 * 为什么是"沙箱"而不是"随便找个空目录"：
 *   2026-11-02 的根因不是"删错目录"，而是 **PowerShell 变量被静默替换**
 *   （$home 是只读自动变量，赋值失败却继续执行，Remove-Item 落在真实家目录）。
 *
 *   所以沙箱不是靠"记住别写错"，而是三条硬约束：
 *     1. 沙箱根固定在 E:\ai-works\_sandbox，物理上不在 C:\Users 下
 *     2. 清理/重建只允许走 snapback safe-rm（自动备份 + 路径校验）
 *     3. 任何不经过 guard 的删除都由 guard.test 在 CI/自检里抓出来
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkDelete } from './guard.mjs'

export const SANDBOX_ROOT = resolve('E:\\ai-works\\_sandbox')

/** 创建一个干净的 DSH 测试 home（只含 profile 骨架），返回路径信息。 */
export function createSandbox(name, opts = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    const err = new Error(`沙箱名不合法（只允许字母数字 . _ -）：${name}`)
    err.code = 'EBADNAME'
    throw err
  }
  const root = join(SANDBOX_ROOT, name)

  const verdict = checkDelete(root, { safeRoots: [SANDBOX_ROOT] })
  if (!verdict.safe) {
    const err = new Error(`沙箱路径被守卫拒绝：${verdict.reasons.join('; ')}`)
    err.code = 'EUNSAFEDELETE'
    throw err
  }

  const dshHome = join(root, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', 'desktop')

  mkdirSync(profileDir, { recursive: true })

  // 模拟真实同事机器的最小 profile（与生产 .npmrc 一致的分流）
  const npmrc = join(profileDir, '.npmrc')
  if (!existsSync(npmrc)) {
    writeFileSync(npmrc, 'registry=https://registry.npmmirror.com/\n@evlon:registry=http://registry.ict.cmcc/\n', 'utf8')
  }

  const pkg = join(profileDir, 'package.json')
  if (!existsSync(pkg)) {
    writeFileSync(pkg, JSON.stringify({
      name: 'dsh-profile-desktop',
      version: '0.0.0',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, null, 2) + '\n', 'utf8')
  }

  // 沙箱清单：留痕，方便事后审计"这次到底动了什么"
  const manifest = join(root, 'sandbox.json')
  writeFileSync(manifest, JSON.stringify({
    name,
    createdAt: new Date().toISOString(),
    root,
    dshHome,
    profileDir,
    note: opts.note || '',
    cleanupRule: `只允许 node src/cli.mjs safe-rm "${root}"`,
  }, null, 2) + '\n', 'utf8')

  return { root, dshHome, profileDir, manifest }
}

export function sandboxInfo(name) {
  const root = join(SANDBOX_ROOT, name)
  const f = join(root, 'sandbox.json')
  if (!existsSync(f)) return null
  return JSON.parse(readFileSync(f, 'utf8'))
}
