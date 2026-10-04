# Windows 使用说明

本页只讲 Windows 特有的部分。通用安装、配置项与排障见 [README](../README.md)。

Windows 与 macOS 有一条**根本差异**，先看完这段能省掉大部分折腾：

| | macOS / Linux | Windows |
| --- | --- | --- |
| DSH 实际加载的 shell 工具 | `bash` | **`pwsh`** |
| DSH 服务进程的环境从哪来 | 启动时读取**登录 shell** 环境（所以 `~/.zshrc` 里的 `RTK_BIN` 有效） | **直接继承 Windows 注册表里的用户环境变量**；DSH 在 win32 上不读任何 shell 配置 |
| 插件接受的 RTK 形态 | 任意可执行文件 | 只接受 **`.exe` / `.com`** |

最后一条的直接后果：**把 `RTK_BIN` 写进 PowerShell 的 `$PROFILE`、或在会话里 `$env:RTK_BIN=...`，对 DSH 一律无效** —— 那些只影响交互式 PowerShell，而 DSH 是从资源管理器/开始菜单启动的，继承的是注册表环境。请用下面的 `setx` 或「系统属性 → 环境变量」。

## 1. 安装 RTK

任选一种，装完记下 `rtk.exe` 的**绝对路径**：

```powershell
# winget（会放进 WinGet Links，通常已在 PATH）
winget install rtk

# scoop
scoop install rtk

# Cargo
cargo install rtk

# 或从 https://github.com/rtk-ai/rtk 的 release 里下载
# rtk-x86_64-pc-windows-msvc.zip，解压到任意固定目录（如 C:\Tools\rtk\）
```

确认可用并拿到路径：

```powershell
rtk --version
where.exe rtk          # 例：C:\Users\<you>\.cargo\bin\rtk.exe
```

> 必须指向真正的 `rtk.exe`。如果 `where.exe` 给出的是 `.cmd`/`.bat` 包装器（某些 npm/scoop shim 会这样），插件会**主动拒绝**：经 shell 转发命令文本存在注入风险。请改用同一目录下的 `rtk.exe`，或直接下载官方 zip 手动解压。

## 2. 安装插件

```powershell
dsh plugin --profile desktop add github:robbin810130/dsh-rtk#v1.3.2
```

## 3. 让插件找到 RTK

### 方式 A：什么都不做（推荐）

插件默认按下面的固定顺序自动发现，全部命中常见安装位置：

```
%USERPROFILE%\.cargo\bin\rtk.exe
%LOCALAPPDATA%\Microsoft\WinGet\Links\rtk.exe
%USERPROFILE%\scoop\shims\rtk.exe
%ProgramData%\chocolatey\bin\rtk.exe
%ProgramFiles%\rtk\rtk.exe
```

装在别处才需要方式 B 或 C。插件**不会搜索 PATH**（RTK 会拿到命令原文，这是刻意的安全取舍）。

### 方式 B：设置用户级环境变量（显式指定）

```powershell
setx RTK_BIN "C:\Users\<you>\.cargo\bin\rtk.exe"
```

- `setx` 写的是注册表用户环境，**新启动的进程**才可见 → 必须完全退出并重开 DSH。
- 也可用「系统属性 → 环境变量」图形界面设置，效果相同。
- 想取消：`reg delete HKCU\Environment /v RTK_BIN /f`，再重启 DSH。

### 方式 C：写进 profile 配置

在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里：

```yaml
- id: dsh-rtk
  config:
    # 单引号或正斜杠；双引号里反斜杠是转义字符，C:\Users 会被当成 \U 而报错
    bin: 'C:\Users\<you>\.cargo\bin\rtk.exe'
    # 等价写法：bin: C:/Users/<you>/.cargo/bin/rtk.exe
```

`bin` 一旦设置即为唯一来源：写错会明确报错并停止改写，不会静默换成别的二进制。

## 4. 重启并验证

**完全退出 DSH**（托盘图标 → 退出；只关窗口不会重新加载插件）后重新打开，然后：

```powershell
node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-rtk\scripts\doctor.mjs"
```

期望结果：`[1]` 显示 `✅ ...\rtk.exe（rtk x.y.z）`，`[3]` 显示宿主 pid 匹配、版本一致，结论为「配置就绪」。注意 `[3]` 里 **Windows 不会显示 `RTK_BIN=...`**——Windows 无法读取其他进程的环境变量，这属正常，插件用的是它自己进程里的值。

在 DSH 会话里做功能对照：

```powershell
git status                              # RTK 紧凑输出 = 已生效
$env:DSH_RTK_DISABLE='1'; git status    # 原生输出 = 对照组
```

## 5. Windows 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 日志出现「RTK_BIN 不可用」 | 路径写错，或仍指向 `.cmd`/`.bat` → 换成真正的 `rtk.exe` 绝对路径 |
| `setx` 之后仍然「未找到可用的 RTK」 | 没完全重启 DSH（新环境变量只对新进程生效） |
| 把 `RTK_BIN` 写进 `$PROFILE` 却无效 | Windows 上 DSH 不读 shell 配置 → 改用 `setx` 或「系统属性 → 环境变量」 |
| 路径含空格（如 `C:\Program Files\...`） | 不用管，插件会按 PowerShell 规则引用（单引号、内部单引号双写） |
| doctor 报 `[3]` 里没有 `RTK_BIN` | 正常：Windows 读不到子进程环境；以 `[1]` 与状态记录为准 |
| doctor 报「运行中的宿主加载的是 vX，已安装 vY」 | 升级后还没重启 → 完全退出并重开 DSH |
| 装了 winget 版但没被发现 | `where.exe rtk` 看实际落点，不在候选清单里就用方式 B/C 显式指定 |

## 6. 卸载 / 回滚

```powershell
dsh plugin --profile desktop remove dsh-rtk
# 回滚到上一版：
dsh plugin --profile desktop add https://github.com/robbin810130/dsh-rtk/releases/download/v1.3.1/dsh-rtk-1.3.1.tgz
```

插件不修改宿主文件，卸载后完全重启 DSH 即可；残留仅剩状态文件 `%USERPROFILE%\.dsh\dsh-rtk\status.json` 与（若设置过）`RTK_BIN` 环境变量。
