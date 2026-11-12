/**
 * 守卫自检 —— 把 2026-11-02 事故路径变成**永久回归用例**。
 *
 * 只要这些断言还有一个能通过（误判为可删），`node src/guard.test.mjs` 就红。
 * 用法：node src/guard.test.mjs
 */
import assert from 'node:assert'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { checkDelete, assertSafeDelete, protectedPaths, defaultSafeRoots } from './guard.mjs'

let pass = 0
let fail = 0
const cases = []

function mustDeny(target, why, opts) {
  cases.push({ target, expect: 'deny', why, opts })
}
function mustAllow(target, why, opts) {
  cases.push({ target, expect: 'allow', why, opts })
}

const home = homedir()
const SANDBOX = 'E:\\ai-works\\_sandbox'

// ===== 事故本体：这 6 条必须永远拒 =====
mustDeny(home, '2026-11-02 事故目标（家目录）')
mustDeny(home + '\\', '家目录带尾斜杠（同一路径的另一种写法）')
mustDeny(home.toUpperCase(), '家目录大写形式（Windows 不区分大小写）')
mustDeny('C:\\', '盘符根')
mustDeny('C:\\Users', '家目录的父目录')
mustDeny(join(home, '.dsh'), 'DSH home')

// ===== 其它受保护路径 =====
mustDeny('E:\\ai-works', '工作区根')
mustDeny('E:\\dsh-undo-store', '后悔药存储（删了连后悔药都没了）')
mustDeny(join(home, '.ssh'), 'SSH 私钥')
mustDeny(join(home, '.pm2'), 'pm2 状态')
mustDeny(join(home, '.agents'), '全局技能库')
mustDeny(join(home, 'AppData'), 'AppData')
mustDeny(join(home, 'Downloads'), '下载目录（不在沙箱内）')
mustDeny(join(home, '.dsh-matrix-dev'), 'matrix-dev 实例 home')

// ===== 路径穿越/畸形写法 =====
mustDeny(join(home, '..', 'niukl'), '.. 绕回来的家目录')
mustDeny(join(home, '.dsh', '..', '..'), '多级 .. 回到家目录的父级')
mustDeny('', '空字符串')
mustDeny(null, 'null')
mustDeny(undefined, 'undefined')

// ===== 应当允许：仅限沙箱内 =====
mustAllow(join(SANDBOX, 'onboard-1'), '沙箱内一级目录')
mustAllow(join(SANDBOX, 'onboard-1', 'dsh-home'), '沙箱内 dsh-home')
mustAllow(join(SANDBOX, 'onboard-1', 'dsh-home', 'profiles'), '沙箱内嵌套目录')
mustAllow('E:\\ai-works\\_tmp', '_tmp 在允许根内')
mustAllow(join(home, '.dsh-onboard-test'), '显式白名单的测试 home')

// ===== 显式 --yes 才能越过沙箱限制，但仍不得越过受保护路径 =====
mustDeny(join(home, 'Downloads'), '即使 --yes，家目录内非沙箱目录仍拒', { allowOutsideSandbox: false })

for (const c of cases) {
  let result
  try {
    result = checkDelete(c.target, c.opts)
  } catch (e) {
    result = { safe: false, reasons: [e.message] }
  }
  const got = result.safe ? 'allow' : 'deny'
  const ok = got === c.expect
  if (ok) {
    pass++
  } else {
    fail++
    console.error(`❌ ${c.why}\n   目标: ${JSON.stringify(c.target)}\n   期望: ${c.expect}  实际: ${got}\n   reasons: ${(result.reasons || []).join(' | ')}`)
  }
}

// ===== assertSafeDelete 必须真的抛 =====
try {
  assertSafeDelete(home)
  fail++
  console.error('❌ assertSafeDelete 没有对家目录抛错')
} catch (e) {
  if (e.code === 'EUNSAFEDELETE') pass++
  else { fail++; console.error('❌ assertSafeDelete 抛了不是 EUNSAFEDELETE 的错误: ' + e.code) }
}

// ===== 受保护列表必须包含关键项 =====
const prot = protectedPaths().map((p) => (process.platform === 'win32' ? p.toLowerCase() : p))
for (const need of [home, join(home, '.dsh'), 'E:\\ai-works'].map((p) => (process.platform === 'win32' ? p.toLowerCase() : p))) {
  if (prot.includes(need)) pass++
  else { fail++; console.error('❌ 受保护列表缺少: ' + need) }
}

// ===== 沙箱根必须都不在 C:\Users 下（防止把沙箱建到危险位置） =====
for (const r of defaultSafeRoots()) {
  const bad = r.toLowerCase().startsWith('c:\\users') && !r.toLowerCase().startsWith(join(home, '.dsh-onboard-test').toLowerCase())
  if (!bad) pass++
  else { fail++; console.error('❌ 沙箱根落在 C:\\Users 下: ' + r) }
}

console.log(`\n守卫自检：${pass} 通过 / ${fail} 失败 / 共 ${cases.length + 5} 项`)
if (fail > 0) process.exit(1)
console.log('✅ 全部通过 —— 2026-11-02 事故路径已被永久拦截')
