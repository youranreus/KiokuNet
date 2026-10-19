# 退出、迁移与升级

解除路径：space unmap --path PATH / shared unmap --path PATH，保留知识。

停用空间：space remove --space ID --confirm ID，解除该空间直接映射，停止共享，保留文件。Shared 映射独立存在。普通节点停用后也核实 Hub 共享关系。

撤销节点：node revoke --device ID --confirm ID，在 Hub 执行，保留远端缓存。

迁移空间前停止原节点上的使用方写入：
1. 原节点 space migrate --space ID --target NEW_BUNDLE --confirm ID。
2. Hub space migrate --receipt BUNDLE/migration.json --out INVITE --confirm ID。
3. 目标节点 join --invite INVITE --seed BUNDLE --out RECEIPT。
4. Hub enroll --receipt RECEIPT。

迁移保留空间 ID，仅转移当前文件。不同的已有目标内容拒绝覆盖，相关授权须重新签发。

旧产品模型升级使用 `upgrade plan` 预览，再停止所有节点的服务和知识写入程序，核对影响后 `upgrade apply --confirm NETWORK_ID`。保留目录内容与映射，旧密钥/OAuth 全部重授权，旧邀请重新签发。工具保留私有配置备份及恢复日志；中断时修复原因后重复 apply，不能删除日志重来。全部节点升级完毕再启动同步。详细步骤见仓库 knowledge/upgrading.md。
