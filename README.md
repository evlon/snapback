# snapback —— 本地目录的「后悔药」（DSH 是默认目标，任意目录皆可守护）

> 目标：**再也不会因为一条误删命令丢掉 profile / 会话 / 记忆**。
> 出事时一条命令回到 5 分钟前，或者任意一个手动存档点。

## 它解决什么问题

2026-11-02 的事故是：一条 `Remove-Item $home -Recurse -Force` 把 `C:\Users\niukl` 下的目录删了（`$home` 是只读的 `$HOME`，赋值失败后指向真实用户目录）。结果：

- `~/.dsh/sessions` 全没了 → 会话列表清空
- `~/.dsh/memories`（523 条记忆）全没了
- `~/.dsh/local-pkgs` 里插件包也被碎片覆盖，`package.json` 变成别的文件内容

**这个服务把"当时的 `~/.dsh` 长什么样"持续存到另一块盘（E:）**，并支持整目录重建。

## 关键设计（为什么这次的备份不会再被一起删掉）

| 设计 | 原因 |
|---|---|
| 存储在 `E:\dsh-undo-store`，**不在** `~/.dsh`、也不在 `C:\Users\niukl` | 上次事故正是删整个用户目录，任何放里面的备份都会一起死 |
| 内容寻址（sha256）去重 | 648 个文件 132MB，第二次快照只新增 12 个 blob（5.9MB），0.5 秒完成 |
| 快照是**清单 + blob**，不是打包 | 单文件损坏不影响其它文件；回滚可以只恢复一个文件 |
| 回滚前自动存档 `pre-restore` | 回滚本身也可以撤回（实测有效） |
| 从不默认删除多余文件 | 只有显式 `--delete-extras` 才删，避免"回滚把新东西也吃掉" |
| 回滚后自动校验 + 自动修复 | 主流程只按文件大小判断会漏掉"同尺寸但内容损坏"的文件（磁盘恢复常见）；回滚末尾再做一次 sha256 比对，不一致/缺失的从 blob 覆盖，做到逐字节还原 |
| 每个文件先写 tmp 再 rename | 回滚中途中断不会留下半截文件 |
| 清单 hash 校验 + 路径越界检查 | 清单被篡改也不会写到奇怪位置 |
| 排除 `node_modules` / `dsh-runtimes` / 缓存 | 这些可重装，纳入快照会让存储爆到 500MB+（实测踩过） |

## 三道防线

1. **自动存档**（daemon）：`~/.dsh` 任何变更后 4 秒防抖快照，另有 10 分钟兜底
2. **危险命令预检**（`scripts/preflight.mjs`）：执行前识别"递归删除 + 用户目录/受保护目录"，
   命中就先存档再放行。**2026-11-02 那条命令实测会被拦下并自动存档**
3. **安全删除通道**（`snapback safe-rm`）：唯一推荐的删除方式 —— 先备份、再校验目标、
   拒绝受保护路径与盘根、只允许删沙箱内的东西

## 用法

```powershell
cd E:\ai-works\dsh-undo

node src\cli.mjs snapshot -m "升级插件前"     # 手动存档（推荐在做危险操作前）
node src\cli.mjs list                         # 看所有还原点
node src\cli.mjs restore <id>                 # 回滚（自动先存当前状态；默认回滚后自动校验+修复）
node src\cli.mjs restore <id> --dry-run       # 预演，不动任何文件
node src\cli.mjs restore <id> --delete-extras # 额外删掉快照里没有的文件
node src\cli.mjs restore <id> --no-verify     # 跳过回滚后的自动校验（更快）
node src\cli.mjs verify <id>                  # 逐文件校验（sha256）
node src\cli.mjs verify <id> --fix            # 校验并自动从 blob 修复不一致/缺失文件
node src\cli.mjs status                       # 存储占用 / 守护是否在跑
node src\cli.mjs prune --dry-run              # 看保留策略会删哪些
```

## 适用范围

快照引擎本身与 DSH **无关**：`config.json` 里的 `targets` 是任意目录列表
（`{ label, path }`），可同时守护多个目录；`restore` / `verify` / `prune` 对所有
target 通用。DSH 只是**默认目标** `~\.dsh`。要守护别的目录，改 `targets` 即可，
或给另一套目录用独立存储（`SNAPBACK_STORE` 指向别的路径，旧 `DSH_UNDO_STORE` 兼容）。

## 🛡 删除护栏（2026-11-02 事故后新增）

事故根因不是「删错目录」，而是 **PowerShell 变量被静默替换**：
`$home` 是只读自动变量（等价 `$HOME`），`$home='C:\Users\niukl\.dsh-onboard-test'`
赋值**静默失败**，`Remove-Item $home -Recurse -Force` 于是删掉了真实家目录。

所以护栏不靠"记住别写错"，而是机器校验：

```powershell
node src\cli.mjs guard C:\Users\niukl           # 只校验：这个路径能不能删（会被拒绝）
node src\cli.mjs protected                      # 看受保护路径与允许的沙箱根
node src\cli.mjs inspect <路径>                 # 看路径会被解析成什么（防变量被替换）
node src\cli.mjs safe-rm <路径> [--dry-run]     # 唯一推荐删法：先备份 → 校验 → 删
node src\cli.mjs safe-rm <路径> --yes           # 显式越过沙箱限制（受保护路径仍拒）
```

