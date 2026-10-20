# KiokuNet 1.0.0：普通节点升级执行说明

将本文交给负责某台普通节点的 Agent。目标是在保留本机知识、空间标识、写入归属和 Hub 配对的前提下，将现有 0.x / 配置 v1 升级为 1.0.0 / 配置 v2，并修正本机使用方的路径和命令。

本文依据 master `6961cea` 和 1.0.0 实现编写。适用于 macOS/Linux 普通节点；空间名和安装目录必须从目标机器发现，不照抄其他机器。Hub 另用 [Hub 说明](upgrade-1.0.0-hub.md)，通用机制见 [升级指南](upgrading.md)。单独收到本文也可执行。

## 1. 全网协调与本机范围

本 Agent 只处理分配的机器。以下阶段结果交给用户或指定协调人：

1. **准备完成**：识别安装、空间、使用方，1.0.0 预览通过，备份位置和停写安排明确。
2. **本机已停止**：知识写入暂停，worker 与 Syncthing 停止，备份已核验。只有收到协调人“全部节点及 Hub 已停止”的消息后，才执行 apply。
3. **本机迁移完成**：安装与配置迁移完成，文件、入口及使用方适配通过，服务仍停止。
4. **本机验收完成**：收到协调人“全部已迁移、Hub 已启动、可启动节点”的消息后启动，完成同步验收，再恢复正常写入。

缺少全网阶段回执时保持当前阶段并报告等待对象，不因为本机迁移成功就提前重启。节点离线也需要协调升级；本文不授权自行撤销设备或另建网络。若维护期间重启，重新检查原生服务是否自动启动，必要时暂时抑制自启动并记录如何恢复。

## 2. 发现本机配置与使用方

检查 `command -v kioku`、已安装包版本、Node ≥22.20、`kioku --help`，以及实际使用的 `--home` / KIOKU_HOME。`--home` 指整个安装根，不是 config/data 子目录。CLI 无 `--version`，从实际包的 package.json 或 npm 包列表核对版本。

以下变量是默认示例；核实自定义安装根后再设置：

```sh
kioku_install="$HOME/.kiokunet"
node --version
npm ls -g @reus-able/kioku-net --depth=0
kioku --help
```

读取配置的必要字段，确认 `mode=node`；记录 networkId、deviceId、hubDeviceId、Hub 地址、本机所有活跃来源 ID/归属、目录映射、服务模式和实际 Node/worker 路径。若 mode=hub，改用 Hub 文档。

旧版检查 `workspace list`、`workspace check`、status、doctor；输出前过滤 worker token、私钥和管理密钥。不把沙箱网络访问失败当成服务故障，必要时在允许访问回环 API 的环境中复核。网络连通时与 Hub 核对本机空间上传、Shared 下载及错误状态；离线或未收齐时明确报告，不假定同步完成。

扫描当前生效的使用方，至少覆盖：

- Codex/Claude/Cursor/Pi/Hermes 的全局规则、项目规则和实际加载的 kioku Skill。
- 工作区 memory/knowledge 等入口、配置中未登记的手工链接、启动脚本、备份/导出任务和计划任务。
- 硬编码 `data/agents/<id>/raw`、`/raw/<id>`、旧 source/agent/workspace/context 命令，及读取 agents/workspaces/agent 字段的程序。
- 运行器环境或提示词中把 `KIOKU_AGENT_ID`、member/Leader 当成产品授权依据的内容。

按实际空间归属处理，同机多个项目可继续共用既有空间，不按项目或会话创建新空间。历史知识中的旧路径作为历史证据保留，优先修正活跃配置与执行逻辑。

**完成条件：** 安装根、所有本机空间、服务与写入程序清单已确认。若配置已为完整 v2，跳过迁移转适配与验收；有未完成 upgrade-v2.json 时按第 8 节恢复。

## 3. 准备新版本和预览

在临时目录准备明确版本，保持现有安装运行方式：

```sh
umask 077
task_stage=$(mktemp -d /tmp/kioku-1.0.0-node.XXXXXX)
npm install --prefix "$task_stage" --ignore-scripts \
  --registry=https://registry.npmjs.org/ @reus-able/kioku-net@1.0.0
task_cli="$task_stage/node_modules/@reus-able/kioku-net/dist/cli.js"
node "$task_cli" --help
node "$task_cli" upgrade plan --home "$kioku_install" --json
```

