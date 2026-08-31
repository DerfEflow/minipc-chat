import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createPortfolioSpecificationManifest } from "./gamefactorytemplates.mjs";

const targetArg = process.argv[2];
if (!targetArg) {
  console.error("Usage: node generate-gamefactory-portfolio.mjs <absolute-Games-directory>");
  process.exitCode = 2;
} else if (!isAbsolute(targetArg)) {
  console.error("Refusing a relative output path; pass the exact absolute Games directory.");
  process.exitCode = 2;
} else {
  const root = resolve(targetArg);
  const manifest = createPortfolioSpecificationManifest();
  const targets = manifest.map((file) => {
    const destination = resolve(root, ...file.relativePath.split("/"));
    const rel = relative(root, destination);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Unsafe manifest path: ${file.relativePath}`);
    return { ...file, destination };
  });

  const existing = [];
  for (const file of targets) {
    try {
      await lstat(file.destination);
      existing.push(file.destination);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (existing.length) {
    console.error(`Refusing to overwrite ${existing.length} existing file(s). First conflict: ${existing[0]}`);
    process.exitCode = 3;
  } else {
    for (const file of targets) {
      await mkdir(dirname(file.destination), { recursive: true });
      await writeFile(file.destination, file.content, { encoding: "utf8", flag: "wx" });
    }
    console.log(`Created ${targets.length} new portfolio files under ${root}; no existing file was overwritten.`);
  }
}
