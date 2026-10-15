# KiokuNet 使用与运维指南

[项目首页](../README.md) · [当前决策](adr/0004-workspace-directories-and-current-state.md)

## 配对与目录登记

CLI 管理同步基础设施，Agent 通过工作区目录读写。日常保存文件不运行 CLI，也不绑定 `KIOKU_AGENT_ID`。现有配对格式和管理命令的 `--agent` 名称继续兼容，表示来源目录的内部标识。

以基础设施账号在 Hub 建网，再邀请来源目录：

```bash
kioku init --agent leader --root /srv/kioku --address 192.0.2.10:22000
kioku invite --agent writer --out /tmp/writer.invite.json
```

把邀请经可信渠道传到节点，以节点的基础设施账号执行：

```bash
kioku join --invite /tmp/writer.invite.json \
  --root /srv/kioku --out /tmp/writer.receipt.json
```

将回执传回 Hub 执行 `kioku enroll --receipt /tmp/writer.receipt.json`。Hub 固定 TCP 地址需要可达；本机管理 API 保持回环地址和私有凭据。同机新增来源可以使用 `kioku agent add --invite FILE --out RECEIPT`。

`--home` / `KIOKU_HOME` 指向基础设施私有配置，与知识根目录分离。默认服务方式为 native；Linux 使用 systemd user service 和 linger，macOS 使用登录账号的 LaunchAgent。`--service manual` 只配置，随后 `service start` 才启动临时同步进程。

## 权限准备

当前后端使用操作系统账号隔离。管理员在接入前完成以下设置，CLI 验证而不自动创建账号、递归 chmod、chown 或启动 Agent：

- 基础设施账号拥有私有配置、设备密钥和 Syncthing 管理凭据，私有配置目录为 0700，Agent 无权进入。基础设施账号和 Agent 账号必须不同。
- Agent 使用独立无特权账号，不属于 admin、sudo、wheel、docker 等管理组，也没有额外 sudo 规则、基础设施凭据、特权 capability 或切换到基础设施账号的渠道。`--user` 指的是这个操作系统账号，不是 Agent 身份。
- 知识根目录及 `agents/<来源>/` 父目录由基础设施或管理员拥有，Agent 可穿越但不能替换子目录。例如目录 0755、文件 0644。所有祖先必须满足这一条件；共享临时目录的 sticky bit 可保护其他账号拥有的子项。
- 自己的 `raw/` 由对应 Agent 账号拥有，Agent 可读写；目录的组设为专用基础设施组，权限 2775，让同步服务安全地原子替换控制文件。普通文件通常为 0644；其他 Agent 和 Leader 不加入基础设施组。这是共享来源资料，不是对 Leader 私密的目录。
- 节点的 `shared/` 由基础设施账号拥有，目录 0755、普通文件 0644，Agent 既不能写入，也不能 chmod 恢复写权限。Hub 的 `shared/` 由可信 Leader 账号拥有，组为基础设施组、顶层目录 2775，让同步服务维护控制文件；普通 Agent 不在该组，仍然只读。
- Leader 的账号可以写自己的 Raw 和 shared，其他来源 Raw 及其父目录仅可读。工作区外的源路径接受同样检查。
- 当前仅验证 POSIX 权限；存在扩展 ACL、知识内部符号链接、硬链接或不可读取的受保护路径时拒绝接入。管理员应先检查并配置专用目录，不要盲目修改整个主目录权限。

例如 Linux 新建的专用部署目录可由管理员准备如下；`kioku-sync`、`agent-worker` 是已经创建且符合上述限制的账号，路径应按实际部署调整：

```bash
# 在 init/join 已生成目录后执行；仅作用于已确认的专用目录。
chown kioku-sync /srv/kioku /srv/kioku/agents /srv/kioku/agents/writer
chmod 755 /srv/kioku /srv/kioku/agents /srv/kioku/agents/writer
chown agent-worker:kioku-sync /srv/kioku/agents/writer/raw
chmod 2775 /srv/kioku/agents/writer/raw
# 节点 shared 的所有者应为 kioku-sync；Hub shared 的所有者应为 Leader 账号。
# Hub shared 顶层也使用 Leader 所有者、kioku-sync 组和 2775 权限。
# 已有树内每份文件都需检查，CLI 会指出不符合要求的路径。
```

Agent 不应继续以用户的管理员账号执行文件工具。运行器如何使用准备好的系统账号由其已有启动方式决定，KiokuNet 不接管执行。拥有 sudo/root 的进程、容器特殊 UID 映射或通过其他高权限工具写文件不在这个账号边界内。

Syncthing 忽略远端文件权限与扩展属性，不接收远端所有者设置；服务创建新同步文件使用 0022 umask。可信 Leader 发布公共文档保持 0644 / 0755。更改账号、组、权限、ACL 或同步服务配置后，重新执行 `workspace check`；管理员和可信服务本身仍有能力改变权限。CLI 不声称一次检查能约束后续管理员改动。

## 建立与解除入口

用有权读取基础设施配置和管理工作区目录的账号执行：

```bash
kioku workspace attach --home /var/lib/kioku-config \
  --source /srv/kioku/agents/writer/raw \
  --raw-path /work/project/memory \
  --shared-path /work/project/knowledge \
  --user agent-worker
kioku workspace list --home /var/lib/kioku-config
kioku workspace check --home /var/lib/kioku-config
```

`--source` 是已经登记且在本机活跃的来源目录。目标父目录需事先存在并可供 Agent 穿越。入口可以位于不同父目录，不能互相包含或与知识根目录、私有配置重叠。相同映射重复执行幂等；已有普通文件、目录、不同链接或冲突登记时拒绝覆盖。

