/**
 * snapback — 危险删除守卫
 *
 * 事故复盘（2026-11-02）：
 *   PowerShell 里 $home 是**只读自动变量**（等价 $HOME），
 *   `$home='C:\Users\niukl\.dsh-onboard-test'` 这种赋值**静默失败**，
 *   $home 仍是 'C:\Users\niukl'，随后
 *   `Remove-Item $home -Recurse -Force` 删掉了整个用户家目录。
 *
 * 教训不是"小心点"，而是：**任何递归删除前必须机器校验目标**。
 * 这个模块就是那道校验，不可跳过。
 *
 * 判定顺序（任意一条命中即拒绝）：
 *   1. 目标等价于受保护路径本身
 *   2. 目标是某个受保护路径的**祖先**（删它等于删受保护路径）
 *   3. 目标深度不足（如 C:\、C:\Users），且不在允许的沙箱根内
 *   4. 目标不在允许的沙箱根内，且未显式 --yes
 */
import { homedir } from 'node:os'
import { resolve, parse, sep, join } from 'node:path'

/** Windows 上路径比较一律不区分大小写。 */
function norm(p) {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

function isSameOrAncestor(candidate, descendant) {
  const c = norm(candidate)
  const d = norm(descendant)
  if (c === d) return true
  return d.startsWith(c.endsWith(sep) ? c : c + sep)
}

/** 受保护路径：删它们或其祖先都等于灾难。 */
export function protectedPaths(extra = []) {
  const home = homedir()
  const env = process.env
  const list = [
    // 家目录及其祖先（C:\Users、C:\）
    home,
    // 系统关键目录
    env.USERPROFILE,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.PROGRAMDATA,
    env.WINDIR || env.SYSTEMROOT,
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.ProgramW6432,
    // DSH 相关
    env.DSH_HOME,
    join(home, '.dsh'),
    join(home, '.dsh-matrix-dev'),
    join(home, '.dsh-launcher'),
    join(home, '.agents'),
    join(home, '.ssh'),
    join(home, '.pm2'),
    join(home, '.config'),
    // 工作区与后悔药存储（后者尤其不能删）
    'E:\\ai-works',
    process.env.SNAPBACK_STORE || process.env.DSH_UNDO_STORE || 'E:\\dsh-undo-store',
    ...extra,
  ]
  return [...new Set(list.filter(Boolean).map((p) => resolve(p)))]
}

/** 允许随意删的沙箱根（测试目录只应建在这里）。 */
export function defaultSafeRoots() {
  const roots = [
    join('E:\\ai-works', '_sandbox'),
    join('E:\\ai-works', '_tmp'),
    join(homedir(), '.dsh-onboard-test'),
  ]
  const fromEnv = process.env.SNAPBACK_SAFE_ROOTS || process.env.DSH_UNDO_SAFE_ROOTS
  if (fromEnv) roots.push(...fromEnv.split(';').filter(Boolean))
  return roots.map((p) => resolve(p))
}

/**
 * @param {string} target 待删除路径
 * @param {{safeRoots?:string[], allowOutsideSandbox?:boolean, extraProtected?:string[]}} [opts]
 * @returns {{safe:boolean, target:string, resolved:string, depth:number, reasons:string[], inSafeRoot:string|null}}
 */
export function checkDelete(target, opts = {}) {
  const reasons = []
  const safeRoots = (opts.safeRoots ?? defaultSafeRoots()).map((p) => resolve(p))
  const protectedList = protectedPaths(opts.extraProtected)

  if (!target || typeof target !== 'string' || !target.trim()) {
    return {
      safe: false, target: String(target ?? ''), resolved: '', depth: 0,
      reasons: ['目标为空'], inSafeRoot: null,
    }
  }

  const resolved = resolve(target)
  const parsed = parse(resolved)
  const depth = resolved.split(/[\\/]+/).filter(Boolean).length

  // 1) 受保护路径本身
  for (const p of protectedList) {
    if (norm(resolved) === norm(p)) {
      reasons.push(`目标是受保护路径本身：${p}`)
    }
  }

  // 2) 是受保护路径的祖先
  for (const p of protectedList) {
    if (isSameOrAncestor(resolved, p) && norm(resolved) !== norm(p)) {
      reasons.push(`目标是受保护路径的祖先（删它会连带删掉 ${p}）`)
    }
  }

  // 3) 深度不足：除了盘符外少于 2 段（C:\、C:\Users、D:\repos）
  if (!parsed.dir || resolved === parsed.root) {
    reasons.push(`目标是盘符根目录：${resolved}`)
  } else if (depth < 2) {
    reasons.push(`目标层级过浅（depth=${depth}），疑似误写：${resolved}`)
  }

  // 4) 不在沙箱根内
  let inSafeRoot = null
  for (const r of safeRoots) {
    if (isSameOrAncestor(r, resolved)) { inSafeRoot = r; break }
  }
  if (!inSafeRoot && !opts.allowOutsideSandbox) {
    reasons.push(`目标不在允许的沙箱根内（需显式 --yes 放行）。当前沙箱根：${safeRoots.join(' | ')}`)
  }

  return { safe: reasons.length === 0, target, resolved, depth, reasons, inSafeRoot }
}

/** 便捷断言：不安全就抛错。 */
export function assertSafeDelete(target, opts) {
  const r = checkDelete(target, opts)
  if (!r.safe) {
    const err = new Error(
      `拒绝删除 ${r.resolved || target}：\n  - ` + r.reasons.join('\n  - ') +
      '\n（这是 2026-11-02 家目录事故之后的强制校验，不可绕过）'
    )
    err.code = 'EUNSAFEDELETE'
    err.detail = r
    throw err
  }
  return r
}

/**
 * 反查"这个变量到底解析成了什么"——事故的直接根因是变量被静默替换。
 * 给调用方在删除前打印一行可核对的目标。
 */
export function describeTarget(target) {
  const r = checkDelete(target, { allowOutsideSandbox: true, safeRoots: [] })
  return {
    input: target,
    resolved: r.resolved,
    depth: r.depth,
    verdict: r.reasons.length ? '危险' : '可通过基础校验',
    reasons: r.reasons,
  }
}
