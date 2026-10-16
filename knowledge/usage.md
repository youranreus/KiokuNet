# KiokuNet 使用与运维指南

[项目首页](../README.md) · [架构决策](adr/README.md) · [设计与取舍](2026-10-16-machine-and-agent-access-design.md)

## 安装与目录

各机器安装 CLI。默认安装根为 `~/.kiokunet`；所有命令的 `--home` 或 `KIOKU_HOME` 都表示整个安装根。自定义位置后，每条命令使用同一个根。

```text
<安装根>/
├── data/agents/<来源>/raw/   # 本机 Raw；Hub 同时汇集远端 Raw
├── data/shared/             # shared 本体，供同步和 Leader 写入
├── config/                  # 配置、密钥、登记与副本状态
├── state/syncthing/         # 同步配置、身份及数据库
├── state/registration/      # 各节点的签名来源请求与 Hub 回应
├── views/shared             # 指向最近成功生成的只读副本
├── views/generation-*/      # 当前及短暂保留的前一代副本
├── bin/                     # 自动下载的依赖；也可复用 PATH 中的程序
└── logs/sync.log            # macOS/manual 后台日志；Linux 另见 journal
```

系统服务注册文件位于 macOS LaunchAgents 或 Linux systemd user 目录；工作区链接位于用户指定位置；CLI 本体由包管理器安装。它们不必位于安装根。显式导出的邀请、回执和来源迁移包使用用户指定的输出位置。

本版本面向新安装，不提供旧配置目录布局的自动迁移。`--root` 若显式传入，必须指向安装根下的 `data`，不能另放知识库。旧测试目录不会被自动删除。

## 先连接机器

Hub 可以没有任何 Agent。以下使用默认安装根，地址需替换为可达的 Hub 固定 TCP 地址：

```bash
# Hub
kioku init --address 192.0.2.10:22000
kioku invite --out ~/.kiokunet/config/mac.invite.json

# 把邀请通过可信渠道传到 Mac，在 Mac 上执行
kioku join --invite /path/to/mac.invite.json --out ~/.kiokunet/config/mac.receipt.json

# 将回执传回 Hub
kioku enroll --receipt /path/to/mac.receipt.json
```

邀请和回执完成设备身份与签名密钥配对。Hub 接受回执后才建立共享关系。机器邀请无需 Agent ID，机器接入不创建来源。

初始化默认注册原生后台服务。Linux 使用 systemd user service，并要求 linger 以支持退出登录后的运行；macOS LaunchAgent 随用户登录运行。测试或临时运行可使用 `--service manual` 初始化，再执行 `kioku service start`。manual 不注册系统服务，退出登录或重启后的持久运行不作保证。

后台进程同时管理 Syncthing、来源自动登记和 shared 副本刷新。管理 API 保持回环地址，只有同步 TCP 端口需要跨机器连接；不新增公网登记 API。

## 再创建来源

```bash
# Mac：本机来源，不再交换邀请或回执
kioku source add --agent writer
kioku source add --agent research
kioku source list

# Hub：之后再创建 Leader
kioku source add --agent leader --role leader
```

`agent` 是 `source` 命令的别名。来源 ID 必须是 1–64 位小写字母、数字、下划线或短横线，并以字母或数字开头。角色默认为 member；Leader 只能在 Hub 上创建，网络同时只允许一个活跃 Leader。

节点可以离线创建来源和写 Raw。`registration: pending` 表示本地已创建、等待 Hub 登记；`registered` 表示 Hub 已接受；`conflict` 表示写入归属被拒绝，并附原因。后台恢复连接后继续处理。同一来源只允许一台写入机器，同名来源不能接管其他机器的归属。存在待登记或冲突时，`doctor` 会报告尚未就绪。

Hub 保存全部 Raw，其他节点只保存本机 Raw 和 shared。普通文件读写不需要 CLI、memory Skill 或运行时身份绑定。`context --agent ID` 可辅助查询来源路径；多个本地来源时必须显式选择，不从项目名或运行器名称猜测。

## 接入 Agent 工作区

在工作区父目录已存在后执行；以下入口名称可以自由选择：

```bash
kioku workspace attach \
  --source ~/.kiokunet/data/agents/writer/raw \
  --raw-path /work/project/memory \
  --shared-path /work/project/knowledge
kioku workspace list
kioku workspace check
```

可以将同一个来源接入同机多个工作区。已有不同内容或重叠登记时拒绝覆盖，相同映射重复执行成功。来源必须已经在本机创建且活跃。普通 Agent 首次接入需要有可用的 shared 副本；尚未收到 Hub 内容或生成失败时明确报错。