多个工作区可映射同一来源；同一来源仍只有一个写入节点。入口位置代表当前工作区使用哪份知识，CLI 不从项目名或运行器猜身份，不自动触发阅读。

解除接入：

```bash
kioku workspace detach --home /var/lib/kioku-config --raw-path /work/project/memory
```

删除该登记的 Raw/shared/Leader sources 链接，保留源数据。入口被替换为其他内容时拒绝删除；已解除的入口再次执行无副作用。解除链接不会撤销系统账号对源目录的权限，若要撤销账号访问，由管理员另行处理。

## Leader 提炼

Leader 接入时额外指定 `--all-raw-path /work/leader/sources`。该入口映射汇集目录，Leader 只读其他来源，自己的 Raw 仍可写。接入结果还返回 `progress`，位于自己的 `raw/.kioku-curation/`，仅保存当前处理进度并从同步中排除。

`kioku skill install --runtime hermes-agent` 仅在 Hub 安装 `kioku-curate`。安装到实际 Leader 使用的 profile；任务说明直接提供工作区路径，例如：

> 使用 kioku-curate，raw 为 /work/leader/memory，shared 为 /work/leader/knowledge，allRaw 为 /work/leader/sources。增量整理当前文件，保留来源和不确定性，保存当前处理进度。

任务由现有运行器配置和调度。普通 Agent 无需 Skill，可自由组织、编辑、重命名、删除文件。自由命名和无元数据模板的文本也可提炼；二进制附件不自动解释。来源文件改名或删除可能使旧引用失效，公共知识不会因此自动删除，Leader 根据剩余依据处理。

## 升级与取消历史功能

本版本移除 `backup` 命令、rclone 依赖、快照与恢复实现，以及 curate 保存旧公共文档的流程。构建会清理 dist，避免旧备份代码进入新包。Syncthing 配置关闭文件版本保留和冲突历史副本。

升级时先停止 Agent 与旧同步服务，由管理员确认专用基础设施组和上述目录权限，再以基础设施账号更新启动同步服务，最后建立或复查工作区入口。Agent 账号不加入基础设施组。接入同时校验配置目录所有者对 Raw/shared 有写权限，无法安全更新控制文件时返回 `SYNC_ACCESS_REQUIRED`。

执行 `kioku service start|stop|restart` 时清理本配置对应的旧备份 LaunchAgent / systemd service、timer，保留同步服务。即使采用 manual 方式也会检查旧任务。新版本不会执行旧的 backup 命令；若旧服务固定引用旧版本的 CLI 路径，升级后需用新 CLI 执行一次服务操作完成清理。

已有备份目标、快照数据、rclone 凭据、旧配置中的 backup 字段、`.stversions` 和旧整理历史目录均不删除、不读取恢复，也不自动转换。旧安装的 memory Skill 可能仍在运行器中，应从对应 profile 停用或卸载；新的安装命令不再分发它。旧 `context` 仅保留为管理兼容查询，不用于工作区文件操作。

## 迁移与撤销

迁移继续转移当前文件并验证内容完整性，不保存历史版本。先停止原 Agent 写入：

```bash
kioku agent migrate --agent writer --target /tmp/current-files --confirm writer
# Hub 接收签名的迁移材料并签发新邀请
kioku agent migrate --receipt /tmp/current-files/migration.json \
  --out /tmp/replacement.invite.json --confirm writer
# 新节点接收整份迁移包
kioku join --invite /tmp/replacement.invite.json --seed /tmp/current-files \
  --root /srv/kioku --out /tmp/replacement.receipt.json
```

随后 Hub enroll，重新准备新机器权限并建立工作区入口。停用本地来源会先移除仍匹配的登记入口；原文件保留。无法安全解除被替换的入口会报错，先处理冲突再重试。旧机器进程必须停止，链接解除不能阻止直接访问源路径。

`agent remove --agent ID --confirm ID` 停用来源，`node revoke --device ID --confirm ID` 撤销后续同步；不远程抹除已有副本。Hub 整体迁移需由管理员转移当前数据并重新配对，本工具不再提供灾难恢复。

## 运维

- `status`：同步、来源、登记入口和 Leader 当前整理结果。
- `doctor`：同步服务、连接、凭据权限、所有登记入口和读写权限；没有绑定工作区时不声称已完成接入。
- `workspace check`：只读复查登记入口及权限，不自动修复；不健康退出码 3。
- `service start|stop|restart|files`：仅配置同步服务，不调度 Agent。
- JSON 外层 `{ok, data}` 或 `{ok:false, error}`。退出码 0 成功、1 运行故障、2 输入/状态错误、3 检查不通过。
- 配置变更持有 `mutation.lock`；异常遗留锁由管理员确认没有存活进程后移除。

## 开发验证

```bash
npm ci
npm run test:prepare
npm run build
node --test test/*.test.mjs test/integration/*.test.mjs
npm run typecheck
npm run format:check
```

真实 Syncthing 集成用例需要本地端口。`KIOKU_TEST_NATIVE=1` 启用临时 macOS 服务测试，`KIOKU_TEST_SKILLS=1` 启用实际 Skill 安装测试。权限用例以 root 启动测试进程，再在子进程中清空附加组并切换到系统的 nobody、daemon 账号，实际测试 shared 创建、修改、删除、重命名、chmod 被拒绝，以及自己的目录可自由修改。非 root 环境明确跳过该用例；不要把跳过视为已完成跨账号验证。

可在隔离的 Linux 容器或测试机以 root 运行 `node --test test/integration/workspace.test.mjs`。用例仅修改临时目录，不创建账号、不修改现有部署。发布前还需在实际运行器的系统账号下验证工具执行身份。
