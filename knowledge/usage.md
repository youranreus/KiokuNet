# 使用指南

当前模型见 [术语表](GLOSSARY.md) 和 [ADR 0009](adr/0009-nodes-spaces-and-explicit-access.md)。旧版本先按[升级指南](upgrading.md)迁移，不混用新旧命令。

## 安装根与服务

`--home` / `KIOKU_HOME` 指整个安装根，默认 `~/.kiokunet`，不是 config 或 data 子目录。所有后续命令使用相同的安装根。需要 Node.js ≥22.20、npm、macOS 或 Linux。

```text
<安装根>/
├── config/                  # 私有配置、授权与升级日志
├── data/
│   ├── spaces/<space-id>/   # 直接存放空间内容
│   └── shared/              # 公共知识本体或同步副本
├── views/                   # 本地只读派生副本
├── state/                   # Syncthing 与登记协议状态
├── logs/
└── bin/
```

```sh
kioku deps install
kioku init --address hub.example:22000
kioku service start
kioku status --json
kioku doctor --json
```

`init` 和 `join` 默认使用 native 服务。`--service manual` 仅配置；之后 `service start` 启动同步和后台登记/副本刷新，退出登录或重启后的持续运行由操作系统管理方式决定。服务支持 `start|stop|restart|files`。CLI 不调度知识处理任务。

## 机器入网

1. Hub：`kioku invite --out /absolute/invite.json`。
2. 新节点：`kioku join --invite /absolute/invite.json --out /absolute/receipt.json`。
3. Hub：`kioku enroll --receipt /absolute/receipt.json`。

邀请和回执独立于空间。Hub 和普通节点都可没有空间。`kioku node list` 查看已登记设备；`node revoke --device ID --confirm ID` 撤销节点，不擦除其缓存文件。

## 空间管理

```sh
kioku space add --space work
kioku space list
kioku space info --space work
kioku space remove --space work --confirm work
```

标识使用 1–64 位小写字母、数字、下划线或连字符，首位为字母或数字，在网络内唯一。创建在本地完成；普通节点离线创建后，联网再自动向 Hub 登记。返回 pending 不等于已同步；conflict 表示不能接管已属于其他节点的标识。Hub 保存全部空间，普通节点不订阅其他节点的空间。

移除会停用空间并解除该空间的直接目录映射，保留内容；普通节点停用后也应在 Hub 核实共享关系。Shared 映射独立存在。重用停用空间须走迁移流程，不能通过重新 add 绕过归属检查。

## 目录映射

```sh
kioku space map --space work --path /absolute/project/knowledge
kioku shared map --path /absolute/project/shared
kioku space mappings
kioku space check
kioku space unmap --path /absolute/project/knowledge
kioku shared unmap --path /absolute/project/shared
```

入口的父目录须存在，入口必须为空或已经是相同映射。不同内容拒绝覆盖；重复映射幂等。多个入口可指向同一个空间。解除入口不删除知识，替换过的入口拒绝自动删除。

Hub 上可显式选择：

```sh
kioku shared map --path /absolute/curation/shared --access read-write
kioku space map --all --path /absolute/curation/spaces
```

全部空间映射使用只读副本，文件直接位于 `<入口>/<space-id>/`，没有 raw 层。只读副本不是安全沙箱，不限制本机所有者访问实际路径。副本自动刷新；失败时保留上次可读版本。首次无有效 Shared 副本时，Shared 映射失败；独立的本地空间映射不因此失败。

## 空间跨节点迁移

先停止使用方写入，然后在原写入节点：

```sh
kioku space migrate --space work --target /absolute/new-bundle --confirm work
```

这会停用原空间、解除其映射并导出当前文件，不保存历史版本。将包中的 migration.json 交给 Hub：

```sh
kioku space migrate --receipt /absolute/new-bundle/migration.json --out /absolute/new-invite.json --confirm work
```

完整包和新邀请交给目标节点执行 `join --invite ... --seed /absolute/new-bundle --out ...`，再把回执交给 Hub enroll。目标可为已入网节点，使用同一个安装根。空间标识保持不变，授权因归属改变须重新签发。文件拷贝校验哈希，已存在的不同内容拒绝覆盖。

## Skills 与远程访问

```sh
kioku skill install --runtime codex
kioku skill install --runtime codex --skill kioku-curate
```

支持 codex、hermes-agent、pi、universal，默认全局安装，`--scope project` 安装到当前项目；`--repository` 指定分发仓库。两种 skill 均可在未配置节点的机器安装。kioku 只解释操作，curate 可使用本地目录或具有相应权限的 MCP。

[MCP 指南](mcp.md)说明静态密钥，[OAuth 指南](oauth.md)说明浏览器连接。MCP 只在 Hub 提供文件读写和检索，不提供节点或空间管理接口。

自动化调用使用 `--json`。结果为 `{ok,data}` 或 `{ok:false,error}`；`doctor` / `space check` 不健康时退出码 3。移除、迁移、撤销前核对目标与影响，再填写确认标识。