Raw 链接指向真实来源，正常读写、重命名和删除均可。普通 Agent 的 shared 链接指向 `views/shared`，副本中文件与目录去掉写权限，防止正常编辑、创建、删除和替换。数据本体仍然可写，供同步和 Leader 使用。CLI 不要求独立系统账号，不对主动改权限、访问源路径或其他绕过行为提供隔离保证。

Leader 可以不配置汇总入口，也可以额外接入全部 Raw：

```bash
kioku workspace attach \
  --source ~/.kiokunet/data/agents/leader/raw \
  --raw-path /work/leader/memory \
  --shared-path /work/leader/knowledge \
  --all-raw-path /work/leader/sources
```

Leader 的 shared 入口直接指向可写本体。全部 Raw 入口是目录映射，不附带操作系统只读隔离。KiokuNet 不改写提示词或工作区规则，不启动 Agent，不自动触发阅读或提炼。

## 副本自动刷新与状态

后台定期检测本机 shared，写入新的独立副本，验证内容稳定并设置只读权限后原子切换入口。工作区链接不变。同步和刷新均为最终一致，可能短暂落后于本体；不承诺跨文件或跨机器事务一致。

```bash
kioku status --json
kioku doctor --json
kioku service start
kioku service restart
kioku service stop
kioku service files
```

`status.view` 包含最后成功更新时间、内容指纹和刷新错误；`status.worker` 表示后台进程心跳与登记处理错误；来源登记状态在 `agents` 中。刷新失败保留上次成功副本，不降级到可写本体；故障解除后自动继续。停止服务不会删除已生成副本。

shared 内部的符号链接或特殊文件会导致刷新失败；排除 Syncthing 控制文件与临时文件。`.kioku-shared.json` 是 Hub 发布的网络标记，缺失时节点不会把尚未接收完成的空目录当成首次可用内容。副本保留一代过渡内容供切换期间的读取，之后清理；不是备份或历史恢复功能。

## 解除、停用与退网

```bash
kioku workspace detach --raw-path /work/project/memory
kioku source remove --agent writer --confirm writer
kioku node revoke --device DEVICE_ID --confirm DEVICE_ID
```

解除工作区接入只移除已登记且仍匹配的链接，保留知识；入口被用户替换为其他内容时拒绝删除。停用来源先解除它的工作区入口，默认保留 Raw；节点后台向 Hub 传播停用状态。Hub 撤销设备后停止其共享关系，但不删除设备已有文件。CLI 不停止实际 Agent 进程，停用或迁移前应先停止该来源的写入。

来源跨机器迁移仍可使用已有的 `source migrate` 显式流程转移当前文件，具体提示由命令返回；这与旧版本安装目录迁移不同。迁移不能恢复历史。

## Agent 使用指南与 Leader 提炼

随包提供两个可选 Skill：

| Skill | 职责 | 安装条件 |
| --- | --- | --- |
| [kioku](../skills/kioku/SKILL.md) | 介绍 KiokuNet，按需指导 CLI 完整使用流程，不处理知识内容 | 无需初始化，普通节点与 Hub 均可安装 |
| [kioku-curate](../skills/kioku-curate/SKILL.md) | Leader 的公共知识整理 | 已初始化为 Hub |

```bash
# 默认安装通用指南；可以在 init / join 前执行
kioku skill install --runtime codex
# 可选：在当前项目安装，运行命令前切换到目标项目目录
kioku skill install --runtime pi --scope project
# Hub 显式选择 Leader 整理 Skill
kioku skill install --runtime hermes-agent --skill kioku-curate
```

`--runtime` 支持 `codex`、`hermes-agent`、`pi`、`universal`；`--scope` 默认 `global`，可选 `project`。`--source` 默认使用当前 CLI 包中的 Skill，也可显式指定其他可信仓库或本地目录。命令通过 `npx skills@1.7.2` 安装，需可用的 npm 网络或缓存；运行器按自己的安装规则发现和加载文件。

默认安装项已从 `kioku-curate` 改为 `kioku`，原有 Leader 安装脚本应补上 `--skill kioku-curate`。通用指南只在明确涉及 KiokuNet 的使用或排障时触发，不响应泛泛的记忆请求，也不自动调用整理 Skill。文件访问仍无需 Skill。

Leader 整理任务提供工作区 Raw/shared/allRaw 路径，由原有运行器调度。`doctor --runtime …` 目前仍仅在 Hub 检查 `kioku-curate` 文件是否存在，不验证实际加载，不作为通用指南的安装验证。

## 开发验证

开发验证通过公开 CLI、工作区实际文件操作和真实 Syncthing 节点。原生服务与外部 Skill 安装测试显式 opt-in；最新结果与平台限制见 [实现记录](implementation.md)。
