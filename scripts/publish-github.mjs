import fs from "node:fs";
import { execFileSync } from "node:child_process";

const manifest = new URL("../package.json", import.meta.url);
const original = fs.readFileSync(manifest, "utf8");
const pkg = JSON.parse(original);

pkg.name = "@eamonpluto/crewbus";
fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);

try {
  execFileSync("npm", [
    "publish",
    "--registry", "https://npm.pkg.github.com",
    "--@eamonpluto:registry=https://npm.pkg.github.com",
  ], { stdio: "inherit", shell: process.platform === "win32" });
} finally {
  fs.writeFileSync(manifest, original);
}
