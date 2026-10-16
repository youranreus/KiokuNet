# 退出与迁移

先确认用户要解除哪个入口、停用哪个来源、撤销哪台设备或迁移哪个来源，并解释具体影响。涉及中断访问的操作取得针对目标的确认后执行；`--confirm` 重复目标 ID，只是 CLI 校验，不替代用户授权。

## 解除入口、停用来源、撤销节点

```bash
kioku workspace detach --raw-path /absolute/workspace/memory --json
kioku source remove --agent writer --confirm writer --json
# 以下在 Hub 上执行
kioku node revoke --device DEVICE_ID --confirm DEVICE_ID --json
```

- `workspace detach` 移除该登记下仍匹配的工作区入口，保留来源文件；入口已被用户替换时拒绝删除。
- `source remove` 停用非 Leader 来源，先解除其登记入口，保留 Raw。节点停用状态由后台传播到 Hub，需要检查同步结果。
- `node revoke` 由 Hub 撤销设备及其来源的共享关系，不擦除该设备已有副本。

CLI 不停止 Agent 进程，也不会撤销同账号对实际目录的访问能力。停用或迁移前应停止原来源的写入。当前不能通过 `source remove` 停用 Leader，不能绕过限制直接编辑配置。

## 跨机器迁移来源

只支持本机 member 来源导出，迁移转移当前文件，不恢复历史，也不是旧版安装目录迁移。先停止旧机器上该来源的写入，再明确告知用户：导出会停用旧来源；它不是无副作用的备份。

1. 旧写入机器导出到知识与配置目录之外、尚不存在的新目录：

   ```bash
   kioku source migrate --agent writer \
     --target /absolute/exchange/writer-migration --confirm writer --json
   ```

2. 将返回目录中的 `migration.json` 交给 Hub，在 Hub 验证原写入归属并生成迁移邀请：

   ```bash
   kioku source migrate --receipt /absolute/exchange/writer-migration/migration.json \
     --out /absolute/exchange/writer.invite.json --confirm writer --json
   ```

3. 将完整迁移目录及邀请交给新机器，以迁移目录作为种子接入：

   ```bash
   kioku join --invite /absolute/exchange/writer.invite.json \
     --seed /absolute/exchange/writer-migration \
     --out /absolute/exchange/writer.receipt.json --json
   ```

4. 回执传回 Hub，执行 `kioku enroll --receipt /absolute/exchange/writer.receipt.json --json`。在新机器检查来源和同步状态，再按 [来源与工作区](workspaces.md) 配置新入口。

每步核对命令实际返回的路径和后续提示。失败时保留原文件与迁移包，报告已停用、已生成邀请等完成状态；不要自动删目录重试或恢复旧节点写入，以免出现两个写入节点。
