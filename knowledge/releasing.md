# GitHub Release 发布

脚本：`scripts/release.mjs`。包名是 `kiokunet`，可执行命令是 `kioku`；发布 tag 固定为 `v<package.json.version>`。不发布到 npm registry。

## 首次发布当前 0.1.0

在仓库根目录执行。需要 Node.js ≥22.20、npm、git、GitHub CLI，以及目标仓库的写权限。

```bash
npm ci
gh auth login --hostname github.com

# 先提交和推送要发布的代码，保持 master 工作区干净
# 发布脚本本身不会自动提交，也不会替你推送 master

git push origin master
npm run release -- --dry-run
npm run release -- --draft
```

检查 GitHub 草稿中的说明和附件后，同版本重新执行即可公开：

```bash
npm run release
```

也可直接执行 `npm run release` 一次完成。即使直接发布，内部仍先创建草稿，待附件上传并下载校验成功后再公开。预发布版本（如 `0.2.0-beta.1`）会标记为 GitHub prerelease。

`--dry-run` 只读取本地 Git 和远端 refs，展示版本、提交、tag、目标仓库及附件计划，不构建、不登录 GitHub API、不创建或推送 tag。它仍要求工作区干净且 HEAD 与远端 master 一致。

## 更新版本与 tag

```bash
# 任选一种；同时修改 package.json 和 package-lock.json，不创建提交/tag
npm run release:version -- patch
# npm run release:version -- minor
# npm run release:version -- major
# npm run release:version -- 0.2.0-beta.1

# 审阅版本及随版本变化的文档，然后提交
# 若 README 中保留了特定版本的安装示例，按本次版本更新示例
git diff -- package.json package-lock.json
git add package.json package-lock.json
git commit -m "chore: bump release version"
git push origin master

npm run release -- --dry-run
npm run release
npm run release:tags
```

`release:tags` 按版本倒序列出本地 `v*` tags；远端查询可用 `git ls-remote --tags origin`。

脚本对 tag 的处理：

- 不存在：在已验证的 HEAD 上创建 annotated tag，只推送本次 tag。
- 已存在且指向 HEAD：复用；只有远端存在时拉取到本地。
- 指向不同提交：停止，要求选择新版本；不 force-push，不移动或删除 tag。
- 要重试旧版本，需在该版本原提交对应的发布环境完成；本脚本要求当前 master 与 origin/master 一致，不提供任意历史提交发布入口。

## 构建、校验与产物

脚本依次运行：

1. 检查分支、干净工作区、lockfile 版本、origin 仓库、远端 master、tag 冲突和 GitHub 登录。
2. 清理生成目录 `dist/`，执行 typecheck、format:check、test、test:prepare、test:integration。
3. `npm pack` 生成编译后的安装包，并计算 SHA-256。
4. 再次检查源代码和远端状态，创建/推送本次 tag。
5. 创建或复用草稿，上传缺失附件，重新下载验证；全部一致后公开。

集成测试使用真实 Syncthing/rclone，需要本机可监听临时端口。依赖准备可能访问官方发布源；首次运行需要网络。macOS 原生服务和 Skill 网络安装测试仍由各自的 `KIOKU_TEST_*` 开关控制。

本地产物位于 `.release/v<version>/<commit>/`，已加入 `.gitignore`：

```text
kiokunet-<version>.tgz
SHA256SUMS
release-notes.md
```

只上传前两项作为附件；说明通过 `--notes-file` 传给 GitHub。默认说明包含提交号、安装/校验步骤，并追加 GitHub 生成的变更记录。也可指定自己准备的说明：

```bash
npm run release -- --notes /绝对路径/release-notes.md
```

复用已有 Release 时保留其说明；修改草稿说明可在 GitHub 上完成。已公开版本不会因为传入 `--draft` 而撤回。

## 中断与重跑

运行中以 `.git/kiokunet-release.lock`（实际位置由 Git 决定）互斥。正常结束或可捕获错误会释放锁；强制终止后请先确认没有运行中的发布进程，再人工移除遗留锁。

上传失败后保留 tag 和草稿，不自动回滚。重跑同一命令会重新构建，下载已有附件比较哈希，只补上传缺失项。已有附件不一致或处于未完成上传状态时停止，由维护者检查草稿；脚本不自动覆盖或删除附件。已公开 Release 缺少附件也会停止，避免静默修改历史发布。

如果网络在最终公开操作后中断，不要假定发布失败：重跑会读取远端实际状态。正式包更新请增加版本，不覆盖旧版本。

## 用户安装

从对应 Release 下载 `.tgz` 与 `SHA256SUMS`，然后执行：

```bash
# Linux
sha256sum -c SHA256SUMS
# macOS 则使用：shasum -a 256 -c SHA256SUMS
npm install -g ./kiokunet-0.1.0.tgz
kioku --help
```

请下载脚本上传的 npm 安装包。GitHub 自动提供的 Source code 压缩包是源码，不包含编译后的 `dist/`。

接口依据：[gh release create](https://cli.github.com/manual/gh_release_create)、[gh release upload](https://cli.github.com/manual/gh_release_upload)。
