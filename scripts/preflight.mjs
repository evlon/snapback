/**
 * 危险命令预检：让 DSH 在执行 pwsh/bash 前先判断这条命令是否会威胁 profile，
 * 命中则自动建一个还原点（manual），再放行。
 *
 * 用法（在 DSH 的 hook / pre-shell 环节调用）：
 *   node scripts/preflight.mjs --command "Remove-Item $home -Recurse -Force"
 * 退出码：
 *   0 = 安全，直接放行
 *   10 = 命中高危，但已自动存档（仍然放行，但调用方可提示）
 *   11 = 命中高危，存档失败（调用方应拒绝执行）
 *
 * 判定思路：宁可误报也不漏报。命中任一即算高危：
 *   1. 递归删除（Remove-Item -Recurse / rm -rf / rd /s / del /s / rmdir /s）
 *   2. 目标是 home / 用户目录 / 盘根 / 变量（$home、$env:USERPROFILE、~ 等）
 *   3. 覆盖写关键文件（.dsh 配置、sessions、memories）
 *   4. git clean -fdx / git reset --hard（会丢未提交改动）
 */
import { execFileSync } from 'node:child_process'

const HOME_PATTERNS = [
  /\$home\b/i, /\$env:home\b/i, /\$env:userprofile\b/i, /%userprofile%/i,
  /\b~(?=[\\/\s"']|$)/, /\/c\/users\//i, /[A-Za-z]:\\Users(\\|$)/i,
  /\/home\/[a-z]/i, /\$env:homedrive\b/i,
]

const DELETE_PATTERNS = [
  /remove-item[^\n]*(-recurse|-r\b)/i,
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-[a-z]*r)/i,
  /\brmdir\s+\/s/i,
  /\brd\s+\/s/i,
  /\bdel\s+\/[sq]/i,
  /\bremove-item\b[^\n]*-force/i,
  /\bshutil\.rmtree\b/i,
  /\[System\.IO\.Directory\]::Delete/i,
]

const PROTECTED_PATHS = [
  /\.dsh([\\/]|$)/i, /sessions([\\/]|$)/i, /memories([\\/]|$)/i,
  /profiles([\\/]|$)/i, /local-pkgs([\\/]|$)/i, /attachments([\\/]|$)/i,
  /storages([\\/]|$)/i,
]

const GIT_DESTRUCTIVE = [
  /git\s+clean\s+-[a-z]*[fdx]/i,
  /git\s+reset\s+--hard/i,
]

/** 粗粒度解析：命令里出现的绝对路径（Windows 盘符 / MSYS / ~）。 */
function extractPaths(cmd) {
  const out = new Set()
  for (const m of cmd.matchAll(/([A-Za-z]:\\[^\s"'`;|&)]*)/g)) out.add(m[1])
  for (const m of cmd.matchAll(/(\/[a-z]\/[^\s"'`;|&)]*)/gi)) out.add(m[1])
  for (const m of cmd.matchAll(/(~[\\/]?[^\s"'`;|&)]*)/g)) out.add(m[1])
  return [...out]
}

export function assessCommand(cmd) {
  const text = String(cmd ?? '')
  const reasons = []

  const isDelete = DELETE_PATTERNS.some((re) => re.test(text))
  const isGitDestructive = GIT_DESTRUCTIVE.some((re) => re.test(text))
  const touchesHome = HOME_PATTERNS.some((re) => re.test(text))
  const touchesProtected = PROTECTED_PATHS.some((re) => re.test(text))
  const paths = extractPaths(text)
  const pathAtRoot = paths.some((p) => /^[A-Za-z]:\\?$/.test(p) || /^\/[a-z]\/?$/i.test(p) || /^~[\\/]?$/.test(p))

  if (isDelete && (touchesHome || touchesProtected || pathAtRoot)) {
    reasons.push('递归删除 + 目标疑似用户目录/受保护目录')
  } else if (isDelete) {
    reasons.push('递归删除（未识别到受保护目标，仍存档兜底）')
  }
  if (touchesHome && /\b(move-item|rename-item|set-content|out-file|copy-item)\b/i.test(text)) {
    reasons.push('改写用户目录内文件')
  }
  if (isGitDestructive) reasons.push('git 破坏性操作会丢未提交改动')
  if (pathAtRoot) reasons.push('目标是盘符根目录')
  // 典型的 $home 赋值失败陷阱（$home 是只读的 $HOME）
  if (/^\s*\$home\s*=/im.test(text) || /;\s*\$home\s*=/i.test(text)) {
    reasons.push('对只读变量 $home 赋值（赋值会失败并保留真实 HOME，极易误伤用户目录）')
  }

  return {
    risky: reasons.length > 0,
    reasons,
    paths,
  }
}

function snapshot(store, reason) {
  const out = execFileSync(process.execPath, [
    new URL('../src/cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    'snapshot', '-m', reason,
  ], {
    env: { ...process.env, DSH_UNDO_STORE: store },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return out.trim()
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('preflight.mjs')) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--command')
  const cmd = i >= 0 ? argv[i + 1] : ''
  const store = process.env.SNAPBACK_STORE || process.env.DSH_UNDO_STORE || 'E:\\dsh-undo-store'

  if (!cmd) {
    console.error('用法: node scripts/preflight.mjs --command "<命令>"')
    process.exit(2)
  }

  const a = assessCommand(cmd)
  if (!a.risky) {
    console.log('OK 未命中高危规则')
    process.exit(0)
  }

  console.log('⚠️ 命中高危规则：')
  for (const r of a.reasons) console.log('   - ' + r)
  try {
    const out = snapshot(store, 'preflight: ' + a.reasons[0])
    console.log(out)
    console.log('✅ 已自动存档，可以继续执行（后悔药可用）')
    process.exit(10)
  } catch (e) {
    console.error('❌ 自动存档失败：' + (e?.message || e))
    console.error('   建议先手动 `snapback snapshot` 再执行该命令')
    process.exit(11)
  }
}
