# dsh-rtk

DSH 插件：每次服务启动时自动把 RTK（Runtime Token Keeper）补丁应用到 bash 工具包，
让**所有 agent 预设**（标准 / code / cordis / 极简）的命令输出都经过 `rtk` 压缩，节省 token。

## 为什么需要它

DSH 的 `bash` 工具（`@deepseek-ai/dsh-tool-bash` 与
`@deepseek-ai/dsh-tool-bash-persistent`）位于 node_modules。直接修改它们可以工作，
但 DSH 更新/重装会覆盖。本插件在**每次服务启动时自动重新应用补丁**（幂等，锚定内容
标记），因此 DSH 更新后无需手动操作——下次重启即自愈。

## 安装

```bash
dsh plugin --profile web add file:/Users/Robbin/Documents/WorkSapce/DeepSeek/DSH\ 插件/rtk-token-keeper/dsh-rtk
```

`dsh plugin add` 会把包安装进 `~/.dsh/profiles/web/`，识别 `dsh.bundle.patch`
声明后把它加入 bundle 层栈。重启 dsh web 服务后生效：

```bash
kill "$(lsof -tiTCP:3080 -sTCP:LISTEN)"   # launchd 会自动重启
```

> 也可以发布到 npm 后用 `dsh plugin --profile web add dsh-rtk@<version>` 安装。

## 卸载

```bash
dsh plugin --profile web remove dsh-rtk
```

恢复被补丁修改的两个工具文件（恢复到 `.backup/` 里的 pristine 副本）：

```bash
node "/Users/Robbin/Documents/WorkSapce/DeepSeek/DSH 插件/rtk-token-keeper/patch-rtk.mjs" revert
```

## 工作原理

插件是标准的 cordis 插件（`Config` / `apply` / `inject` / `name`）。`apply()` 在服务
启动（任何 agent 会话挂载 bash 工具之前）执行：

1. 定位 `@deepseek-ai/dsh` 安装根（`DSH_HOME` 或已知路径）
2. 对 `dsh-tool-bash` 与 `dsh-tool-bash-persistent` 检查内容标记
3. 未打补丁则应用（与 `patch-rtk.mjs` 完全相同的编辑，逐字节一致）

`cordis.patch.yml` 是 `dsh.bundle.patch` 层：`dsh plugin add` 时被识别并加入
bundle 栈，启动时把插件行插入组合。

## 运行时开关

| 开关 | 效果 |
| --- | --- |
| `DSH_RTK_DISABLE=1`（环境变量） | 全局关闭 RTK 重写 |
| 命令前加 `DSH_RTK_DISABLE=1` | 单条命令不重写（任意位置均可，含 `&&` 后） |
| `RTK_BIN=/path/to/rtk` | 覆盖 rtk 二进制路径 |

## 插件配置（可选）

在 `~/.dsh/profiles/web/cordis.patch.yml` 中覆盖：

```yaml
- config:
    - id: dsh-rtk
      enabled: false      # 关闭启动时自动打补丁
      verbose: true       # 每次启动都打印补丁状态
```

## 开发

- `lib/index.js` —— cordis 插件本体（补丁逻辑内联，自包含，仅依赖 node 内置 + schemastery）
- `cordis.patch.yml` —— bundle patch 层（插件行）
- 补丁编辑定义与仓库根目录的 `patch-rtk.mjs` 保持逐字节一致（有对比脚本验证）
