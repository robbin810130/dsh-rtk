# dsh-rtk
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/robbin810130/dsh-rtk)

> 社区维护的 DeepSeek Harness（DSH）插件；非 DeepSeek AI 官方项目。

将 bash 命令交给本机 [RTK](https://github.com/rtk-ai/rtk) 重写，在输出进入模型上下文之前压缩输出。

## 1.1.0：新版 DSH 兼容

使用 DSH 的 `tools/execute` around-dispatch 接口，不再查找全局 npm 安装目录、修改宿主源码或依赖源码锚点。支持桌面版 `app.asar` 安装，覆盖注册为 `bash` 的普通与 persistent 工具。

已验证 DSH **0.2.0-rc.2** 的 npm ToolRuntime 和 macOS 桌面版内置 ToolRuntime，以及 RTK **0.45.0**。其他版本和 Windows/Linux 桌面环境尚未实机验证。

- DSH 的前置权限检查仍按原始命令执行；重写后的命令交给原 bash 工具，其沙箱、权限升级、超时和工作目录逻辑保持执行。
- 替换冻结参数快照，不修改输入对象；执行完成后恢复原参数用于后续结果观察。
- 插件卸载时由 Cordis 自动释放事件监听。
- 只执行显式配置的绝对路径 `RTK_BIN`，不从 PATH 搜索可执行文件。
- RTK 返回 0 或 3 且有输出时使用重写建议；拒绝、未知命令、进程错误或超时回退原命令。退出码 3 仅是 RTK 建议状态，不能代替 DSH 的权限检查。

## 安装

先安装 RTK，并在 **DSH 服务进程的环境**中设置路径：

```bash
# Apple Silicon Homebrew 的典型路径
launchctl setenv RTK_BIN /opt/homebrew/bin/rtk
```

桌面应用须完全退出并重新启动以继承环境。已运行的应用不会自动继承新环境。

本地安装包：

```bash
dsh plugin --profile web add /absolute/path/dsh-rtk-1.1.0.tgz
```

随后通过当前使用的桌面应用或服务管理器重启 DSH。不要额外启动第二个 web 服务。

GitHub 安装：

```bash
dsh plugin --profile desktop add github:robbin810130/dsh-rtk#v1.1.0
```

请使用实际运行的 profile 名称；桌面版通常是 `desktop`，web 服务通常是 `web`。

## 升级旧版

升级前备份 profile。只保留一个 `dsh-rtk` bundle；若仍安装 scoped 旧包 `@robbin810130/dsh-rtk`，先移除旧包。

旧版曾直接修改宿主 bash 工具。升级到新插件**不会自动还原这些修改**。若继续使用同一份旧宿主文件，先用对应版本的原包恢复工具文件，防止两套重写叠加。不要把旧版本备份覆盖到新版 DSH 上。桌面版内置的原始 `app.asar` 不需要这一步。

## 验证和禁用

在 Git 仓库中让 DSH 的 bash 工具执行 `git status`，应得到 RTK 的紧凑输出。普通终端直接运行 `git status` 不经过 DSH 插件。

需要完整文件、精确 diff 或其他原始输出时：

```bash
DSH_RTK_DISABLE=1 git diff
```

| 设置 | 效果 |
| --- | --- |
| `RTK_BIN=/absolute/path/to/rtk` | 指定受信任的本机 RTK |
| `DSH_RTK_DISABLE=1` | 在服务环境中全局关闭重写 |
| `DSH_RTK_DISABLE=1 <command>` | 整条命令跳过重写，包括复合命令 |

保留安装但不启用，可在 profile 的 `cordis.patch.yml` 中配置：

```yaml
- config:
    - id: dsh-rtk
      enabled: false
```

RTK 二进制会收到命令文本，只应配置可信程序。插件自身不发送网络请求。RTK 可能缩短输出，精确取证时应使用禁用开关。

## 卸载

```bash
dsh plugin --profile web remove dsh-rtk
```

新版不修改宿主文件，无需恢复源码；完全重启 DSH 后确认不再加载插件。

## 开发与测试

```bash
npm install
npm test
npm pack --pack-destination artifacts
# 可选：验证本机 RTK
DSH_RTK_TEST_BIN=/absolute/path/to/rtk npm test
```

`test/runtime.mjs` 使用真实 DSH 0.2.0-rc.2 ToolRuntime 验证命令重写、冻结参数兼容、权限拒绝、退出码、禁用开关及监听释放。测试工具返回收到的命令，不调用模型或执行业务命令。

`patch-rtk.mjs` 和 `restart-dsh.sh` 是旧版救援工具，保留用于旧宿主恢复；**不用于新版桌面 DSH 安装或重启**。

## License

[MIT](LICENSE)
