#!/usr/bin/env node
// One-shot install: install deps, then register this extension with pi by
// copying index.ts and linking node_modules into ~/.pi/agent/extensions/gondolin.
// Idempotent: safe to run repeatedly.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const home = os.homedir();
const extDir = path.join(home, ".pi", "agent", "extensions", "gondolin");

// 1) dependencies (skip lifecycle scripts to avoid recursion into this script)
execSync("npm install --ignore-scripts", { cwd: root, stdio: "inherit" });

// 2) extension entry point
fs.mkdirSync(extDir, { recursive: true });
const indexSrc = path.join(root, "index.ts");
const indexDst = path.join(extDir, "index.ts");
fs.copyFileSync(indexSrc, indexDst);
console.log(`installed index.ts -> ${indexDst}`);

// 3) link node_modules so imports resolve relative to the extension dir
const nmLink = path.join(extDir, "node_modules");
fs.rmSync(nmLink, { recursive: true, force: true });
fs.symlinkSync(path.join(root, "node_modules"), nmLink);
console.log(`linked node_modules -> ${nmLink}`);

// 4) VM config: generate from example if missing, then install a copy
const cfgExample = path.join(root, "vm-config.example.jsonc");
const cfgTarget = path.join(root, "vm-config.jsonc");
const cfgBase = path.basename(cfgTarget);
if (!fs.existsSync(cfgTarget)) {
  fs.copyFileSync(cfgExample, cfgTarget);
  console.log(`generated ${cfgTarget} (edit it to customize the VM)`);
} else {
  // Backup existing config before overwriting
  const backupPath = path.join(extDir, `${cfgBase}.bak`);
  fs.copyFileSync(cfgTarget, backupPath);
  console.log(`backed up ${cfgTarget} -> ${backupPath}`);
}
// remove legacy .json config copy if present
fs.rmSync(path.join(extDir, "vm-config.json"), { force: true });
fs.copyFileSync(cfgTarget, path.join(extDir, cfgBase));
console.log(`installed ${cfgBase} -> ${path.join(extDir, cfgBase)}`);

console.log("pi-gondolin extension installed. Restart pi to load it.");
