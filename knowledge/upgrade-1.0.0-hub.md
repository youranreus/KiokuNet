# KiokuNet 1.0.0：Hub 升级执行说明

将本文交给负责 Hub 的 Agent。目标是在保留知识、节点配对、空间标识及写入归属的前提下，将现有 0.x / 配置 v1 升级为 1.0.0 / 配置 v2，并恢复本机整理流程和远程访问。

本文依据 master `6961cea`、1.0.0 的升级实现及 2026-10-19 深夜至 10-20 的 Hub 只读检查编写。检查结果是历史快照，执行时重新核验。本文交付不表示升级已执行。通用机制见 [升级指南](upgrading.md)，普通节点另用 [节点说明](upgrade-1.0.0-node.md)；单独收到本文也可按以下步骤执行。

## 1. 范围与全网协调

本 Agent 负责 Hub 的备份、迁移、定制脚本与 Skill 适配、MCP 授权恢复和 Hub 侧验收。其他节点由各自 Agent 处理，阶段结果交给用户或指定协调人汇总。

按以下顺序推进；缺少阶段回执时，保留停服状态并报告缺项，不能将“本机完成”当成“全网完成”：

1. **准备完成**：Hub 和所有已配对节点均确认目标版本、预览结果、需要暂停的写入程序及备份位置。
2. **全网停止**：每台机器已暂停知识写入、停止 KiokuNet worker 和 Syncthing、完成静止状态备份。收到全部停止回执后，才执行任何一台的 `upgrade apply`。
3. **全网迁移完成**：每台均安装 1.0.0、完成配置 v2 迁移和本地适配，服务仍停止。收到全部迁移回执后，先启动 Hub，再由协调人通知普通节点启动。
4. **验收完成**：同步、目录入口、MCP、整理流程分别验收，再恢复正常写入与调度。

若某节点无法参与，交由协调人安排新的切换窗口或明确的隔离方案；不能让旧版本节点自动重连新网络。本文默认采用全网一起升级。执行期间若机器重启，重新核实原生服务是否自动拉起；必要时临时抑制自动启动并记录恢复方式。

## 2. 核对本次 Hub

此前实测配置如下；若实际不符，以现场配置为准并先解释差异：

- SSH：`root@203.9.150.230`，主机 AI-Base；安装根 `/root/.kiokunet`。
- CLI prefix：`/root/.local`；Node：`/opt/hermes-runtime/node/bin/node`。非交互 SSH 默认 PATH 可能找不到它们。
- 网络 ID：`e1728030-f14b-4f70-8f94-dde0b4231a06`；实际确认值必须取本轮预览。
- Hub 本地来源：`hermes-main`、`chatgpt`；远端来源：`work-mbp`、`gn001`、`virtues-mini`。旧 ID 原样成为空间 ID，不重新登记或改名。
- 两套映射位于 `/root/.hermes/workspace` 与 `/root/.hermes/profiles/researcher/workspace`，各有 `memory`、`knowledge`、`sources`。
- MCP：`127.0.0.1:7332`，公开地址 `https://ai-base.exia.xyz/mcp`，OAuth 已启用。
- 上次有 1 个有效静态密钥、1 条 `ChatGPT · chatgpt` OAuth 连接；静态密钥有历史调用，持有客户端尚未识别。
- 上次 Hub、本机健康；Hub 观察 GN001 的 Shared 完成度约 77.5%。此值需要重新检查，不能把 connected 或文件夹 idle 等同于收齐。

设置本次命令环境，使用原安装账号：

```sh
export PATH="/opt/hermes-runtime/node/bin:/root/.local/bin:$PATH"
kioku_install=/root/.kiokunet
node --version
npm ls -g @reus-able/kioku-net --depth=0 --prefix /root/.local
kioku --help
```

只提取配置中的 version、mode、networkId、deviceId、agents/spaces、workspaces/mappings、同步文件夹 ID、授权名称和状态。核对 `mode=hub`、Node ≥22.20，以及现有服务的 Node/worker 实际路径。旧版可用 `workspace list`、`workspace check`；新版用 `space mappings`、`space check`。

读取 status/doctor 时保留退出码，并在输出给用户前去掉 worker token、私钥、密钥及完整 OAuth 状态。列出全部 peer 的同步完成度、待收项目和错误。异常先核对，不通过重新 init/join、改配置版本号或重新创建空间解决。

**完成条件：** 确认真实安装根、网络和来源归属；列出全部参与节点、连接授权及待修正文件。若已是完整 v2，转入适配和验收；若有未完成的 `config/upgrade-v2.json`，按第 9 节恢复。

