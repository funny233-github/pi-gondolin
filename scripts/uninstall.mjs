#!/usr/bin/env node
// One-shot uninstall: remove the extension files this project installed into
// ~/.pi/agent/extensions/gondolin (index.ts + node_modules link).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const extDir = path.join(home, ".pi", "agent", "extensions", "gondolin");

for (const name of ["index.ts", "node_modules"]) {
  const p = path.join(extDir, name);
  fs.rmSync(p, { recursive: true, force: true });
  console.log(`removed ${p}`);
}

// drop the dir itself if it is now empty
try {
  fs.rmdirSync(extDir);
  console.log(`removed empty dir ${extDir}`);
} catch {
  // not empty (user files) or already gone; leave it alone
}

console.log("pi-gondolin extension uninstalled.");
