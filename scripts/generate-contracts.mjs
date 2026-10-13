import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { _ } from "ajv/dist/compile/codegen/index.js";
import standalone from "ajv/dist/standalone/index.js";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const spec = JSON.parse(readFileSync(resolve(root, "packages/protocol/openapi.json"), "utf8"));
const schemas = spec.components.schemas;
const messages = spec["x-websocket-messages"];
const httpNames = Object.keys(schemas).filter(
  (name) => name.endsWith("Request") || name.endsWith("Response"),
);
const generated = "// Generated from packages/protocol/openapi.json. Do not edit.\n";
const check = process.argv.includes("--check");
const outputs = new Map();
const reference = (schema) => schema.$ref?.split("/").at(-1);
const nonNull = (schema) => schema.anyOf?.find((option) => option.type !== "null") ?? schema;

function tsType(schema) {
  if (schema.anyOf) return schema.anyOf.map(tsType).join(" | ");
  if (schema.oneOf) return schema.oneOf.map(tsType).join(" | ");
  if (schema.$ref) return reference(schema);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.type === "array") return `Array<${tsType(schema.items)}>`;
  if (schema.type === "object") return "Record<string, unknown>";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (["string", "boolean", "null"].includes(schema.type)) return schema.type;
  throw new Error(`Unsupported schema: ${JSON.stringify(schema)}`);
}

function goType(input) {
  const schema = nonNull(input);
  if (schema.$ref) return reference(schema);
  if (schema.type === "array") return `[]${goType(schema.items)}`;
  if (schema.type === "object") return "map[string]any";
  if (schema.type === "integer")
    return schema.const !== undefined || schema.maximum < 600 ? "int" : "int64";
  if (schema.type === "string") return "string";
  if (schema.type === "boolean") return "bool";
  throw new Error(`Unsupported Go schema: ${JSON.stringify(schema)}`);
}

function goName(name) {
  return name
    .replace(/(^|_)([a-z])/g, (match, prefix, letter) => letter.toUpperCase())
    .replace(/Ids$/, "IDs")
    .replace(/Id$/, "ID")
    .replace(/Ms$/, "MS");
}

let ts = `${generated}\nexport const PROTOCOL_VERSION = ${spec["x-protocol-version"]} as const;\nexport const MAX_CONTENT_BYTES = ${schemas.Content["x-max-utf8-bytes"]};\nexport const MAX_REVISION = ${schemas.Revision.maximum};\nexport const MAX_IDENTIFIER_BYTES = ${schemas.Identifier["x-max-utf8-bytes"]};\nexport const errorCodes = ${JSON.stringify(schemas.ErrorCode.enum)} as const;\n`;
let go = `${generated}package protocol\n\nconst (\nVersion = ${spec["x-protocol-version"]}\nMaxContentBytes = ${schemas.Content["x-max-utf8-bytes"]}\nMaxRevision = int64(${schemas.Revision.maximum})\nMaxIdentifierBytes = ${schemas.Identifier["x-max-utf8-bytes"]}\n)\n`;

for (const [name, schema] of Object.entries(schemas)) {
  if (name === "Envelope") {
    ts += `\nexport type Envelope = ${tsType(schema)};\n`;
    go += "\ntype Envelope interface { isEnvelope() }\n";
    continue;
  }
  if (name === "ErrorCode") {
    ts += "\nexport type ErrorCode = (typeof errorCodes)[number];\n";
    go += "\ntype ErrorCode string\nconst (\n";
    schema.enum.forEach((value, index) => {
      go += `${schema["x-go-enum-names"][index]} ErrorCode = ${JSON.stringify(value)}\n`;
    });
    go += ")\n";
    go += `func validErrorCode(value ErrorCode) bool { switch value { case ${schema["x-go-enum-names"].join(", ")}: return true }; return false }\n`;
    continue;
  }
  if (schema.properties) {
    const parent = schema["x-go-embed"];
    const inherited = new Set(Object.keys(schemas[parent]?.properties ?? {}));
    ts += `\nexport interface ${name}${parent ? ` extends ${parent}` : ""} {\n`;
    go += `\ntype ${name} struct {\n${parent ? parent + "\n" : ""}`;
    for (const [key, field] of Object.entries(schema.properties)) {
      if (inherited.has(key)) continue;
      const optional = !schema.required.includes(key);
      ts += `${key}${optional ? "?" : ""}: ${tsType(field)};\n`;
      let type = goType(field);
      if (optional && !type.startsWith("[]") && !type.startsWith("map[")) type = `*${type}`;
      go += `${goName(key)} ${type} \`json:"${key}${optional ? ",omitempty" : ""}"\`\n`;
    }
    ts += "}\n";
    go += "}\n";
  } else {
    ts += `\nexport type ${name} = ${tsType(schema)};\n`;
    go += `\ntype ${name} = ${goType(schema)}\n`;
  }
  if (messages.includes(name)) go += `func (*${name}) isEnvelope() {}\n`;
}
ts += `\nexport interface HttpPayloads {\n${httpNames.map((name) => `${name}: ${name};`).join("\n")}\n}\n`;
outputs.set("packages/protocol/src/types.ts", ts);
outputs.set(
  "apps/server/internal/protocol/types.go",
  execFileSync("gofmt", { input: go, encoding: "utf8" }),
);

