# 安装与机器入网

## 安装 CLI 和可选 Skill

当前支持 macOS / Linux 的 arm64、amd64，需要 Node.js ≥ 22.20.0 和 npm。

```bash
npm install -g @reus-able/kioku-net
kioku --help
kioku skill install --runtime codex
```

Skill 安装默认选择 `kioku`，尚未初始化和普通节点均可安装。`--runtime` 支持 `codex`、`hermes-agent`、`pi`、`universal`；按用户实际运行器选择。默认全局安装，可用 `--scope project` 安装到当前工作目录。文件安装完成后，按运行器的加载规则确认 Skill 可见；不等同于已经加载或执行。

安装器通过 `npx skills@1.7.2` 分发当前 CLI 包内的 Skill，需要可用的 npm 网络或缓存。通常不需要 `--source`；它用于显式选择其他可信仓库或本地 Skill 源，不改变目标机器的网络配置。

已有 Hub 上需要 Leader 整理能力时，用户可另外执行：

```bash
kioku skill install --runtime hermes-agent --skill kioku-curate
```

该选择要求已经初始化为 Hub；其任务与调度由用户和运行器配置。通用指南不创建或执行整理任务。

## 选择建立或加入网络

默认安装根为 `~/.kiokunet`，包含 `data/`、`config/`、`state/`、`views/`、`bin/` 和 `logs/`。自定义使用 `--home /absolute/install-root`；不要把 `config/` 当作安装根。无需设置 `--root`：它只能是安装根内的 `data`。当前不提供旧版目录布局的自动迁移。

先确认这台机器要建立新网络还是加入已有网络。以下地址和路径是示例，执行前替换为实际值。

### 新建 Hub

```bash
kioku init --address 192.0.2.10:22000 --json
kioku invite --out /absolute/exchange/node.invite.json --json
```

Hub 地址必须能从目标节点固定访问。管理 API 保持回环地址；跨机器开放的是同步 TCP 端口。不要为排障暴露管理 API。端口冲突时可在 `init` / `join` 设置 `--gui-port` 和 `--listen-port`；Hub 的对外地址应与实际同步监听端口匹配。

### 加入已有网络

在新节点上接收邀请并执行：

```bash
kioku join --invite /absolute/exchange/node.invite.json \
  --out /absolute/exchange/node.receipt.json --json
```

把回执传回 Hub，在 Hub 上执行：

```bash
kioku enroll --receipt /absolute/exchange/node.receipt.json --json
```

`join` 只完成节点侧准备，Hub 接受回执后才建立共享关系。机器邀请不需要来源 ID，也不自动创建来源。随后按 [来源与工作区](workspaces.md) 接入 Agent。

## 服务方式与依赖

`init` / `join` 默认使用 `--service native`：macOS 使用登录用户的 LaunchAgent；Linux 使用 systemd user service，退出登录后运行需要 linger。不能注册服务时根据错误处理，不把初始化失败报告为成功。

临时运行可显式选择 `--service manual`，然后执行 `kioku service start --json`。manual 不注册系统服务，退出登录或重启后不保证持续运行。后台管理同步、来源登记和 shared 副本刷新，不管理 Agent 进程。

CLI 自动寻找或下载并校验 Syncthing；也可预先执行 `kioku deps install --json`。初始化后用 `kioku status --json` 检查实际服务与连接状态，故障处理见 [诊断与运行](operations.md)。
