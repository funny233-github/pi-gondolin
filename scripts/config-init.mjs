#!/usr/bin/env node
// Regenerate vm-config.jsonc from the example template.
// The current config (if any) is backed up to vm-config.jsonc.bak first.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const example = path.join(root, "vm-config.example.jsonc");
const target = path.join(root, "vm-config.jsonc");

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
console.log(`regenerated ${path.basename(target)} from template`);
console.log("edit it and restart pi to apply.");