## 3. 准备 1.0.0 与只读预览

先在临时目录安装明确版本，保持生产 CLI 和服务不变：

```sh
umask 077
task_stage=$(mktemp -d /tmp/kioku-1.0.0-hub.XXXXXX)
npm install --prefix "$task_stage" --ignore-scripts \
  --registry=https://registry.npmjs.org/ @reus-able/kioku-net@1.0.0
task_cli="$task_stage/node_modules/@reus-able/kioku-net/dist/cli.js"
node "$task_cli" --help
node "$task_cli" upgrade plan --home "$kioku_install" --json
```

核验实际安装包 version 为 1.0.0，并读取包内 upgrading、usage、mcp 和两个 Skill。若 registry 尚无该版本，报告发布阻塞，或使用用户明确指定且已核验的 1.0.0 发布包；不改用 latest 或其他分支。

本次预期迁移 5 个目录和 6 个入口：

- `data/agents/<id>/raw` → `data/spaces/<id>`。
- 两套 `memory` → `data/spaces/hermes-main`。
- 两套 `knowledge` → 原 `data/shared`，继续可写。
- 两套 `sources` → 全空间只读副本；通过入口读取 `<space-id>/<相对路径>`，去掉 raw 层。读取使用稳定入口，不固定到 generation 目录。

检查预览的撤销连接和邀请清单。所有旧静态密钥及 OAuth 连接失效；未消费的旧邀请、旧签名迁移材料需重新签发。已有已配对节点保留身份，不必重新邀请。

**完成条件：** 预览成功且所有目录、入口、授权影响已核对；尚未创建 `data/spaces` 或移动生产数据。

## 4. 停写、停服与备份

先准备第 6 节的适配改动，保持当前 v1 任务仍可工作；在维护窗口应用新版本配置。

在 Hub 暂停 researcher 的 `kiokunet-curate`（每 5 分钟）和 `public-media-daily`（每日 01:00，Asia/Shanghai），以及现场发现的其他知识写入任务、交互会话和 MCP 写入方。检查运行中的任务与锁，等待其结束。保留原启用状态与调度表达式，恢复时沿用；不通过新增重复 cron 替代原任务。

```sh
kioku service stop --home "$kioku_install" --json
```

核实 worker、Syncthing 和 Hub MCP 已停止；单独暂停 cron 不能替代停服，单独停 KiokuNet 也不会停止 Hermes 的文件写入。保持 Hermes 原有 root 执行方式，不借升级改变运行账号或无关服务。

在知识目录之外创建权限受限的备份目录，备份完整安装根及将修改的外部脚本、Skill、工作区规则、任务定义和服务文件。记录旧包版本及恢复来源。示例：

```sh
umask 077
task_backup="/root/kioku-upgrade-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$task_backup"
tar -cpf "$task_backup/installation.tar" -C /root .kiokunet
tar -tf "$task_backup/installation.tar" >/dev/null
```

另存每个来源用户文件的相对路径、字节数与 SHA-256，记录同步控制文件及忽略规则；备份包括隐藏的整理状态。验证归档可读取、关键配置和知识文件可恢复到临时目录。备份和哈希清单不放进空间或 Shared，不把私有配置打印进聊天。

**完成条件：** 本机停写、停服、备份核验完成，且协调人已确认全部节点停止。否则保持等待，不执行下一步。

## 5. 安装与迁移

```sh
npm install -g --prefix /root/.local \
  --registry=https://registry.npmjs.org/ @reus-able/kioku-net@1.0.0
npm ls -g @reus-able/kioku-net --depth=0 --prefix /root/.local
/root/.local/bin/kioku --help
/root/.local/bin/kioku upgrade plan --home "$kioku_install" --json
```

用本轮预览的 networkId 设置 `task_network_id`，核对后执行：

```sh
/root/.local/bin/kioku upgrade apply --home "$kioku_install" \
  --confirm "$task_network_id" --json
```

命令应返回 completed=true、servicesStarted=false。检查配置 version=2、升级日志 completed=true，核对原 networkId/deviceId、空间 ID、写入归属和同步文件夹 ID 未变。对迁移后的空间文件核验之前的内容清单；同步内部控制文件的变化单独解释。

保留 `config/config.v1.backup.json`、存在时的 `config/oauth.v1.backup.json` 和 `config/upgrade-v2.json`。工具只备份配置与授权，不替代上一步的知识备份。

**完成条件：** 迁移完整、知识校验通过、服务仍停止。完成下列适配后才报“迁移完成”。

