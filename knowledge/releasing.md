# GitHub Release 与 npm 发布

脚本：`scripts/release.mjs`。包名是 `@reus-able/kioku-net`，可执行命令是 `kioku`；Git tag 固定为 `v<package.json.version>`。一次构建出的同一个 `.tgz` 同时用于 GitHub Release 附件与 npm 包，npm 目标固定为 `https://registry.npmjs.org/`，访问级别为 public。

## 发布流程

v0.1.0 仅发布到 GitHub；v0.2.0 起同时发布 GitHub 和 `@reus-able/kioku-net` npm 包。后续发布先按下节更新版本并提交、推送，不移动已有 tag，也不把当前代码补发为旧版本。

在仓库根目录执行。需要 Node.js ≥22.20、npm、git、GitHub CLI，以及目标仓库和 npm 包 `@reus-able/kioku-net` 的发布权限。首次发布须确认 npm 包名可用，或当前账号拥有该包的发布权限。

不需要提前在 npm 网页创建包，首次成功发布会创建它。`@reus-able` 必须对应已有的 npm 用户或组织：如果是个人 scope，需使用对应账号；如果是组织 scope，需先创建或加入该组织，并具备发布权限。参见 [npm scopes](https://docs.npmjs.com/about-scopes/)。脚本已设置 `--access public`，并同时指定默认和 `@reus-able` 的 registry，避免用户级 scope 配置把发布指向其他源。

当前流程由本地 `npm run release` 执行，单独 `git push` 不会发布 npm 包。

```bash
npm ci
gh auth login --hostname github.com
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/

# 先提交和推送要发布的代码，保持 master 工作区干净
# 发布脚本本身不会自动提交，也不会替你推送 master

git push origin master
npm run release -- --dry-run
npm run release -- --draft
```

`--draft` 仅创建或复用 GitHub 草稿并校验附件，不访问 npm registry、不要求 npm 登录，也不发布 npm 包。检查草稿中的说明和附件后，同版本重新执行即可发布 npm 并公开 GitHub：

```bash
npm run release
```

也可直接执行 `npm run release` 一次完成。内部先创建草稿，附件上传并下载校验成功后发布 npm，确认 npm 包的 SHA-512 integrity 与本地一致后再公开 GitHub。正式版本使用 npm `latest` 标签；预发布版本（如 `0.2.0-beta.1`）使用 `next`，并标记为 GitHub prerelease，不影响 `latest`。

`--dry-run` 只读取本地 Git 和远端 refs，展示版本、提交、tag、目标仓库、附件及 npm registry/dist-tag 计划，不构建、不登录 GitHub API、不访问 npm registry、不创建或推送 tag。它仍要求工作区干净且 HEAD 与远端 master 一致；不会验证 npm 包名可用性或账号发布权限。

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

1. 检查分支、干净工作区、lockfile 版本、origin 仓库、远端 master、tag 冲突和 GitHub 登录。正式发布时查询 npm 精确版本；尚未发布时验证 npm 登录，网络或认证错误会停止。
2. 清理生成目录 `dist/`，执行 typecheck、format:check、test、test:prepare、test:integration。
3. `npm pack` 生成编译后的安装包，计算 GitHub 附件的 SHA-256 和 npm 包的 SHA-512 integrity。若 npm 已有该版本，先核对包内容，一致才继续。
4. 再次检查源代码和远端状态，创建/推送本次 tag。
5. 创建或复用草稿，上传缺失附件，重新下载验证。
6. 非 `--draft` 模式下，将该 `.tgz` 通过 `npm publish` 发布，显式指定 registry、public、latest/next，并禁用生命周期脚本，避免再次构建。读取 registry 的精确版本元数据核对 SHA-512 integrity，通过后公开 GitHub Release。

集成测试使用真实 Syncthing，需要本机可监听临时端口。依赖准备可能访问官方发布源；首次运行需要网络。macOS 原生服务和 Skill 网络安装测试仍由各自的 `KIOKU_TEST_*` 开关控制。

本地产物位于 `.release/v<version>/<commit>/`，已加入 `.gitignore`：

```text
reus-able-kioku-net-<version>.tgz
SHA256SUMS
release-notes.md
```

只上传前两项作为附件；说明通过 `--notes-file` 传给 GitHub。默认说明包含提交号、安装/校验步骤，并追加 GitHub 生成的变更记录。也可指定自己准备的说明：

```bash
npm run release -- --notes /绝对路径/release-notes.md
```

复用已有 Release 时保留其说明；修改草稿说明可在 GitHub 上完成。已公开版本不会因为传入 `--draft` 而撤回。

## 认证与中断重跑

本地发布沿用 `npm login` 登录态。`npm publish` 继承终端，可按 npm 提示完成 2FA。非交互环境如使用 token，需自行在用户级 npm 配置中为 `//registry.npmjs.org/:_authToken` 引用凭据；单独设置 `NPM_TOKEN` 不会被脚本自动读取。不要把凭据提交到仓库。当前 npm 认证要求见 [npm 2FA 文档](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)；本脚本不配置 CI 或 OIDC。

`GITHUB_TOKEN` / `GH_TOKEN` 环境变量会优先于本机登录。如果 `gh auth status` 明确报告环境令牌失效，而钥匙串中的目标账号有效，可仅在本次进程中排除失效环境变量：

```bash
env -u GITHUB_TOKEN -u GH_TOKEN npm run release
```

脚本不会自动忽略指定凭据或改写全局认证配置。GitHub 按 tag 查询可能不返回草稿；脚本会在明确的 404 后查询当前账号可见的发布列表，识别已有草稿并继续。


运行中以 `.git/kiokunet-release.lock`（实际位置由 Git 决定）互斥。正常结束或可捕获错误会释放锁；强制终止后请先确认没有运行中的发布进程，再人工移除遗留锁。

上传或 npm 发布失败后保留 tag 和草稿，不自动回滚。重跑同一命令会重新构建，下载已有附件比较哈希，只补上传缺失项。已有附件不一致或处于未完成上传状态时停止，由维护者检查草稿；脚本不自动覆盖或删除附件。已公开 Release 缺少附件也会停止，避免静默修改历史发布。

GitHub 与 npm 无法原子发布：npm 成功后 GitHub 公开失败时，npm 包已经可见，GitHub 保留草稿。重跑会读取 npm 的实际状态；相同版本且 SHA-512 integrity 一致则跳过发布，不需要重复上传，也不回退或改写已有 dist-tag。不一致则停止，必须排查或使用新版本。脚本不会 unpublish、覆盖 npm 版本或撤回公开的 GitHub Release。

如果网络在 npm 上传或最终公开操作后中断，不要假定发布失败：重跑会读取远端实际状态。若 registry 尚未能读到刚发布的版本，本次停止，稍后重跑即可。正式包更新请增加版本，不覆盖旧版本。

## 用户安装

从 npm 安装（包名为 `@reus-able/kioku-net`，命令为 `kioku`）：

```bash
npm install -g @reus-able/kioku-net
kioku --help
# 预发布版本：npm install -g @reus-able/kioku-net@next
# 固定版本：npm install -g @reus-able/kioku-net@<version>
```

也可从对应 Release 下载 `.tgz` 与 `SHA256SUMS`，然后执行：

```bash
# Linux
sha256sum -c SHA256SUMS
# macOS 则使用：shasum -a 256 -c SHA256SUMS
npm install -g ./reus-able-kioku-net-<version>.tgz
kioku --help
```

请下载脚本上传的 npm 安装包。GitHub 自动提供的 Source code 压缩包是源码，不包含编译后的 `dist/`。

接口依据：[gh release create](https://cli.github.com/manual/gh_release_create)、[gh release upload](https://cli.github.com/manual/gh_release_upload)、[npm publish](https://docs.npmjs.com/cli/v10/commands/npm-publish/)、[npm view](https://docs.npmjs.com/cli/v10/commands/npm-view/)。