const schema = JSON.parse(
  JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://jotter.invalid/protocol.schema.json",
    $defs: schemas,
  }).replaceAll("#/components/schemas/", "#/$defs/"),
);
outputs.set("apps/server/internal/protocol/schema.json", `${JSON.stringify(schema, null, 2)}\n`);
const ajv = new Ajv({ strict: false, allErrors: false, code: { source: true, esm: true } });
addFormats(ajv, ["date-time"]);
ajv.addKeyword({
  keyword: "x-max-utf8-bytes",
  type: "string",
  schemaType: "number",
  code(context) {
    const value = context.parentSchema["x-normalize-line-endings"]
      ? _`${context.data}.replace(/\\r\\n?/g, "\\n")`
      : context.data;
    context.fail(_`new TextEncoder().encode(${value}).byteLength > ${context.schema}`);
  },
});
ajv.addSchema(schema);
const exports = Object.fromEntries(
  ["Envelope", ...httpNames].map((name) => [name, `${schema.$id}#/$defs/${name}`]),
);
const bundled = await build({
  stdin: { contents: standalone(ajv, exports), resolveDir: root, sourcefile: "validators.mjs" },
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  write: false,
});
outputs.set("packages/protocol/src/validators.js", `${generated}${bundled.outputFiles[0].text}`);
const fingerprint = (text) => createHash("sha256").update(text).digest("hex");
let notices = `# Third-party notices\n\nGenerated by \`mise run contracts:generate\`; checked with the contracts. \`packages/protocol/src/validators.js\` includes runtime code from the MIT-licensed dependencies below. Its SHA-256 is \`${fingerprint(outputs.get("packages/protocol/src/validators.js"))}\`. Other installed dependencies retain their own licenses; distributed builds include generated dependency notices.\n`;
for (const [name, version, repository, commit] of [
  ["ajv", "8.20.0", "ajv-validator/ajv", "0fba0b8e649909613cfce0999b149cd08f4a4987"],
  ["ajv-formats", "3.0.1", "ajv-validator/ajv-formats", "1fb3fa7d967f919ff924bb34aef73a2f39ab0de3"],
]) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "node_modules", name, "package.json"), "utf8"),
  );
  if (manifest.version !== version) throw new Error(`Refresh upstream attribution for ${name}`);
  const license = readFileSync(resolve(root, "node_modules", name, "LICENSE"), "utf8");
  notices += `\n## ${name} ${version}\n\nSource: [${repository}](https://github.com/${repository}/tree/${commit}). Upstream commit: \`${commit}\` (published package gitHead). License: MIT. LICENSE SHA-256: \`${fingerprint(license)}\`.\n\n\`\`\`text\n${license.trimEnd()}\n\`\`\`\n`;
}
outputs.set("THIRD_PARTY_NOTICES.md", notices);
outputs.set(
  "packages/protocol/src/validators.d.ts",
  `${generated}interface Validator { (value: unknown): boolean; errors?: Array<{ keyword: string; instancePath: string }> | null; }\n${Object.keys(
    exports,
  )
    .map((name) => `export const ${name}: Validator;`)
    .join("\n")}\n`,
);

for (const [name, contents] of outputs) {
  const file = resolve(root, name);
  const formatted = name.endsWith(".ts")
    ? execFileSync(
        "pnpm",
        ["--dir", "packages/protocol", "exec", "oxfmt", "--stdin-filepath", name],
        { cwd: root, input: contents, encoding: "utf8" },
      )
    : contents;
  if (check) {
    if (readFileSync(file, "utf8") !== formatted)
      throw new Error(`${name} drifted; run mise run contracts:generate`);
  } else writeFileSync(file, formatted);
}
