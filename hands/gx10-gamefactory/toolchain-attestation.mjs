import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";

const paths = Object.freeze({
  launcher: "/opt/dominion-sandbox/fd-launcher",
  nodeFilter: "/opt/dominion-sandbox/node-seccomp.bpf",
  godotFilter: "/opt/dominion-sandbox/godot-seccomp.bpf",
  node: "/opt/dominion-payload/node",
  godot: "/opt/dominion-payload/godot",
});
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const artifact = (path) => {
  const real = realpathSync(path), metadata = statSync(real, { bigint: true });
  if (real !== path || !metadata.isFile()) throw new Error(`attested artifact ${path} is not an exact regular file`);
  return { path: real, sha256: sha256(real), uid: String(metadata.uid), gid: String(metadata.gid),
    dev: String(metadata.dev), ino: String(metadata.ino), nlink: String(metadata.nlink),
    mode: (Number(metadata.mode) & 0o7777).toString(8), size: String(metadata.size) };
};
console.log(JSON.stringify({
  ok: true,
  architecture: process.arch,
  protocol: "dominion-fd-launcher/1",
  artifacts: Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, artifact(path)])),
  programs: ["node", "godot"],
  capabilities: ["quality_assurance", "godot"],
  android: { enabled: false, sdkPresent: false, licenseLayerPresent: false },
}, null, 2));
