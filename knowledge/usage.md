# KiokuNet 使用与运维指南

[返回项目首页](../README.md) · [实现与验收](implementation.md) · [发布指南](releasing.md)

本页保留完整安装、接入、身份绑定、备份恢复和运维步骤。命令参数以 `kioku --help` 为准。

## 安装

前置：Node.js **≥ 22.20**、npm，macOS 或使用 systemd 的 Linux，arm64/amd64。解包依赖需要 `unzip`；Linux 的 Syncthing 包还需要 `tar`。CLI 自动寻找或下载 Syncthing / rclone，不安装 Node 或系统包管理器。

在本仓库执行：

```bash
npm ci
npm run build
npm pack
npm install -g ./kiokunet-0.1.0.tgz
kioku --help
```

不安装全局命令时，可以用 `node /绝对路径/KiokuNet/dist/cli.js`。Agent 执行 Skill 时须能从 PATH 找到 `kioku`。离线部署可预置依赖，再设置 `KIOKU_SYNCTHING`、`KIOKU_RCLONE` 为可执行文件的绝对路径。

## 发布 CLI

维护者使用 `npm run release -- --dry-run` 预览，`npm run release -- --draft` 上传草稿，`npm run release` 发布。脚本从包版本生成 `v<version>` tag，验证安装包与 SHA-256 附件；版本更新使用 `npm run release:version -- patch`，再提交并推送。完整步骤与失败重试见 [发布指南](releasing.md)。

## 首次接入

下列 `/srv`、IP 和用户名都是示例，先替换为实际可写目录及固定地址。默认私有配置目录为 `~/.config/kiokunet`，用 `KIOKU_HOME` 或 `--home` 改写；它与知识目录不能重叠。一台机器使用一个配置目录管理多个身份。

在 Linux Hub：

```bash
kioku init --agent hermes-main --root /srv/kiokunet --address 192.0.2.10:22000
kioku invite --agent codex-mac --out /tmp/codex-mac.invite.json
```

Hub 需允许节点访问 TCP 22000；不暴露 Syncthing GUI/API。CLI 将 GUI 绑定回环地址，关闭公共发现、局域网发现、中继及自动 NAT。Linux 启动原生服务前会检查并尝试启用当前用户的 linger；权限不足会报错，此时管理员执行 `loginctl enable-linger <用户名>`，再重试 `kioku service start`。

通过可信渠道把邀请文件传到 Mac，在 Mac 执行：

```bash
kioku join --invite /tmp/codex-mac.invite.json \
  --root /Users/reuszeng/kiokunet --out /tmp/codex-mac.receipt.json
```

把回执传回 Hub，在 Hub 执行：

```bash
kioku enroll --receipt /tmp/codex-mac.receipt.json
kioku status --json
kioku doctor --json
```

`join` 的 `awaiting-hub` 表示尚需 Hub 登记；`enroll` 的 `registered` 表示登记成功，连接和文件收敛以 `status` 为准。邀请和回执都带签名，邀请本身仍需要可信传递。重复接入不会重建身份或清空知识。

同机增加身份：先在 Hub 为新 ID 生成邀请，再在目标机器执行 `kioku agent add --invite FILE --out RECEIPT`，最后回 Hub `enroll`。若目标机器就是 Hub，`agent add` 会直接完成本地登记，无需再次 `enroll`。

## Agent 与 Skill

普通机器：

```bash
kioku skill install --runtime codex
export KIOKU_AGENT_ID=codex-mac
kioku context --json
```

Hub：

```bash
kioku skill install --runtime hermes-agent
export KIOKU_AGENT_ID=hermes-main
kioku context --json
```

安装器薄封装 `npx -y skills@1.7.2 add`，默认从当前安装包分发静态 Skill，支持 `--source` 指定仓库、`--scope project` 指定当前项目范围。Hub 安装 `kioku-memory` 和 `kioku-curate`，普通节点只安装 `kioku-memory`。更新由 `skills` 管理；本机身份和路径保存在独立配置里。

将身份环境变量绑定到具体 Agent 的执行环境，不要把多实例绑定为同一个 ID。只有一个活跃本地实例时可自动识别；多个实例必须传 `--agent` 或环境绑定；两者冲突时报错。`--agent` 用于管理命令时表示操作对象。

在 Hermes 自行配置定时任务，并确保其实际 profile 能加载这两个 Skill、PATH 能找到 CLI。任务说明可用：

> 使用 kioku-curate。KiokuNet 身份为 hermes-main，先运行 kioku context --agent hermes-main --json；按返回路径增量整理 Raw，自动提炼公共知识并保存进度，无需人工确认。

KiokuNet 不生成 Hermes cron、不调用模型、不接管任务重试。`status.curation` 仅展示 Skill 写入的最近进度，不代表实时任务状态。五分钟知识流转目标需要结合 Hermes 调度频率实测。

目录约定：