## 6. 适配 Hub 的整理与管理流程

### 6.1 将整理状态移出知识空间

1.0.0 的 `kioku-curate` 要求进度和锁位于知识目录之外，这是对旧清单的补充。采用本机现有运行器状态目录的子目录，例如：

```text
/root/.hermes/profiles/researcher/media-archive-state/kioku-curation/
```

在任务停止、确认没有活锁后，将迁移后 `data/spaces/hermes-main/.kioku-curation/` 的现有状态转移到该目录；目标如已存在，先比较、合并和核验，不能覆盖。保留 processed.json、last-run.json 及仍有用途的状态；活锁或来源不明的锁先核实持有者，不直接删锁。备份保留在知识目录之外。

processed 的 `<空间 ID>/<相对路径>` 键可以沿用，原来约 1326 项只是检查时快照，按实际内容校验，不清空重做。确认状态完整后让知识空间内退出旧状态存放方式。

同步修改以下所有读写方到同一个新状态目录：

- `media-public-archive/dispatch.py` 的 LAST_RUN_JSON、CURATION_LOCK，以及其他实际使用这些状态的代码。
- `prompts/curate.md`、两套工作区 AGENTS.md、手工整理/确认回填规则。
- `pending-confirmation-audit/references/human-review-queue.md` 的处理进度和锁路径。

dispatch.lock 和 curate_last_success_fingerprint.json 已在知识目录外，可沿用；先核验新布局处理结果，再保存新的成功指纹，不能直接用当前指纹标记“已处理”。

### 6.2 修正指纹门控

实际调用链为 researcher cron → kioku_curator_dispatch.py → media-public-archive/curate_job.py → dispatch.py → `/root/.hermes/scripts/kiokunet-raw-fingerprint.sh`。

- 将 `data/agents` 和 status 的 `agents` 字段改为新模型。优先对整理器实际读取的稳定 `sources` 副本入口计算指纹，避免本体已变、副本未刷新时提前消费变化。
- 指纹只依赖稳定的空间 ID、相对路径、内容哈希，以及确实需要的空间登记/活跃状态。排除 mtime、generation 名称、绝对副本路径、处理进度、锁、回执时间和服务心跳。
- 每次扫描固定同一副本 generation；读取期间被回收、内容变化或 API 失败时返回可诊断的失败，不将失败解释为空库或成功无变化。
- 保留 `.kioku-curation` 历史残留及同步控制文件的忽略逻辑；只读普通文件，拒绝跟随来源中的任意链接。

在隔离目录测试：内容不变连续两次指纹一致；相同内容换 generation/mtime 仍一致；新增、修改、删除知识会变化；只改处理进度不变化；扫描失败不会更新成功基线。再在真实只读入口验证稳定性。

### 6.3 更新 Skill、任务提示词和运维引用

先备份、比较本地追加规则，把有用的定制经验保存在定制 Skill/运行器指引中，再安装包内官方版本：

```sh
kioku skill install --home "$kioku_install" --runtime hermes-agent \
  --scope global --skill kioku --json
kioku skill install --home "$kioku_install" --runtime hermes-agent \
  --scope global --skill kioku-curate --json
```

安装器不保证同时更新 researcher 的独立副本。分别核对 `/root/.hermes/skills/{kioku,kioku-curate}` 和 `/root/.hermes/profiles/researcher/skills/{kioku,kioku-curate}`，让实际执行 profile 发现 1.0.0 内容；目标若是链接，先确认链接指向。用实际运行器验证发现路径，不能只凭安装命令成功。

逐项处理已知文件，并搜索其他正在使用的配置与脚本中的同类引用：

- `/root/.hermes/workspace/projects/media-public-archive/prompts/curate.md`：提供可读空间入口 `researcher/workspace/sources`、可写 Shared `researcher/workspace/knowledge`、新的独立状态目录；移除固定 v0.4.3 和 `<id>/raw` 假设，保留内容组织、去重和通知约定。
- 两套 `workspace/AGENTS.md`：把 Agent/Leader 产品身份改为空间与实际访问用途，更新状态路径，保持 researcher 单一整理执行者。
- `/root/.hermes/profiles/researcher/skills/pending-confirmation-audit/references/human-review-queue.md`：更新数据根、遍历层级和处理进度路径；其余确认回填规则中的状态引用一起核对。
- `/root/.hermes/skills/devops/kiokunet-hub-ops/SKILL.md`：更新升级顺序、路径、命令和状态字段；新 status 不再提供 curation，整理状态从运行器的 last-run.json 单独读取。
- `/root/.hermes/workspace/scripts/kioku-verify.py`：将 agents 改为 spaces，核对同步文件夹 ID 时保留原 ID，不因 ID 内含 raw 就重建文件夹。

