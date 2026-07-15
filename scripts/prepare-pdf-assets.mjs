import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pdfjsRoot = resolve(root, "apps/web/node_modules/pdfjs-dist");
const publicRoot = resolve(root, "apps/web/public/pdfjs");

if (!existsSync(pdfjsRoot)) {
  throw new Error(`pdfjs-dist was not found at ${pdfjsRoot}. Run pnpm install first.`);
}

for (const directory of ["cmaps", "standard_fonts"]) {
  const source = resolve(pdfjsRoot, directory);
  const destination = resolve(publicRoot, directory);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });
}
