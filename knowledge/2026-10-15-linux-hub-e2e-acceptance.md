> 历史记录：当前产品概念与接口以 [ADR 0009](adr/0009-nodes-spaces-and-explicit-access.md) 和[使用指南](usage.md)为准；本文保留当时的设计与验证事实。

# KiokuNet Linux Hub 与 Mac 首次端到端验收

2026-10-15，Asia/Shanghai（UTC+08:00）。**KiokuNet v0.1.0 已在真实 Linux Hub 与 Mac 节点之间完成 Raw 上传、Hermes Leader 自动提炼、shared 回传的完整链路验收。** Mac 最终 `doctor` 全部 10 项通过。本记录覆盖一次真实部署与知识流转，不代表持续可用性或五分钟时效承诺。

## 环境与证据来源

| 项目 | 环境与配置 | 证据来源 |
| --- | --- | --- |
| Linux Hub | Debian 13、x86_64、Node 22.22.2；systemd user service enabled/active，linger=yes | Hermes 部署报告 |
| Hermes Leader | v0.21.5+3840.g9a0a162，default profile，身份 `hermes-main`；`kiokunet-curate` 每 5 分钟执行 | Hermes 部署与任务报告；实际提炼结果由 Mac 收到 |
| Mac 节点 | macOS arm64、Node 22.23.2，身份 `codex-mac`；LaunchAgent 实际运行 | Mac 本机检查 |
| 安装版本 | 两端安装正式 Release v0.1.0，校验 npm 安装包 SHA-256 | Hub 报告与 Mac 本机校验 |
| 同步协议 | Syncthing 2.1.6、固定域名 TCP 22000；发现、中继和自动 NAT 关闭 | 两端配置及 Mac 连接日志 |
| Skill | Hub 加载 `kioku-memory` / `kioku-curate`；Mac 安装并使用 `kioku-memory` | Hub 运行报告、Mac 安装与实际 context 调用 |

正式安装包：[kiokunet-0.1.0.tgz](https://github.com/youranreus/KiokuNet/releases/download/v0.1.0/kiokunet-0.1.0.tgz)。SHA-256：

```text
4258efe617c71dcd6232c3624b045c28104ea33f28c0345b36f21c0065ba463c
```

Hub 报告确认实际 profile 能加载两个 Skill，手动提炼后再次执行 `promoted=0` 且文档哈希不变；通过 Hermes 自身任务入口触发也成功。本机验收重点是已登记设备的真实连接、文件上传及包含 Mac 来源的公共文档回传。

## 验收步骤与结果

| 环节 | 验证方法 | 结果 |
| --- | --- | --- |
| 邀请与回执 | 校验邀请文件哈希和 Ed25519 签名；Mac `join` 后校验回执签名；Hub `enroll` | 已完成双向登记，身份未重建 |
| 本机运行 | `context --agent codex-mac --json`、LaunchAgent、静态 Hub 地址、文件夹类型 | member 身份；Raw 为 sendonly，shared 为 receiveonly |
| 真实连接 | Syncthing 日志和 `status` | 20:58:43 建立与预期 Hub 设备的 TLS 1.3 连接，`connected=true` |
| Raw 上传 | 查询指定 Hub 设备对 Mac Raw 文件夹的 `/rest/db/completion` | `completion=100`、`globalItems=1`、`needItems=0`、`needBytes=0`、`remoteState=valid` |
| Leader 提炼 | 等待既有 Hermes 定时任务；读取回传公共文档 | `shared/projects/kiokunet.md` 的 `updated_at` 为 21:02:39，新增 Mac 来源和接入准备快照 |
| shared 回传 | 在 Mac 读取项目文档、INDEX，核对记录 ID、标记和来源哈希 | 来源匹配本机原始 Raw；INDEX 指向实际文档 |
| 最终健康 | `kioku doctor --runtime codex --json` | `healthy=true`，全部 10 项通过 |

本轮仅在 Mac 自己的 Raw 写入验收资料，没有在 Mac 改写 shared，也没有通过手工复制文件代替同步。原始 Raw 保持不变，验收结论以新增 correction 记录补充。

## 可追溯证据

验收 Raw 的网络内相对位置：

```text
agents/codex-mac/raw/2026-10-15T12-35-22-754Z-bbb8791b-b055-4514-9345-a741bc2ab5b2.md
```

| 项目 | 值 |
| --- | --- |
| Raw 记录 ID | `bbb8791b-b055-4514-9345-a741bc2ab5b2` |
| 唯一验收标记 | `KIOKU_E2E_bbb8791b-b055-4514-9345-a741bc2ab5b2` |
| Raw SHA-256 | `28fbf43cf75e955b07fe80c56028cbee69e62a041b5418c6f463c822f1fbd05f` |
| 回传公共文档 | `shared/projects/kiokunet.md` |
| 本轮回传版本 SHA-256 | `f7c164d763cdefb91dcd6d8b58140f2bde8dcb92cf445e4d8f1511cc64cd7e6a` |
| 验收结论 correction ID | `5547ed24-dc08-4db8-84a1-4e3cc65acdb4` |

回传文档的 `sources` 同时包含 `agent_id=codex-mac`、上述记录 ID、Raw 相对路径和匹配的 SHA-256。文档后续会被继续提炼，表中公共文档哈希仅标识本次验收版本。

## 网络故障与诊断更正

Hub 登记后，Mac 一度保持 `connected=false`。磁盘配置与运行配置均有正确的 Hub 静态地址，文件夹方向正确，服务正常运行，域名和 IP 的 `nc` 检查均显示 TCP 连接成功。

临时启用 Syncthing `connections` / `dialer` DEBUG 后，实际拨号错误为：

```text
tls: first record does not look like a TLS handshake
```

独立 TLS ClientHello 探测收到了 `HTTP/1.1 502 Bad Gateway`，正文带有公司 IT 服务提示。**该响应只能说明 TLS 握手时收到了中间 HTTP 错误，不能单独认定公司网络策略是根因，也不能排除远端防火墙。** 用户随后报告远端服务器防火墙开启，调整后 Mac 自动建立连接；具体防火墙规则未在 Mac 侧直接检查。

这次没有重新配对、修改身份或签名文件，也没有改写 Raw 或扩大本机网络权限。临时 DEBUG 日志已恢复为 INFO。

排查顺序应为：服务运行 → 实际设备静态地址与文件夹配置 → TCP 可达 → Syncthing TLS 和设备连接 → 对端文件完成度 → 提炼来源与回传。TCP connect 成功和本机文件夹 `idle` 都不足以单独证明端到端同步完成。

## 验收边界与待办

- Linux 服务 enabled/active、linger=yes 已由 Hub 报告验证；真实重启及退出登录后的持续运行尚待单独演练。
- 首次 Raw 在网络受阻期间创建，恢复连接后才上传；不能据此宣称“从 Raw 创建到可读 shared 始终少于五分钟”。尚需持续时效测量及更多故障恢复样本。
- 当前实测 DNS 为直接 A 记录；用户计划的 CNAME → 源站域名结构尚未完成验收。
- 云备份与新目录恢复演练未执行。Hub `doctor` 的 `backup-configured`、`backup-fresh`、`recovery-drill` 未通过符合本轮范围；Mac 健康并不代表 Hub 已完成备份保障。
- 真实部署中的附件流转、冲突提炼、后续 correction 提炼结果，以及长期运行稳定性仍需补充验证。

操作命令见 [使用与运维指南](usage.md)，实现与自动化测试见 [实现与验收](implementation.md)。
