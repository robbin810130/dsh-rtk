# dsh-rtk
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/robbin810130/dsh-rtk)

> 社区维护的 DeepSeek Harness（DSH）插件；非 DeepSeek AI 官方项目。

将 shell 命令交给本机 [RTK](https://github.com/rtk-ai/rtk) 重写，在输出进入模型上下文之前压缩输出。

## 平台支持

| 平台 | 状态 | DSH 实际加载的 shell 工具 | 说明 |
| --- | --- | --- | --- |
| macOS (arm64/x64) | 已实机验证 | `bash` | Homebrew 用 `/opt/homebrew/bin/rtk` 或 `/usr/local/bin/rtk` |
| Linux (x64/arm64) | 已实机验证（CI） | `bash` | Homebrew on Linux、`/usr/local/bin`、`~/.local/bin`、`~/.cargo/bin` |
| Windows (x64) | 已实机验证（CI） | **`pwsh`** | 只接受 `.exe`（对 `.cmd`/`.bat` 需要 shell，存在注入风险，故拒绝） |

关键差异：DSH 在 `dsh-base` 里按平台开关 shell 工具 —— `tool-bash` 在 win32 上被 `disabled`，Windows 用的是 `tool-pwsh`。插件按**方言**匹配工具而不是写死 `bash`：POSIX 用单引号（`'\''` 转义），PowerShell 用单引号（`''` 转义）；单条命令的跳过语法也分别是 `DSH_RTK_DISABLE=1 <cmd>` 和 `$env:DSH_RTK_DISABLE='1'; <cmd>`。

环境来源也不一样：macOS/Linux 上 DSH 会读**登录 shell** 环境（所以 `~/.zshrc` 里的 `RTK_BIN` 有效），Windows 上直接继承**注册表用户环境变量**、不读任何 shell 配置（写进 `$PROFILE` 无效）。**Windows 的安装位置、环境变量与排障见 [docs/windows.md](docs/windows.md)。**

`.github/workflows/ci.yml` 在 ubuntu / macos / windows 三平台 × Node 22/24 上跑 `npm test`。

## 1.4.0：会话内自检 `/rtk`

不用退出重开、也不用翻日志，直接在会话里打一条命令：

```
/rtk              # 当前状态（默认）
/rtk status       # 同上
/rtk recheck      # 丢弃缓存重新探测 RTK —— 刚装好 rtk、又不想重启 DSH 时用
```

输出示例：

```
dsh-rtk 1.4.0 · darwin · 挂载 bash 工具（POSIX 引用）
状态：已生效 —— rtk 0.51.0 @ /opt/homebrew/bin/rtk（来源：discovered）
改写 12 次 · 无等价命令 3 次 · 未改写 0 次
配置：autoDiscover=true bin=（未设置） timeoutMs=3000 verbose=false statusFile=true
状态文件：/Users/<you>/.dsh/dsh-rtk/status.json
临时跳过改写：DSH_RTK_DISABLE=1 <命令>
```

没生效时它会把**原因和修复步骤**一并打出来（和启动日志里那条警告同源），所以"到底为什么没生效"不需要再猜。

实现上走 DSH 的 `ctx.commands.register()`，`commands` 服务按可选依赖注入：没组合该服务的 profile 里插件照常工作、只是没有这条命令。

## 更新记录

| 版本 | 要点 |
| --- | --- |
| [v1.3.2](docs/releases/v1.3.2.md) | [Windows 使用说明](docs/windows.md)（随包发布） |
| [v1.3.1](docs/releases/v1.3.1.md) | 升级未重启时不再谎报"已生效"（`doctor` 核对运行版本） |
| [v1.3.0](docs/releases/v1.3.0.md) | 多平台：Windows 上 DSH 用的是 `pwsh` 而非 `bash`，此前完全不触发 |
| [v1.2.1](docs/releases/v1.2.1.md) | `doctor` 用 pid 交叉核对状态文件，不再把陈旧记录当证据 |
| [v1.2.0](docs/releases/v1.2.0.md) | 安装即生效：零配置自动发现、不再静默失败、状态文件 + `doctor` |
| [v1.1.0](https://github.com/robbin810130/dsh-rtk/releases/tag/v1.1.0) | 改用 `tools/execute` 钩子，不再修改宿主源码 |

## 安装

**1. 装 RTK**（插件不自带，也不会替你下载）：

```bash
brew install rtk          # macOS / Linux；Windows 见 https://github.com/rtk-ai/rtk
rtk --version             # 确认可用
```

Windows 上确认 `rtk.exe` 的位置（winget/scoop/cargo 安装位置不同）：

```powershell
where.exe rtk
# 例：C:\Users\<you>\.cargo\bin\rtk.exe
```

**2. 装插件到正在使用的 profile**（桌面版通常是 `desktop`）：

```bash
dsh plugin --profile desktop add github:robbin810130/dsh-rtk#v1.4.0
```

本地安装包同理：

```bash
dsh plugin --profile desktop add /absolute/path/dsh-rtk-1.4.0.tgz
```

**3. 完全退出并重新打开 DSH**（macOS `Cmd+Q`，Windows 从托盘退出；只关窗口不会重新加载插件）。不要额外启动第二个 web 服务。

**4. 确认生效**：重开后**在任意会话里打 `/rtk`**，看到「状态：已生效」即可。三种自检方式的区别见[自检与排障](#自检与排障)。

RTK 装在非常规位置时，按下面任一方式指定即可（桌面版需写进 `~/.zshrc` 之类的登录 shell 配置——DSH 启动时会读取登录 shell 环境——然后完全重开 App）：

```bash
export RTK_BIN=/absolute/path/to/rtk        # macOS / Linux
```
```powershell
# Windows：必须是注册表用户环境（DSH 不读 shell 配置），设置后完全重启 DSH
[Environment]::SetEnvironmentVariable('RTK_BIN', 'C:\Users\<you>\.cargo\bin\rtk.exe', 'User')
# 或：setx RTK_BIN "C:\Users\<you>\.cargo\bin\rtk.exe"
```

> Windows 完整步骤（四种安装方式、自动发现清单、专有排障）见 [docs/windows.md](docs/windows.md)。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-rtk
  config:
    autoDiscover: true                       # 未显式配置时是否使用内置候选列表
    bin: /opt/homebrew/bin/rtk               # 显式指定；设置后即为唯一来源（Windows 例：C:\\path\\to\\rtk.exe）
    timeoutMs: 3000                          # 单次 rtk rewrite 上限
    verbose: false                           # 每次改写都打日志
    statusFile: true                         # 写 $DSH_HOME/dsh-rtk/status.json
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 设为 `false` 保留安装但不改写 |
| `bin` | `""` | 显式 RTK 绝对路径，优先级最高；不可用时报错而非回退 |
| `autoDiscover` | `true` | 仅在 `bin` 与 `RTK_BIN` 都未设置时生效 |
| `timeoutMs` | `3000` | `rtk rewrite` 单次超时 |
| `verbose` | `false` | 逐条改写日志 |
| `statusFile` | `true` | 关闭后不写状态文件 |

环境变量：

| 变量 | 效果 |
| --- | --- |
| `RTK_BIN=/absolute/path/to/rtk` | 显式指定 RTK；须对 DSH 服务进程可见 |
| `DSH_RTK_DISABLE=1` | 在服务环境中全局关闭改写 |
| `DSH_RTK_DISABLE=1 <command>` | 整条命令跳过改写（POSIX shell） |
| `$env:DSH_RTK_DISABLE='1'; <command>` | 整条命令跳过改写（PowerShell） |

解析优先级：`config.bin` → `RTK_BIN` → 内置候选列表（`autoDiscover` 为真时）。前两者一旦设置即为唯一来源。

## 自检与排障

三层自检，按"想知道什么"挑一个：

| 想知道 | 用什么 | 说明 |
| --- | --- | --- |
| **现在到底生效没有** | 会话里打 `/rtk` | 最快，不用退出重开；失败时直接给出原因与修复步骤 |
| 刚装好 rtk、不想重启 | `/rtk recheck` | 丢弃缓存重新探测，成功即刻开始改写 |
| 装在哪、宿主进程是什么、版本对不对 | `npm run doctor` | 核对二进制 / 各 profile 安装版本 / 运行中的宿主进程；`--json` 机器可读，退出码即结论 |
| 实际压缩效果 | `git status` 对照 | 见下 |

功能对照（在 Git 仓库里执行）：

```bash
git status                                # RTK 紧凑输出 = 已生效
```
```bash
DSH_RTK_DISABLE=1 git status              # macOS / Linux：原生输出 = 对照组
```
```powershell
$env:DSH_RTK_DISABLE='1'; git status      # Windows
```

普通终端里直接跑 `git status` 不经过 DSH 插件，两者不要混淆。

常见故障：

| 现象 | 原因与处理 |
| --- | --- |
| `/rtk` 或日志报「未找到可用的 RTK 二进制」 | 没装 RTK，或装在候选列表之外 → 安装后打 `/rtk recheck`，或用 `RTK_BIN` / `config.bin` 显式指定 |
| 报「RTK_BIN 不可用」 | 显式设置指向了不存在的路径 → 改对或删掉该项（插件不会静默换用别的二进制） |
| Windows 报「只接受 .exe/.com 可执行文件」 | 指到 `.cmd`/`.bat` 包装器了 → 指向真正的 `rtk.exe`（经 shell 转发命令文本有注入风险，故拒绝） |
| `doctor` 报「宿主用的 profile 没有安装 dsh-rtk」 | 插件装到了别的 profile → 用宿主实际使用的 profile 重装 |
| 一切正常但输出仍是原生格式 | 该命令没有 RTK 等价实现（RTK 退出码 1，属正常），或它是多行脚本；另外确认 `DSH_RTK_DISABLE` 未在服务环境中为 `1` |
| `doctor` 报「状态文件来自 pid X，不在当前运行中的宿主里」 | 那份记录来自上一次运行或手动执行插件，不代表本次已加载 → 重启 DSH 后重跑；确认无误也可直接删除 `$DSH_HOME/dsh-rtk/status.json` |
| `doctor` 报「运行中的宿主加载的是 vX，已安装 vY」 | 升级后还没重启 → 完全退出并重开 DSH（1.3.1 起可精确识别） |
| 只改了配置没重启 | profile 配置与环境变量都需要完全重启 DSH 才生效 |

安全说明：RTK 二进制会收到命令文本，因此自动发现只探测固定候选路径，绝不搜索 `PATH`；POSIX 下拒绝 world-writable、非本人/非 root 属主的文件，Windows 下只接受 `.exe`/`.com` 且绝不通过 shell 转发命令文本。插件自身不发送网络请求。RTK 可能缩短输出，精确取证时请使用跳过开关。

## 升级旧版

升级前备份 profile。只保留一个 `dsh-rtk` bundle；若仍安装 scoped 旧包 `@robbin810130/dsh-rtk`，先移除旧包。

1.0.x 曾直接修改宿主 bash 工具。升级到 1.1.0+ **不会自动还原这些修改**。若继续使用同一份旧宿主文件，先用对应版本的原包恢复工具文件，防止两套重写叠加。桌面版内置的原始 `app.asar` 不需要这一步。`~/.dsh/dsh-rtk/*.pristine` 是旧版残留备份，确认宿主文件干净后可以删除。

从 1.1.0 升到 1.2.0 无需额外操作：配置项向后兼容，新增项都有默认值。1.2.x 升到 1.3.0 同样无需改动 —— macOS/Linux 行为不变，Windows 从"完全不触发"变为可用。1.4.0 只是新增 `/rtk` 命令，无配置变更。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-rtk
```

新版不修改宿主文件，无需恢复源码；完全重启 DSH 后确认不再加载插件。状态文件可直接删除：`$DSH_HOME/dsh-rtk/status.json`。

## 开发与测试

```bash
npm install
npm test                                  # 打包冒烟 + 解析/方言/诊断单测 + 真实 DSH ToolRuntime 集成
npm run doctor                            # 本机自检
npm pack --pack-destination artifacts
# 可选：用本机真实 RTK 跑一遍改写
DSH_RTK_TEST_BIN=/absolute/path/to/rtk npm test     # Windows: $env:DSH_RTK_TEST_BIN='C:\...\rtk.exe'
```

- `test/resolve.mjs`：候选可信校验（含 Windows `.exe` 规则）、解析优先级、显式配置不回退、方言与引号、状态文件、二进制消失后的重新发现与故障上报、`/rtk` 命令的三种输入。全部通过注入 spawn 完成，三平台可跑。
- `test/runtime.mjs`：真实 DSH 0.2.0-rc.2 ToolRuntime，验证 `bash` 与 `pwsh` 两条路径的命令重写、冻结参数兼容、权限拒绝、退出码、禁用开关及监听释放；并组合**真实的** `@deepseek-ai/dsh-commands` 验证 `/rtk` 定义能通过注册表校验、且随插件卸载消失。
- `scripts/doctor.mjs`：`npm run doctor` 的实现，可 `--json` 输出。
- `.github/workflows/ci.yml`：ubuntu/macos/windows × Node 22/24 矩阵。

`patch-rtk.mjs` 和 `restart-dsh.sh` 是旧版救援工具，保留用于旧宿主恢复；**不用于新版桌面 DSH 安装或重启**。

## License

[MIT](LICENSE)