```text
知识根目录/
├── agents/<agent_id>/raw/   # 所属 Agent 只追加；Hub 汇集各来源
└── shared/                 # Leader 维护，节点接收副本
    ├── INDEX.md
    ├── profile/
    ├── projects/
    └── topics/
私有配置目录/               # 不同步、不进入知识快照
├── config.json             # 身份、设备、配对及基础设施配置
├── identity.pem            # 配对签名私钥
├── syncthing/              # 同步凭据和本地数据库
├── rclone.conf             # 由凭据向导创建
└── curation/               # 整理进度、互斥锁、公共文档旧版本
```

Raw 更正通过新增记录完成；附件保存原文件和哈希。每个 Raw 只有一个写入节点，shared 只有 Leader 写入。同步方向和 Skill 约定不构成同一系统用户下的强权限隔离。

## 备份与灾难恢复

Hub 配置 rclone 凭据和目标：

```bash
kioku backup credentials
kioku backup configure --target remote:bucket/kiokunet
kioku backup run
kioku backup list --json
kioku backup restore --snapshot <快照ID> --target /srv/kiokunet-restored
```

也可用 `--config /私有路径/rclone.conf` 提供已有凭据；本地目录可作为测试备份目标。原生服务每天触发一次备份，保留 30 天已完成快照。备份先下载校验，再写完成标记。恢复要求新目录并校验全部文件；不会自动覆盖在线数据或切换同步根目录。

若原 Hub 的私有配置完全丢失：在新 Hub `init`，配置相同存储目标和新凭据，然后：

```bash
kioku backup networks --json
kioku backup list --network <旧网络UUID> --json
kioku backup restore --network <旧网络UUID> \
  --snapshot <快照ID> --target /srv/recovered-old-network
```

这样能找回 Raw/shared，但不会恢复设备私钥或自动接续旧网络。请先检查恢复数据，再安排停写、人工切换和重新配对。原节点仍有副本时先保留它们；不要让新旧网络同时写同一目录。24 小时恢复点目标依赖每日快照实际成功，以 `doctor` 的备份新鲜度检查为准。

## 身份迁移与撤销

停止原 Agent 写入，在旧机器导出迁移包（保留原知识）：

```bash
kioku agent migrate --agent codex-mac --target /tmp/codex-migration --confirm codex-mac
```

把包中的 `migration.json` 传到 Hub：

```bash
kioku agent migrate --receipt /tmp/codex-migration/migration.json \
  --out /tmp/replacement.invite.json --confirm codex-mac
```

将完整迁移包及新邀请传到接管机器：

```bash
kioku join --invite /tmp/replacement.invite.json --seed /tmp/codex-migration \
  --root /新机器/知识目录 --out /tmp/replacement.receipt.json
```

最后在 Hub `enroll` 新回执。接管前验证种子文件；允许中断重试、迁回旧机器，已有文件必须与种子历史一致，不覆盖冲突内容。Leader/Hub 的完整迁移暂按备份恢复与重新配对处理。

`kioku agent remove --agent ID --confirm ID` 停用身份；普通节点停用后还需在 Hub 停用对应身份。`kioku node revoke --device DEVICE_ID --confirm DEVICE_ID` 由 Hub 撤销设备后续访问。这些操作保留文件，不能远程抹除已有副本。

## 运维与开发

- `service start|stop|restart|files`：同步/备份服务操作，`files` 可查看原生服务配置。macOS 用登录用户的 LaunchAgents，Linux 用 systemd user service/timer。
- `--service manual`：初始化时只配置；随后 `service start` 启动临时后台进程，没有开机启动或备份定时器。`service start --service native` 可切到原生服务。
- `status --json`：连接、文件夹、备份和整理进度。`doctor --runtime codex|hermes-agent --json`：检查运行条件与 Skill 文件；实际运行器加载情况仍需在对应 profile 验证。
- CLI JSON 外层为 `{ok, data}` 或 `{ok:false, error}`；退出码 0 成功、1 运行故障、2 输入/状态错误、3 doctor 检查不通过。
- 配置变更持有 `mutation.lock`。进程意外退出后，确认没有相关进程再人工清理遗留锁；不会自动抢锁。

```bash
npm ci
npm run test:prepare       # 下载并校验真实测试依赖，需要网络
npm test                  # 输入与身份入口
npm run test:integration  # 临时目录内的真实 Syncthing/rclone 流程
npm run typecheck
npm run format:check
# macOS 可选：临时注册/删除独立 LaunchAgent，测试结束清理
KIOKU_TEST_NATIVE=1 node --test test/integration/native-service.test.mjs
```

集成测试需要允许监听本地端口。可用 `KIOKU_SYNCTHING` / `KIOKU_RCLONE` 指定已有二进制，跳过依赖准备。测试不使用真实云凭据，不启动 Hermes。当前验证结果与部署待办见 [实现与验收记录](implementation.md)。

设计来源：[讨论记录](2026-10-15-design-record.md)、[历史 CLI 草案](cli-draft.md)、[术语](GLOSSARY.md)、[架构决策](adr/README.md)。实际参数以此 README 和 `kioku --help` 为准。
