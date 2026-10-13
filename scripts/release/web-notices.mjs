import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const packages = [
  ["ajv", "node_modules/ajv"],
  ["ajv-formats", "node_modules/ajv-formats"],
  ["idb", "apps/web/node_modules/idb"],
];
let notices = "Jotter web dependency notices\n";
for (const [name, directory] of packages) {
  const manifest = JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8"));
  const license = readFileSync(resolve(root, directory, "LICENSE"));
  if (manifest.name !== name || !manifest.version || license.length === 0) {
    throw new Error(`Missing dependency attribution: ${name}`);
  }
  notices += `\n${name}@${manifest.version}\nSource: https://www.npmjs.com/package/${name}/v/${manifest.version}\nLicense: ${manifest.license}\nLICENSE SHA-256: ${createHash("sha256").update(license).digest("hex")}\n\n${license.toString("utf8").trimEnd()}\n`;
}
const output = resolve(root, "apps/web", process.env.JOTTER_WEB_DIST ?? "dist");
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "licenses.txt"), notices);
