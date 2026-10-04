# dsh-rtk
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/robbin810130/dsh-rtk)

> 社区维护的 DeepSeek Harness（DSH）插件；非 DeepSeek AI 官方项目。

将 bash 命令交给本机 [RTK](https://github.com/rtk-ai/rtk) 重写，在输出进入模型上下文之前压缩输出。

## 1.2.1：自检不撒谎

- `npm run doctor` 用 pid 交叉核对状态文件：只有状态文件的 pid 出现在运行中的宿主进程里，才算"本次运行确实加载了插件"；陈旧记录会明确标为「来自上一次运行或手动执行插件」，不再被当成生效证据。
- 排障表补充对应条目。

## 1.2.0：安装即生效

1.1.0 用 `tools/execute` 钩子替换了"改宿主源码"的老做法，但**装好之后是否真的生效，插件一个字都不说**：只要 DSH 服务进程的环境里没有 `RTK_BIN`，插件就安静地什么都不做。1.2.0 修掉这一整类问题：

- **零配置自动发现**：不再强制要求 `RTK_BIN`。未显式配置时，插件按固定候选列表（`/opt/homebrew/bin/rtk`、`/usr/local/bin/rtk`、`/home/linuxbrew/.linuxbrew/bin/rtk`、`/usr/bin/rtk`、`~/.local/bin/rtk`、`~/.cargo/bin/rtk`）查找 RTK，且仍不搜索 `PATH`。
- **每个候选都要过可信校验**：解析真实路径后必须是常规文件、非 world-writable、属主为 root 或当前用户、所在目录不可被他人写、可执行，并且 `--version` 必须返回 `rtk <版本>`。任何一条不满足就跳过并记录原因。
- **不再静默失败**：解析成功会在启动时打一行 `[dsh-rtk] 已生效 — rtk x.y.z @ /path（来源：…）`；解析失败或运行中出错会打**带修复步骤的警告**，而不是无声地当个摆设。RTK 明确"没有等价命令"（退出码 1、无输出）属正常路径，不报警。
- **不再静默替换**：显式配置的 `bin` / `RTK_BIN` 具有最高优先级；如果它不可用，插件会报错并停止改写，而不会偷偷换成另一个二进制。
- **状态文件 + 自检命令**：插件把解析结果与改写计数写入 `$DSH_HOME/dsh-rtk/status.json`，`npm run doctor` 一次性核对"二进制、安装位置、运行中的宿主进程"。

## 安装

**1. 装 RTK**（插件不自带，也不会替你下载）：

```bash
brew install rtk          # macOS；其他平台见 https://github.com/rtk-ai/rtk
rtk --version             # 确认可用
```

**2. 装插件到正在使用的 profile**（桌面版通常是 `desktop`）：

```bash
dsh plugin --profile desktop add github:robbin810130/dsh-rtk#v1.2.1
```

本地安装包同理：

```bash
dsh plugin --profile desktop add /absolute/path/dsh-rtk-1.2.1.tgz
```

**3. 完全退出并重新打开 DSH**（`Cmd+Q`；只关窗口不会重新加载插件）。不要额外启动第二个 web 服务。

**4. 确认生效**：

```bash
npm run doctor            # 仓库内自检：二进制 / 安装位置 / 运行中的宿主进程
```

或在 DSH 日志里找启动那一行：

```
[dsh-rtk] 已生效 — rtk 0.51.0 @ /opt/homebrew/bin/rtk（来源：discovered，profile：desktop）
```

RTK 装在非常规位置时，按下面任一方式指定即可（桌面版需写进 `~/.zshrc` 之类的登录 shell 配置——DSH 启动时会读取登录 shell 环境——然后完全重开 App）：

```bash
export RTK_BIN=/absolute/path/to/rtk
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-rtk
  config:
    autoDiscover: true                       # 未显式配置时是否使用内置候选列表
    bin: /opt/homebrew/bin/rtk               # 显式指定；设置后即为唯一来源
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
| `DSH_RTK_DISABLE=1 <command>` | 整条命令跳过改写（含复合命令） |

解析优先级：`config.bin` → `RTK_BIN` → 内置候选列表（`autoDiscover` 为真时）。前两者一旦设置即为唯一来源。

## 验证与排障

在 Git 仓库中让 DSH 的 bash 工具执行 `git status`，应得到 RTK 的紧凑输出（对照：`DSH_RTK_DISABLE=1 git status` 是原生输出）。普通终端直接运行 `git status` 不经过 DSH 插件。

`npm run doctor` 会逐项核对并给出结论；`npm run doctor -- --json` 输出机器可读结果。常见故障：

| 现象 | 原因与处理 |
| --- | --- |
| 日志出现「未生效：未找到可用的 RTK 二进制」 | 没装 RTK，或装在候选列表之外 → 安装或设置 `RTK_BIN` |
| 日志出现「RTK_BIN 不可用」 | 显式设置指向了不存在的路径 → 改对或删掉该项 |
| `doctor` 报「宿主用的 profile 没有安装 dsh-rtk」 | 插件装到了别的 profile → 用宿主实际使用的 profile 重装 |
| 一切正常但输出仍是原生格式 | 该命令没有 RTK 等价实现（RTK 退出码 1，属正常），或它是多行脚本；另外确认 `DSH_RTK_DISABLE` 未在服务环境中为 `1` |
| doctor 报「状态文件来自 pid X，不在当前运行中的宿主里」 | 那份记录来自上一次运行或手动执行插件，不代表本次已加载 → 重启 DSH 后重跑；确认无误也可直接删除 `$DSH_HOME/dsh-rtk/status.json` |
| 只改了配置没重启 | profile 配置与环境变量都需要完全重启 DSH 才生效 |

安全说明：RTK 二进制会收到命令文本，因此自动发现只探测上表那批固定路径，绝不搜索 `PATH`，并拒绝 world-writable、非本人/非 root 属主的文件；插件自身不发送网络请求。RTK 可能缩短输出，精确取证时请使用 `DSH_RTK_DISABLE=1`。

## 升级旧版

升级前备份 profile。只保留一个 `dsh-rtk` bundle；若仍安装 scoped 旧包 `@robbin810130/dsh-rtk`，先移除旧包。

1.0.x 曾直接修改宿主 bash 工具。升级到 1.1.0+ **不会自动还原这些修改**。若继续使用同一份旧宿主文件，先用对应版本的原包恢复工具文件，防止两套重写叠加。桌面版内置的原始 `app.asar` 不需要这一步。`~/.dsh/dsh-rtk/*.pristine` 是旧版残留备份，确认宿主文件干净后可以删除。

从 1.1.0 升到 1.2.0 无需额外操作：配置项向后兼容，新增项都有默认值。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-rtk
```

新版不修改宿主文件，无需恢复源码；完全重启 DSH 后确认不再加载插件。状态文件可直接删除：`$DSH_HOME/dsh-rtk/status.json`。

## 开发与测试

```bash
npm install
npm test                                  # 打包冒烟 + 解析/诊断单测 + 真实 DSH ToolRuntime 集成
npm run doctor                            # 本机自检
npm pack --pack-destination artifacts
# 可选：用本机真实 RTK 跑一遍改写
DSH_RTK_TEST_BIN=/absolute/path/to/rtk npm test
```

- `test/resolve.mjs`：候选可信校验、解析优先级、显式配置不回退、状态文件、二进制消失后的重新发现与故障上报。
- `test/runtime.mjs`：真实 DSH 0.2.0-rc.2 ToolRuntime，验证命令重写、冻结参数兼容、权限拒绝、退出码、禁用开关及监听释放。
- `scripts/doctor.mjs`：`npm run doctor` 的实现，可 `--json` 输出。

`patch-rtk.mjs` 和 `restart-dsh.sh` 是旧版救援工具，保留用于旧宿主恢复；**不用于新版桌面 DSH 安装或重启**。

## License

[MIT](LICENSE)
