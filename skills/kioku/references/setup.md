# 安装与节点入网

Node.js ≥22.20，macOS/Linux。已发布包：`npm install -g @reus-able/kioku-net`；仓库构建：`npm ci && npm run build`。操作前检查当前版本 --help。

`kioku skill install --runtime codex` 默认安装操作指南。支持 codex、hermes-agent、pi、universal；--scope project 安装到当前项目，--repository 指定分发仓库。可选 --skill kioku-curate 在没有本地节点时也可安装。

Hub 执行 `kioku init --address HOST:22000`，再 `kioku invite --out /absolute/invite.json`。新节点 `kioku join --invite /absolute/invite.json --out /absolute/receipt.json`，Hub `kioku enroll --receipt /absolute/receipt.json`。

机器配对不创建空间，Hub 也可以没有空间。邀请和回执通过用户认可的渠道传递。Node ID 为设备身份，不用空间名或助手名替代。

默认 native 服务；--service manual 只配置，之后 service start 启动后台。支持 service start|stop|restart|files。服务负责同步、空间登记和副本刷新，不执行整理任务。
