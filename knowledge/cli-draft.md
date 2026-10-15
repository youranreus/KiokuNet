# KiokuNet 首版 CLI 草案

截至 2026-10-15，命令职责来自已确认的设计讨论；`kioku` 命令名、子命令和参数是待实现草案，不能作为可用软件执行。最终决策见 [设计记录](2026-10-15-design-record.md)，术语见 [GLOSSARY](GLOSSARY.md)。

## 使用约定

- 人工使用可交互引导；脚本和 Agent 使用完整参数及 `--json`。
- 非交互调用缺少必要参数时返回错误，不等待输入。
- 输出路径使用绝对路径；身份、路径和状态输出不含凭据。
- 配置操作可重复执行，保留已有配置和知识。
- 删除需明确操作并二次确认；停止接入或撤销设备默认不删除知识。
- CLI 只管理同步/备份基础设施，不调用模型，不建立 Hermes 定时任务。

## 命令目录

| 草案命令 | 职责 | 需继续细化的部分 |
| --- | --- | --- |
| `kioku init` | 在 Linux 初始化 Hub、网络身份、Leader 和根目录，配置基础服务。 | 重复初始化检查；地址和端口参数。 |
| `kioku invite` | Hub 为指定目标 Agent 生成接入邀请。 | 文件协议、有效性和撤销规则。 |
| `kioku join` | 本机读取邀请，配置目录和服务，生成设备回执。 | 已有节点复用、同机多实例、等待登记状态。 |
| `kioku enroll` | Hub 导入回执，登记设备和目录共享。 | 身份绑定验证和重复导入行为。 |
| `kioku agent add / list` | 管理、列举本机长期 Agent 实例。 | 新增实例的 Hub 登记步骤；不得绕过配对。 |
| `kioku agent remove` | 停用某个 Agent 的接入，默认保留知识。 | 本机状态与 Hub 共享关系如何协同。 |
| `kioku agent migrate` | 引导旧写入节点停用、新节点接管同一 Agent。 | 多步骤迁移和中途失败处理。 |
| `kioku node revoke` | Hub 撤销设备后续同步访问。 | 受影响的 Agent 列表；不承诺远程删除已有副本。 |
| `kioku context` | 返回当前 Agent 的身份、角色和绝对路径。 | JSON schema 与 CLI/Skill 兼容版本。 |
| `kioku status` | 接入、同步和备份状态；存在整理进度文件时可展示最近结果。 | 不把文件回执等同于 Hermes 的实时任务状态。 |
| `kioku doctor` | 检查依赖、服务、网络、路径、Skill 与身份配置。 | 保持只读，修复与检查分开。 |
| `kioku service start / stop / restart` | 操作本工具配置的同步和备份基础服务。 | macOS/Linux 平台服务适配。 |
| `kioku backup configure / run / list` | Hub 配置目标、触发备份、列出恢复点。 | 凭据存储、快照格式和完整性标记。 |
| `kioku backup restore` | 将指定恢复点恢复到新目录并校验。 | 默认不覆盖在线知识目录；人工切换。 |
| `kioku skill install` | 薄封装指定版本的 `skills add`。 | 运行器/profile/安装范围；不另造 Skill 更新体系。 |

## 首次接入示例

以下地址和目录为占位示例。邀请、回执路径也应允许用户指定；CLI 规范化后返回绝对路径。

```bash
# Linux Hub
kioku init --agent hermes-main --root /srv/kiokunet --address <Hub固定地址>
kioku invite --agent codex-mac --out /tmp/invite.json

# 将邀请文件传到 Mac 后，在 Mac 上执行
kioku join --invite /tmp/invite.json --root /Users/reuszeng/kiokunet --out /tmp/receipt.json

# 将接入回执传回 Hub 后，在 Hub 上执行
kioku enroll --receipt /tmp/receipt.json
kioku backup configure

# 两端分别检查
kioku status --json
kioku doctor --json
```