核验实际包 version=1.0.0。若发布包不可用，报告阻塞或使用用户指定且已核验的 1.0.0 包，不替换为 latest。旧生产 CLI 不支持 upgrade 是预期差异，预览使用上面的临时新 CLI。

核对每个来源 `data/agents/<id>/raw` → `data/spaces/<id>`。知识文件直接位于空间根，移除的是产品附加的 raw 层，不重命名用户自己建立的同名子目录。已登记的可写入口自动重定向；Shared 继续使用本地只读副本。手工链接和规则中的绝对路径需要自行适配。

**完成条件：** 预览与本机实际空间/映射一致、无目标冲突。不要为了准备迁移提前创建 data/spaces；已有目标会导致迁移拒绝覆盖。

## 4. 停写、停服、备份

在协调的维护窗口暂停所有会写本机知识空间的会话、脚本、导出和定时任务，等待在途操作结束。Agent 本身也在修改路径前停止向旧位置自动记录；维护笔记先留在知识目录之外，完成迁移后再归档。

```sh
kioku service stop --home "$kioku_install" --json
```

使用实际服务管理方式核实 worker 和 Syncthing 已停止。新 CLI 也支持停止旧配置，但替换生产包应放在停服之后。

在安装根之外创建权限受限的备份：

```sh
umask 077
task_backup="$HOME/kioku-upgrade-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$task_backup"
tar -cpf "$task_backup/installation.tar" \
  -C "$(dirname "$kioku_install")" "$(basename "$kioku_install")"
tar -tf "$task_backup/installation.tar" >/dev/null
```

还要备份即将修改的全局/项目规则、Skill、脚本、手工链接记录及原生服务文件，记录旧版本和包恢复来源。生成本机各空间用户文件的相对路径、大小和 SHA-256 清单，记录隐藏文件及用户忽略规则；验证关键内容能从备份恢复到临时目录。工具自带的配置备份不包含知识历史。

**完成条件：** 本机备份已核验、知识写入与同步均停止，已交付停止回执，并收到全网停止确认。

## 5. 安装 1.0.0 并迁移

沿用该节点原有安装账号、Node 管理器及 npm prefix。先确认 `npm root -g` / `npm prefix -g` 对应当前 kioku；若使用自定义 prefix，在安装命令中显式添加原值。不要为升级换 Node 管理器、改服务模式或使用另一个账号安装。

```sh
npm install -g --registry=https://registry.npmjs.org/ @reus-able/kioku-net@1.0.0
npm ls -g @reus-able/kioku-net --depth=0
kioku --help
kioku upgrade plan --home "$kioku_install" --json
```

确认当前 kioku 确实来自新包；用本轮预览的 networkId 设置 `task_network_id`：

```sh
kioku upgrade apply --home "$kioku_install" --confirm "$task_network_id" --json
```

要求 completed=true、servicesStarted=false。检查配置 v2、完成的升级日志，以及 networkId/deviceId/hubDeviceId、空间 ID/写入归属和同步文件夹 ID 与备份一致。旧同步文件夹 ID 中保留 raw 是兼容设计，无需更改。

逐空间核对用户文件哈希与新入口；保留 config.v1.backup.json、存在时的 oauth.v1.backup.json 及 upgrade-v2.json。完成后继续保持停服。

## 6. 适配规则、Skill 与脚本

- 旧 `data/agents/<id>/raw/...` 改为 `data/spaces/<id>/...`；优先让使用方读取已经登记的稳定 memory 入口。手工链接逐一核对后更新，保留无关内容。
- “本机 Agent 来源/role=member”改为“本机既有知识空间及其写入归属”。助手身份可以继续使用原名称，但不再以它推导产品权限。
- source/agent list、add、remove、migrate 改用 space 对应命令及 `--space`；这些管理操作不是升级必需步骤，不为迁移重复 add/remove。
- context 查询改用 `space info --space ID` 和 `space mappings`；workspace list/check 改用 `space mappings` / `space check`。创建新入口时用 `space map --space ID --path PATH`、`shared map --path PATH`；已有迁移成功的入口不重复拆建。
- status 的 agents/workspaces 改为 spaces/mappings。普通节点继续只同步自己的空间与 Shared，不通过 Hub MCP 写属于本节点的空间。

