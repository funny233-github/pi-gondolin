#!/usr/bin/env node
// Regenerate the installed vm-config.jsonc from the example template.
// The current config (if any) is backed up to vm-config.jsonc.bak first.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root = path.resolve(import.meta.dirname, "..");
const home = os.homedir();
const extDir = path.join(home, ".pi", "agent", "extensions", "gondolin");
const example = path.join(root, "vm-config.example.jsonc");
const cfgBase = "vm-config.jsonc";
const target = path.join(extDir, cfgBase);

if (!fs.existsSync(example)) {
  console.error(`template not found: ${example}`);
  process.exit(1);
}

if (fs.existsSync(target)) {
  const bak = `${target}.bak`;
  fs.copyFileSync(target, bak);
  console.log(`backed up current config -> ${path.basename(bak)}`);
}

fs.copyFileSync(example, target);
console.log(`regenerated ${cfgBase} -> ${target} from template`);
console.log("edit it and restart pi to apply.");
