import { execFileSync } from "node:child_process";
import { mkdir, copyFile, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";

const home = resolve(".tools/dependencies");
const result = JSON.parse(
  execFileSync(
    process.execPath,
    [resolve("dist/cli.js"), "deps", "install", "--home", home, "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ),
);
if (!result.ok) throw new Error(JSON.stringify(result.error));
await mkdir(resolve(".tools"), { recursive: true });
for (const name of ["syncthing"]) {
  const target = resolve(join(".tools", name));
  if (resolve(result.data[name]) !== target)
    await copyFile(result.data[name], target);
  await chmod(target, 0o700);
}
console.log(
  "Integration binaries ready in .tools/ (not included in the package).",
);