备份并检查本地定制 Skill，然后按实际运行器更新基础 kioku Skill。例如 Codex：

```sh
kioku skill install --home "$kioku_install" --runtime codex --skill kioku --json
```

支持 codex、hermes-agent、pi、universal；核对实际发现目录及独立 profile/项目副本。普通节点不因升级自动安装整理 Skill。若原先另有整理实践，按 1.0.0 Skill 要求把处理进度/锁放在知识目录之外，并核对所有使用方。

如果这台机器还通过独立 MCP 连接访问 Hub，等待 Hub 重新授权，使用 `/spaces/<id>/...` 与 `/shared/...`，更新旧来源返回字段；纯本地目录访问不需要 MCP 授权。

### 已核验节点的实例：virtues-mini

只有实际目标确认为该 Mac 时应用以下路径：

- 新空间：`/Users/youranreus/.kiokunet/data/spaces/virtues-mini`。
- `/Users/youranreus/Code/virtues-mini/memory` 由迁移更新；knowledge 继续指向 `/Users/youranreus/.kiokunet/views/shared`。
- 修改 `/Users/youranreus/.codex/AGENTS.md` 的旧写入根与产品角色表述、工作区 AGENTS.md，以及已安装基础 kioku Skill。继续沿用跨项目写入同一空间和已有索引组织。
- 自有 KiokuNet 插件中 `/raw/chatgpt` 属于 Hub 连接的入口，与本机 virtues-mini 空间不同。交由 Hub/插件负责人更新授权和插件源，避免错误地改成 `/spaces/virtues-mini` 或直接编辑安装缓存。

其他机器从自己的配置识别 ID、入口、运行器和导出流程；GN001/work-mbp 尚未做本机级预检，不能宣称本节实例覆盖了它们。

**完成条件：** 内容校验、映射与使用方适配完成，已汇报“迁移完成，服务仍停止”。

## 7. 统一启动与验收

收到协调人确认全网迁移完成且 Hub 已启动后：

```sh
kioku service start --home "$kioku_install" --json
kioku doctor --home "$kioku_install" --json
kioku space list --home "$kioku_install" --json
kioku space check --home "$kioku_install" --json
```

检查 status 时仅输出必要字段。doctor/space check 退出码 3 代表不健康；核对 peer 已连接、空间 registered、文件夹无错误/待收异常、Shared 副本刷新成功。验证原 native/manual 模式保留，服务的 Node/worker 路径指向新安装，并恢复临时抑制的自启动设置。

与 Hub Agent 通过协调人配合验收：

1. 从正常使用方入口读取旧文件，与迁移前哈希一致；在本机拥有的空间通过入口写入唯一小测试文件，Hub 收到并核对内容哈希。
2. Hub 发布约定的 Shared 变化后，本机收到并能通过 knowledge 入口读取。由 Hub 查询对端完成度；不能只凭本机命令成功报告已同步。
3. 检查 Shared 入口确为受管理的只读副本，使用 `space check` 验证防误写；不通过 chmod 或切到 data/shared 绕过。root/同账号所有者权限不是安全隔离验收。
4. 清理本机测试文件并确认删除同步；恢复原写入程序，验证它们使用新入口。旧路径不再被活跃任务重新创建。

回报：机器/空间、CLI/配置版本、备份位置、身份归属是否保留、改动文件、映射与只读检查、上传/下载证据、后台服务和自动记录是否恢复、尚未完成的授权或同步项。仅完成本地迁移时必须明确写“等待全网启动/验收”。

## 8. 中断与回退

迁移中断时保留停服状态、知识目录与 config/upgrade-v2.json，修复具体错误后用原网络 ID 重跑 apply。目标冲突、链接被替换或配置变化需要核对，不能删除日志强行重来。完成的 apply 可重复调用；已完整处于 v2 的安装无需重建迁移过程。

回退必须经协调人安排，联合处理包版本、整个安装根、规则/脚本/入口和其他节点状态；只恢复 config.json 后运行旧程序不受支持。备份恢复前保存升级后产生的新知识；如果全网仍运行新版本，本节点保持停止，不自行降级重连。