**拒绝规则**（命中任一条即拒）：

1. 目标是受保护路径本身（家目录、`~/.dsh`、`~/.ssh`、`~/.pm2`、`E:\ai-works`、后悔药存储……）
2. 目标是受保护路径的**祖先**（删 `C:\Users` 等于删家目录）
3. 目标是盘符根或层级过浅
4. 目标不在允许的沙箱根内（`E:\ai-works\_sandbox`、`E:\ai-works\_tmp`）
5. `..` 绕回、空串、null 等畸形输入

**`safe-rm` 强制先备份**：删除前自动创建还原点，备份失败就中止删除。

回归用例（事故路径永久钉死）：

```powershell
node src\guard.test.mjs      # 32 项，含家目录/父目录/大写/尾斜杠/.. 绕过
```

### 执行前预检（可选接入 DSH 工具链）

```powershell
node scripts\preflight.mjs --command "Remove-Item `$home -Recurse -Force"
```

- 退出码 `0` = 安全放行
- 退出码 `10` = 命中高危但**已自动存档**（可继续执行，后悔药可用）
- 退出码 `11` = 命中高危且存档失败（应拒绝执行）

实测对 2026-11-02 那条命令会报两条：`递归删除 + 目标疑似用户目录/受保护目录`、
`对只读变量 $home 赋值`。


## 守护进程

```powershell
# 前台
node src\daemon.mjs

# 或注册成登录计划任务（隐藏窗口，每 5 分钟后台快照一次 + 变更后 4 秒防抖快照）
schtasks /create /tn "dsh-undo-daemon" /tr "E:\ai-works\dsh-undo\run-daemon.cmd" /sc onlogon /rl LIMITED /f
schtasks /run /tn "dsh-undo-daemon"
```

守护日志：`E:\dsh-undo-store\logs\daemon.log`
守护状态：`E:\dsh-undo-store\daemon.json`

## 保留策略（`E:\dsh-undo-store\config.json`）

```json
"retention": { "keepAuto": 48, "keepDailyDays": 14, "keepManualDays": 0 }
```

- 自动快照留最近 48 个（约 4 小时，按 5 分钟间隔）
- 另外**每天至少留 1 个**，保留 14 天
- **手动快照永久保留**（`keepManualDays: 0`）

## 实测记录（2026-11-03）

| 场景 | 结果 |
|---|---|
| 首次快照 648 文件 132MB | 新增 569 blob，7.4s |
| 第二次快照（无变化） | 新增 12 blob（5.9MB），0.5s，复用 130MB |
| **整目录删除后回滚** | ✅ 全部文件 + 空目录重建，内容逐字节一致 |
| 改坏文件后回滚 | ✅ 恢复原内容，`verify` 2/2 一致 |
| 回滚本身撤回 | ✅ 用 pre-restore 快照回到回滚前 |
| `--delete-extras` | ✅ 只删快照中不存在的文件 |

## 实战成效（2026-11-12：真实删除事故恢复）

**背景**：2026-11-11 晚 `~/.dsh` 被删除，事后做磁盘恢复只找回约 186/938 个文件，
会话列表、记忆、插件包残缺，DSH 无法正常工作。

**做法**：从删除前的健康快照 `20261111-075826-auto` 整体回滚，回滚后自动逐文件校验并修复。

| 指标 | 结果 |
|---|---|
| 快照文件数 | 938（501 个目录，含空目录重建） |
| 逐文件 sha256 校验 | **938 / 938 一致，缺失 0** |
| 磁盘恢复遗留的"同尺寸但内容损坏"文件 | 10 个，全部从内容寻址 blob 覆盖修复 |
| `sessions/` | 由"目录不存在"恢复到 259 个文件 |
| `memories/` | 由 6 个恢复到 49 个文件 |
| 关键运行文件（credentials / settings / roles / profiles …） | 全部在位 |
| 恢复后新增基线快照 | `20261112-092612-manual`（940 文件，永久保留） |

**代价**：一次 restore + 一次校验修复；回滚前自动存档 `pre-restore`，可再撤回。
存储侧 1123 个 blob / 888MB，同内容只存一份、无重复膨胀。

**沉淀的改进**：这次暴露了"主流程只按文件大小判断、会漏修同尺寸损坏文件"的缺陷，
因此 `restore` 现在**默认在回滚后追加一次 sha256 全量校验，并自动从 blob 修复**
不一致/缺失的文件——一条命令即完成"回滚 + 校验 + 修复"闭环。

## 建议的日常纪律

1. **装/卸插件、改 profile、批量改记忆之前**，先 `snapshot -m "说明"`
2. 让守护常驻（登录计划任务），它负责"手滑了但没手动存过"的那种情况
3. 养成习惯：出事第一反应是 `snapback list`，不是去恢复数据

## 后续可以加（未做）

- 托盘菜单入口（右键「立刻存档 / 打开还原点」）
- 与 DSH 的 pwsh 工具集成：检测到命令里出现 `Remove-Item` / `rm -rf` 且目标是 home 时，自动先建一个还原点
- 快照存到 NAS / 远程（防整盘损坏）