只有 Hub 接受回执并完成共享关系配置后，才可声称接入完成。邀请不能代替新设备身份的双向登记。

## 当前身份解析

`kioku context` 服务于 Skill 上下文查询，拟提供：

```bash
kioku context --agent hermes-main --json
```

规则顺序：

1. `--agent` 与 `KIOKU_AGENT_ID` 都存在且不一致，报冲突。
2. 使用显式参数，否则使用环境绑定。
3. 无绑定且恰好一个可用实例，自动识别。
4. 无绑定且存在多个实例，列出候选并返回错误。
5. 无可用实例，提示登记。

未知或已停用身份应明确报错。这里的身份选择不是凭据或安全授权。管理命令的目标身份与 Skill 查询的当前身份是不同概念，参数的适用范围要在实现时明确。

不提供 `kioku use` 这种全机共享可变状态，不根据当前目录或工具名猜测实例。显式参数和环境变量属于每次调用或执行环境，不改变其他并发 Agent 的身份。

拟议 JSON 内容包括：身份、角色、节点、知识根目录、自身 Raw、公共知识目录；Leader 可额外获取汇集 Raw 和整理进度路径。字段名尚未冻结，凭据不进入输出。

## Skill 分发与 Hermes 接入

拟议仓库内容：

```text
skills/
├── kioku-memory/SKILL.md
└── kioku-curate/SKILL.md
```

以当日已核实版本为例，以下命令中的仓库 URL 和 Skill 名须在实现后实际存在：

```bash
# Mac 普通 Agent
npx -y skills@1.7.2 add "<KiokuNet仓库URL>" --skill kioku-memory -g -a codex -y

# Linux Hermes Leader
npx -y skills@1.7.2 add "<KiokuNet仓库URL>" --skill kioku-memory kioku-curate -g -a hermes-agent -y
```

`-a` 选择运行器类型，不绑定 KiokuNet 的 `agent_id`。Hermes 的实际 profile 与安装范围需要匹配。Skill 本体保持通用，所有本机上下文从 KiokuNet 的独立配置读取。

用户自行在 Hermes 中配置定时任务，任务说明可写为：

> 使用 kioku-curate；KiokuNet 身份为 hermes-main。先执行 kioku context --agent hermes-main --json，读取返回目录，按 Skill 处理新增知识并保存处理进度。

KiokuNet 不生成或运行 `hermes chat` 子进程，也不负责该任务的重试。需要立即整理时，用户从 Hermes 侧触发任务。

## 恢复示例

```bash
# 参数为草案，目录必须与在线知识目录分开
kioku backup restore --snapshot <恢复点ID> --target /srv/kiokunet-restore
```

恢复后验证完整性，再人工安排切换。恢复数据不会自动覆盖在线目录或自动加入同步网络。

## 核心验收场景

| 场景 | 期望 |
| --- | --- |
| 空节点首次接入 | 生成身份、目录和回执，未登记前显示等待 Hub。 |
| 重复执行 join/enroll | 不重复生成 Agent、不重置已有知识，协议允许安全恢复。 |
| 本机一个实例且无绑定 | context 自动返回该实例。 |
| 本机多个实例且无绑定 | 返回歧义错误和候选身份。 |
| 参数与环境绑定不一致 | 返回冲突，不静默切换身份。 |
| 单机多个运行器/实例 | Raw 归属分别明确，公共知识按同一网络共享。 |
| 离线、恢复连接和重启 | 本地文件保留，工作同步恢复；不虚报即时一致。 |
| Hermes 重复执行 Skill | 根据进度和来源避免重复提炼，不改写其他 Agent 的 Raw。 |
| 云配置未完成 | 同步可工作，备份状态和整体验收明确未完成。 |
| 恢复到新目录 | 可校验数据，在线网络不被旧快照改写。 |

这些是待实现的行为要求，尚无通过的自动化测试或真实部署结果。