媒体采集的 DEFAULT_RAW 已指向稳定的 `researcher/workspace/memory`，可随登记映射继续使用。历史知识正文里的旧路径作为历史证据保留；新检索规则解释路径变更，避免批量改写历史材料。每个仍命中的活跃旧引用必须修正或说明为何适用。

**完成条件：** 新状态位置与所有使用方一致；两套 Skill 已核验；门控测试通过；旧命令/路径的活跃依赖已处理。向协调人报告“本机迁移完成，服务仍停止”。

## 7. 全网完成后恢复同步和授权

收到全部节点迁移完成回执后，启动 Hub，再由协调人通知普通节点启动：

```sh
kioku service start --home "$kioku_install" --json
kioku doctor --home "$kioku_install" --json
kioku space check --home "$kioku_install" --json
kioku mcp status --home "$kioku_install" --json
```

核对原生服务重新生成的 Node/worker 路径、原有自启动方式和 linger；恢复维护期间临时抑制的启动设置。新的 sources 必须指向成功刷新的只读副本，两套 knowledge 仍为原可写 Shared。doctor/space check 的退出码 3 表示不健康。

恢复既有 ChatGPT 用途时采用 chatgpt 空间读写、Shared 只读：

```sh
kioku mcp oauth approve --home "$kioku_install" \
  --write-space chatgpt --shared read --json
```

将一次性授权码通过用户认可的私密方式交付，让用户完成浏览器授权。代码有效期 10 分钟且仅使用一次，安排用户就绪后再生成。静态客户端先确认持有方与用途，再用相同最小权限创建新 key 并安全配置；旧 key 已被移除，不能对它执行 rotate 来恢复。新秘密只交付一次，不放进文档、知识库或普通日志。

保留现有 MCP host/port/publicUrl；只有实际配置需要变化时才调整代理。更新客户端/自有插件中 `/raw/chatgpt` → `/spaces/chatgpt`、旧 agent 来源字段 → space；若由另一 Agent 管理插件，将具体改动交给该负责人，不直接改安装缓存代替发布。

通过真实客户端验证允许读取 Shared、读写 chatgpt，且不能写 Shared 或其他节点空间。当前本地整理流程不需要新增 MCP 连接；只有用户另选远程整理时才单独授予相应空间读取和 Shared 写入范围。

## 8. 验收与交接

1. 确认所有预期 peer 重连，各空间与 Shared 的待同步项目、错误和对端完成度符合预期；尤其重新核对 GN001。
2. 由节点 Agent 在其自有空间写入一个可识别的小文件，Hub 读取并比对哈希。Hub 通过一次有意义的 Shared 更新或约定测试标记，确认节点收到并刷新只读入口；完成后清理约定测试内容并等待删除同步。
3. 在正常通知暂停的条件下手动验证整理任务：能读新空间布局，保留已有 processed 键，写入 Shared 后才更新独立进度。连续无变化时不重复调用模型或发布文档。若无法隔离通知，先说明正常通知会被触发，按用户既有授权处理。
4. 核验媒体采集的稳定 memory 入口可写及其运行状态目录正确；无需为验证升级强制执行一次外部采集。
5. 按原启用状态恢复调度和正常知识写入，观察一次正常周期；报告通过、失败及仍需用户完成的客户端授权。

交接必须包含：CLI/配置版本、网络与空间归属是否保留、备份和日志位置、修改文件清单、状态迁移与指纹测试结果、节点同步证据、MCP 恢复情况、调度是否恢复、未完成项。不能把“配置迁移完成”报告成“整个升级验收完成”。

## 9. 中断与回退

apply 失败时保留停止状态和 `config/upgrade-v2.json`，修复具体错误后用同一网络 ID 重跑 apply。目标已存在、链接被替换、配置被外部改动时先核对原因；保留原目录和日志，不强行覆盖。

迁移完成后重复 apply 可返回完成状态；已经是 v2 且没有迁移日志的安装不需要重做迁移。整体回退需由协调人安排全网停服，并一致恢复包版本、完整安装根、外部脚本/状态/规则及授权策略；只恢复 config.json 不能回退。恢复旧 OAuth 快照前先在服务未暴露时重置授权并重新连接，避免旧凭据意外复活。回退期间的新知识另行核对保存，不覆盖丢失。
