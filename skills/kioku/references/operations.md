# 诊断与运行

先检查 `kioku status --json`、`kioku doctor --json`、`kioku space check --json`。

- pending：本地空间已建立，检查节点配对、网络连通和后台登记。
- conflict：标识写入归属冲突，不能用新登记覆盖其他节点。
- VIEW_UNAVAILABLE：Shared 尚无有效副本，确认 Hub 同步与 marker；空间本地映射独立可用。
- 副本刷新失败：保留上次成功内容，修复真实目录的不安全文件或 IO 问题后自动恢复。
- MCP_NOT_READY：配置已保存，但监听或应用失败；查看 mcp status 和日志，同步独立运行。
- UPGRADE_REQUIRED / UPGRADE_IN_PROGRESS：按升级指南处理，不能修改版本号或删除恢复日志强行启动。

日志位于 <安装根>/logs，Syncthing 管理 API 仅回环监听。服务 start|stop|restart 管理后台基础设施；知识处理程序由用户管理。CLI 不读取提炼回执、检查助手状态或要求安装 curate。
