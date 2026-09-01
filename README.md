# dsh-rtk
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/robbin810130/dsh-rtk)

> 社区维护的 DeepSeek Harness（DSH）插件；非 DeepSeek AI 官方项目。

`dsh-rtk` 在 DSH 服务启动时将 RTK（[Runtime Token Keeper](https://github.com/rtk-ai/rtk)）接入 bash 工具：可匹配的命令会先经 `rtk rewrite` 转换，使终端输出在进入 LLM 上下文前得到压缩，从而减少 token 消耗。

它覆盖 macOS/Linux POSIX 环境中的两个 DSH 工具包：

| DSH 工具包 | 覆盖的预设 |
| --- | --- |
| `@deepseek-ai/dsh-tool-bash` | standard / code / cordis |
| `@deepseek-ai/dsh-tool-bash-persistent` | minimal |

## 安装

### 前提

1. 安装 RTK：`brew install rtk-ai/tap/rtk`（或从 [RTK Releases](https://github.com/rtk-ai/rtk) 安装）。
2. 设置 **RTK 的绝对路径**。插件刻意不从 `PATH` 查找 RTK，以避免 DSH 服务执行意外二进制：

```bash
# Apple Silicon Homebrew 的典型路径；请按你的安装位置调整
launchctl setenv RTK_BIN /opt/homebrew/bin/rtk
```

### 通过 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:robbin810130/dsh-rtk#v1.0.2
```

安装后重启 dsh web 服务，使 bundle 在启动阶段加载：

```bash
kill "$(lsof -tiTCP:3080 -sTCP:LISTEN)"
```

> `dsh plugin` 使用 pnpm 管理 profile 依赖；GitHub 直装不要求 npm 账号。未来发布到 npm 后，也可使用 `dsh plugin --profile web add @robbin810130/dsh-rtk@<version>`。

## 验证

在有 Git 仓库的目录调用 bash 工具：

```bash
git status
# 预期：RTK 的紧凑输出，例如：
# * On branch main
# A  example.txt
```

关闭单条命令的重写以获得原始输出：

```bash
DSH_RTK_DISABLE=1 git status
```

## 权限、风险与兼容性

### 文件写入与完整性边界

DSH 当前没有公开的 bash 命令预执行拦截接口；因此此插件以**内容锚点补丁**方式修改已安装的：

- `@deepseek-ai/dsh-tool-bash/lib/index.js`
- `@deepseek-ai/dsh-tool-bash-persistent/lib/index.js`

每次启动会读取两个文件；仅当所有已知上游锚点都匹配时才写入。锚点不匹配（通常表示 DSH 更新）时，插件会拒绝修改，不会猜测兼容性。

- 写入使用同目录临时文件后 `rename` 的原子替换，避免半写入的工具文件。
- 补丁前的副本保存到 `~/.dsh/dsh-rtk/`（或 `$XDG_STATE_HOME/dsh-rtk/`），**不会**写入 npm/pnpm 安装目录。
- 需要对 DSH 全局安装目录拥有写权限；只读安装、Docker 镜像或 DSH 版本不匹配时不会生效。
- 这是修改宿主包的集成方案，不适用于 Windows PowerShell 工具；Windows/macOS/Linux 兼容性应在安装前自行验证。

### 外部进程与数据

每个可重写的 bash 命令都会作为参数传给你显式配置的 `RTK_BIN rewrite <command>`。因此 RTK 二进制能够看到命令文本；仅设置为你信任的本地 RTK 可执行文件。插件不发送网络请求、不收集遥测、不读取命令输出以外的数据。

## 配置与退出开关

| 设置 | 效果 |
| --- | --- |
| `RTK_BIN=/absolute/path/to/rtk` | 必需：明确指定受信任的 RTK 二进制 |
| `DSH_RTK_DISABLE=1` | 全局关闭重写 |
| `DSH_RTK_DISABLE=1 <command>` | 单条或复合命令关闭重写 |

要让插件在 profile 中保持安装但不自动应用补丁，可在 `~/.dsh/profiles/web/cordis.patch.yml` 添加：

```yaml
- config:
    - id: dsh-rtk
      enabled: false
```

## 卸载与恢复

```bash
dsh plugin --profile web remove @robbin810130/dsh-rtk
```

移除插件不会自动恢复宿主工具文件。需要恢复时，请从 `~/.dsh/dsh-rtk/` 备份手工还原，或使用本仓库的开发者工具：

```bash
node patch-rtk.mjs revert
```

## 开发与测试

- `dsh-rtk/lib/index.js`：插件入口与补丁逻辑
- `cordis.patch.yml`：DSH bundle 入口
- `patch-rtk.mjs`：开发/救援用的双目标 `apply`、`check`、`revert` CLI

发布前至少运行：

```bash
node --check dsh-rtk/lib/index.js
npm pack --dry-run
```

## License

[MIT](LICENSE)
