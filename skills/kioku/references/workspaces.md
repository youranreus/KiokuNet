# 来源与工作区

## 登记来源

在已入网机器上检查已有来源，复用用户选择的来源或按需新增：

```bash
kioku source list --json
kioku source add --agent writer --json
kioku context --agent writer --json
```

`source` 的旧别名为 `agent`。来源 ID 为 1–64 位小写字母、数字、下划线或短横线，首位必须为字母或数字。角色默认 member。来源代表长期知识归属，不是每次会话或每个工作区自动新建的身份。

`context --agent ID` 辅助查询实际路径，普通文件操作不需要先调用它。存在多个本地来源时显式选择；旧环境变量 `KIOKU_AGENT_ID` 与参数冲突时会报 `IDENTITY_CONFLICT`，应确认运行环境的预期身份。

节点可离线新增来源，后台联网后自动登记：`pending` 为等待，`registered` 为 Hub 已接受，`conflict` 为归属冲突。不要通过重新配对或覆盖其他机器来源来处理冲突。同一来源只有一台写入节点。

## 接入普通 Agent

确认父目录已存在、入口路径未占用，并从实际来源配置取得 Raw 路径。以下以默认安装根和来源 writer 为例：

```bash
kioku workspace attach \
  --source ~/.kiokunet/data/agents/writer/raw \
  --raw-path /absolute/workspace/memory \
  --shared-path /absolute/workspace/knowledge --json
kioku workspace list --json
kioku workspace check --json
```

`--source` 接受本机已登记且活跃的 Raw 目录，不是来源 ID。这里的 `--source` 与 `skill install --source` 含义不同。同一来源可接入同机多个工作区；相同映射可重复执行，已有不同内容或重叠入口会拒绝覆盖。保留已有内容，另选入口或由用户明确处理冲突。

Raw 入口指向来源本体；shared 入口指向 `views/shared` 的只读副本。首次没有可用副本时接入会失败，先检查 Hub 配对、同步和后台刷新，不能改连可写 shared。本地路径发现和接入验证完成后，本指南的职责即完成，不读取或处理其中的知识内容。

## Leader 工作区

仅在 Hub 上为用户指定的 Leader 创建来源，已有活跃 Leader 时不能再建：

```bash
kioku source add --agent leader --role leader --json
kioku workspace attach \
  --source ~/.kiokunet/data/agents/leader/raw \
  --raw-path /absolute/leader/memory \
  --shared-path /absolute/leader/knowledge \
  --all-raw-path /absolute/leader/sources --json
```

Leader 的 shared 入口指向可写本体。`--all-raw-path` 可选，仅 Leader 可用，用于访问汇集的来源目录；它不提供系统级只读隔离。接入不会修改运行器提示词、启动 Agent 或触发整理。独立安装 `kioku-curate` 的方式见 [安装与机器入网](setup.md)。
