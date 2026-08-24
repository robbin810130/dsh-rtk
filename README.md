# RTK (Runtime Token Keeper) × DSH 集成

把 [RTK](https://github.com/rtk-ai/rtk)（Rust Token Killer，终端输出过滤代理）接入 DSH 的
`bash` 工具，自动把命令重写为 RTK 等价形式（例如 `git status` → `rtk git status`、
`cat file` → `rtk read file`），让命令输出在进入 LLM 上下文之前被压缩，从而节省 token。
机制与 Codex 的 PreToolUse hook 相同（`rtk rewrite`）。

## 前提

- `rtk` 已安装：`/opt/homebrew/bin/rtk`（v0.45.0，`brew install rtk-ai/tap/rtk`）
- 已确认在 Codex 中可用（`rtk init --codex`）

## 工作原理

DSH 的 `bash` 工具在执行命令前调用 `rtk rewrite "<command>"`。补丁覆盖
**两个 bash 工具包**（全部预设模式）：

| 工具包 | 使用它的预设 | 状态 |
| --- | --- | --- |
| `@deepseek-ai/dsh-tool-bash`（一次性 shell） | standard / code / cordis | ✅ 已补丁 |
| `@deepseek-ai/dsh-tool-bash-persistent`（持久 shell） | minimal（极简模式） | ✅ 已补丁 |

> Windows 下的 PowerShell 工具（`dsh-tool-pwsh` 等）未补丁 —— RTK 的 `rtk rewrite`
> 输出是 POSIX/bash 语法，PowerShell 场景需要单独评估；macOS 不受影响。

`rtk rewrite "<command>"` 的判定：

- 返回非空输出（RTK 有匹配过滤器）→ 执行重写后的命令（如 `rtk git status`），输出已被压缩
- 返回空输出（exit 1，无 RTK 等价命令）→ 原样执行

实测效果（v0.45.0）：

| 原命令 | RTK 重写 | 效果 |
| --- | --- | --- |
| `git status` | `rtk git status` | ~10 行 → 2 行 |
| `ls -la` | `rtk ls -la` | 紧凑列表 |
| `cat file` | `rtk read file` | 小文件输出一致，大文件智能过滤 |
| `find . -name '*.txt'` | `rtk find . -name '*.txt'` | 紧凑树形 |
| `pnpm install` | `rtk pnpm install` | 去除构建噪音 |
| `echo hello` | 不重写 | 原样执行 |
| `ls -la \| head -5` | 不重写（管道） | 原样执行 |

## 安装（已完成的修改）

修改了 DSH 安装中的两个文件：

**`dsh-tool-bash/lib/index.js`**（一次性 bash）：
1. 新增 `spawnSync` 导入
2. 新增 `rewriteWithRtk(command)` 辅助函数
3. `execute()` 中用 `rewriteWithRtk(args.command)` 取代 `args.command` 构造请求
4. `bash` 工具描述中说明输出可能被 RTK 压缩

**`dsh-tool-bash-persistent/lib/index.js`**（持久 bash，极简模式）：
1. 新增 `spawnSync` 导入
2. 同样的 `rewriteWithRtk(command)` 辅助函数
3. `executeCommand()` 开头用 `command = rewriteWithRtk(command)` 重写命令
4. 工具描述追加相同的 RTK 说明

> ⚠️ 这两个文件位于 node_modules，DSH 更新/重装后会丢失。届时运行：
>
> ```bash
> node "…/DSH 插件/rtk-token-keeper/patch-rtk.mjs" apply
> ```

### 关于 PATH（重要）

DSH 的 bash 子进程 PATH 是受限的（不含 `/opt/homebrew/bin`），所以重写后的裸
`rtk` 命令会解析失败（`bash: rtk: command not found`）。补丁已处理：重写结果中的
命令位置 `rtk` 令牌会被替换为已解析的绝对路径（如 `/opt/homebrew/bin/rtk git status`），
因此无需修改 PATH 也能生效。

替换覆盖三种命令位置：命令开头、`; & |` 分隔符之后、`VAR=value` 环境变量前缀之后
（例如 `GIT_PAGER=cat git log` → `GIT_PAGER=cat /opt/homebrew/bin/rtk git log`）。

如果你希望 DSH 的 bash 子进程也能直接使用其他 Homebrew 工具（`pnpm`、`node` 等），
需要修改 launchd 的 PATH（见下）。

## 补丁脚本

```bash
node patch-rtk.mjs apply    # 应用补丁到两个 bash 工具包（幂等，已应用则跳过）
node patch-rtk.mjs check    # 查看两个目标的补丁状态
node patch-rtk.mjs revert   # 恢复两个文件的原始上游
```

脚本会在 `.backup/` 下为每个目标保存一份原始文件，`revert` 用它恢复。

## 开关与配置

- `DSH_RTK_DISABLE=1`（环境变量）→ 全局关闭 RTK 重写
- 命令前加 `DSH_RTK_DISABLE=1` → 单条命令关闭重写（用于需要精确原始输出的场景，
  例如精确的 `git diff` 内容、完整文件读取）
- `RTK_BIN=/path/to/rtk` → 覆盖 rtk 二进制路径

## 生效方式

修改的是服务端包。**重启 dsh web 服务**后生效；当前已运行的会话仍使用旧代码。

dsh web 由 launchd 管理（`~/Library/LaunchAgents/ai.deepseek.harness.plist`，
`KeepAlive` 为 true，服务退出后会自动重启）。重启方式：

```bash
# 方式一：直接杀掉进程，launchd 会自动重启
kill "$(lsof -tiTCP:3080 -sTCP:LISTEN)"

# 方式二：通过 launchctl 重启
launchctl kickstart -k "gui/$(id -u)/ai.deepseek.harness"
```

> 注意：当前正在服务进程内运行的 agent 回合会被重启中断，重启完成后需要刷新页面
> 并重新发消息继续。

如需让子进程 PATH 包含 `/opt/homebrew/bin`（例如让 rtk 内部调用的 Homebrew 工具可
用），修改 plist 中的 `EnvironmentVariables.PATH` 后重启服务，或运行
`launchctl setenv PATH "/opt/homebrew/bin:$PATH"` 再重启。
