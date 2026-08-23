/**
 * Pi + Gondolin Sandbox Example (pi extension)
 *
 * This extension overrides pi's built-in `read`/`write`/`edit`/`bash` tools so
 * they execute inside a Gondolin micro-VM instead of on the host.
 *
 * The directory you start `pi` in is mounted read-write at `/workspace` inside
 * the VM.
 *
 * How to run:
 *   1. Install dependencies for this repo (so imports resolve):
 *        pnpm install
 *   2. Ensure QEMU is installed (see the gondolin README "Quick Start")
 *   3. Start pi in the project you want to sandbox:
 *        cd /path/to/your/project
 *        pi -e /absolute/path/to/gondolin/host/examples/pi-gondolin.ts
 *
 * Notes:
 *   - The VM is started on `session_start` (and lazily if a tool is used before that)
 *   - User `!` commands are also executed inside the VM
 *   - Module resolution happens relative to this file, so keeping it inside the
 *     gondolin repo (or installing `@earendil-works/gondolin` next to it) is easiest
 */

import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

import {
  RealFSProvider,
  type VirtualProvider,
  VM,
  createHttpHooks,
} from "@earendil-works/gondolin";

const GUEST_WORKSPACE = "/workspace";

/**
 * Build the guest mount map: always mount the pi working directory at
 * /workspace, plus optional extra mounts from GONDOLIN_MOUNTS, a
 * semicolon-separated list of "hostPath[:guestPath]" entries, e.g.
 *   GONDOLIN_MOUNTS="/home/u/data:/data;/home/u/keys"
 * A bare host path (no ":guest") is mounted at /mnt/<basename>.
 * Host paths that do not exist are skipped with a warning.
 */
const CONFIG_PATH = path.join(import.meta.dirname, "vm-config.jsonc");

/**
 * Strip // line comments and /* block comments *\/ from JSONC text without
 * touching strings (so quotes, URLs and escaped chars survive).
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Recursively replace ${VAR} in strings with the host environment value.
 * Lets the config reference env vars, e.g. "agent": "${SSH_AUTH_SOCK}".
 */
function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_m, name: string) => process.env[name] ?? "",
    );
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, expandEnv(v)]),
    );
  }
  return value;
}

/**
 * Read the HOST's git identity (user.name / user.email) so the VM inherits
 * it. Git respects GIT_AUTHOR_* / GIT_COMMITTER_* env vars over config files,
 * which is how the guest gets the user's real identity.
 */
function gitIdentity(): { name?: string; email?: string } {
  const read = (key: string): string | undefined => {
    try {
      return (
        execSync(`git config --get ${key}`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim() || undefined
      );
    } catch {
      return undefined;
    }
  };
  return { name: read("user.name"), email: read("user.email") };
}

/** Load VM settings from vm-config.json next to this file; {} when missing. */
function loadConfig(): Record<string, any> {
  try {
    return expandEnv(
      JSON.parse(stripJsonComments(fs.readFileSync(CONFIG_PATH, "utf8"))),
    ) as Record<string, any>;
  } catch {
    return {};
  }
}

/**
 * SSH egress proxy via the host ssh-agent (the key never enters the VM).
 * Disabled entirely when the host has no ssh-agent socket.
 */
function buildSsh(
  ssh?: Record<string, any>,
): Record<string, unknown> | undefined {
  const agent = process.env.SSH_AUTH_SOCK;
  if (!agent || !ssh) return undefined;
  return {
    ...ssh,
    agent,
    knownHostsFile: `${process.env.HOME}/.ssh/known_hosts`,
  };
}

/**
 * Build the guest mount map: always mount the pi working directory at
 * /workspace, plus extra mounts from the config file and/or the
 * GONDOLIN_MOUNTS env var ("hostPath[:guestPath]" separated by ";").
 * A bare host path (no ":guest") is mounted at /mnt/<basename>.
 * Host paths that do not exist are skipped with a warning.
 */
function buildMounts(
  localCwd: string,
  configMounts: string[],
): Record<string, VirtualProvider> {
  const mounts: Record<string, VirtualProvider> = {
    [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
  };
  const specs = [...configMounts];
  const extra = process.env.GONDOLIN_MOUNTS;
  if (extra) specs.push(...extra.split(";"));
  for (const spec of specs) {
    if (!spec.trim()) continue;
    const idx = spec.indexOf(":");
    let host: string;
    let guest: string;
    if (idx === -1) {
      host = spec.trim();
      guest = path.posix.join("/mnt", path.basename(host));
    } else {
      host = spec.slice(0, idx).trim();
      guest = spec.slice(idx + 1).trim();
    }
    if (!host || !guest) continue;
    if (!fs.existsSync(host)) {
      console.warn(
        `[pi-gondolin] skipping mount: host path not found: ${host}`,
      );
      continue;
    }
    mounts[guest] = new RealFSProvider(path.resolve(host));
  }
  return mounts;
}

function shQuote(value: string): string {
  // POSIX shell quoting: wraps in single quotes and escapes internal quotes
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

let cachedMountPrefixes: string[] | null = null;

/**
 * Collect all guest mount prefixes: /workspace, /mnt (bare mounts), /data,
 * plus every guest path from the config file and GONDOLIN_MOUNTS.
 */
function guestMountPrefixes(): string[] {
  if (cachedMountPrefixes) return cachedMountPrefixes;
  const prefixes = [GUEST_WORKSPACE, "/mnt", "/data"];
  const specs: string[] = [...(loadConfig().mounts ?? [])];
  const extra = process.env.GONDOLIN_MOUNTS;
  if (extra) specs.push(...extra.split(";"));
  for (const spec of specs) {
    const idx = spec.indexOf(":");
    const guest = idx === -1 ? null : spec.slice(idx + 1).trim();
    if (guest) prefixes.push(guest);
  }
  cachedMountPrefixes = prefixes;
  return prefixes;
}

function toGuestPath(localCwd: string, localPath: string): string {
  // The model lives inside the VM, so it passes guest-visible paths
  // (/workspace/..., /mnt/..., /data/...). Normalize and pass those
  // through directly (normalize also rejects traversal like
  // /workspace/../etc/passwd, which would escape the mount).
  const norm = path.posix.normalize(localPath);
  const prefixes = guestMountPrefixes();
  if (
    prefixes.some(
      (p) => norm === p || norm.startsWith(`${p}/`),
    )
  ) {
    return norm;
  }
  // Otherwise treat the path as host-relative / host-absolute and map
  // it into /workspace (relative to the pi working directory).
  const abs = path.resolve(localCwd, localPath);
  const rel = path.relative(localCwd, abs);
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  // Convert platform separators to POSIX for the Linux guest
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(GUEST_WORKSPACE, posixRel);
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
  return {
    readFile: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      const r = await vm.exec(["/bin/cat", guestPath]);
      if (!r.ok) {
        throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
      }
      return r.stdoutBuffer;
    },
    access: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      const r = await vm.exec([
        "/bin/sh",
        "-lc",
        `test -r ${shQuote(guestPath)}`,
      ]);
      if (!r.ok) {
        throw new Error(`not readable: ${p}`);
      }
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      try {
        // Run through the shell because `file` might live in `/usr/bin` depending on the image
        const r = await vm.exec([
          "/bin/sh",
          "-lc",
          `file --mime-type -b ${shQuote(guestPath)}`,
        ]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          m,
        )
          ? m
          : null;
      } catch {
        return null;
      }
    },
  };
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
  return {
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p);
      const dir = path.posix.dirname(guestPath);

      // Base64 roundtrip to avoid quoting issues
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const script = [
        `set -eu`,
        `mkdir -p ${shQuote(dir)}`,
        `echo ${shQuote(b64)} | base64 -d > ${shQuote(guestPath)}`,
      ].join("\n");

      const r = await vm.exec(["/bin/sh", "-lc", script]);
      if (!r.ok) {
        throw new Error(`write failed (${r.exitCode}): ${r.stderr}`);
      }
    },
    mkdir: async (dir) => {
      const guestDir = toGuestPath(localCwd, dir);
      const r = await vm.exec(["/bin/mkdir", "-p", guestDir]);
      if (!r.ok) {
        throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
      }
    },
  };
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
  const r = createGondolinReadOps(vm, localCwd);
  const w = createGondolinWriteOps(vm, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function sanitizeEnv(
  env?: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function createGondolinBashOps(vm: VM, localCwd: string): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const guestCwd = toGuestPath(localCwd, cwd);

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;

      try {
        // `/bin/bash -lc` for a familiar environment (pipelines, expansions, etc.)
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          env: sanitizeEnv(env),
          stdout: "pipe",
          stderr: "pipe",
        });

        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Build an English environment note describing the VM, mounted host dirs,
 * sandboxfs exec limitation and inherited git identity; injected into the
 * system prompt so the model knows where it is and what to avoid.
 */
function buildEnvNote(config: Record<string, any>): string {
  const mounts: string[] = [GUEST_WORKSPACE];
  for (const spec of config.mounts ?? []) {
    const idx = spec.indexOf(":");
    if (idx === -1) mounts.push(`/mnt/${path.basename(spec)}`);
    else mounts.push(spec.slice(idx + 1).trim());
  }
  const list = mounts.map((m) => `- ${m}`).join("\n");
  return [
    "Environment:",
    "You are running inside a Gondolin micro-VM (Linux). The host directory you started pi in is mounted at /workspace.",
    "Mounted host directories:",
    list,
    "Important notes:",
    "- This is a FRESH environment: the VM was just started and everything was reset. Anything not on the mounted host directories is gone (/tmp, /root, installed packages, shell history, env tweaks). Only the mounted host directories listed above persist, because they live on the host. Do NOT assume state from earlier sessions survives.",
    "- Files on mounted directories (sandboxfs) CANNOT be made executable with chmod +x; build/compile artifacts belong on the VM's own disk (e.g. /tmp), not on mounts.",
    "- Git author/committer identity (GIT_AUTHOR_NAME / GIT_COMMITTER_NAME / GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL) is automatically inherited from the host; do NOT run `git config` to set user.name/user.email yourself.",
  ].join("\n");
}

let envNoteInjected = false;

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;

  async function ensureVm(ctx?: ExtensionContext) {
    if (vm) return vm;
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: starting (mount ${GUEST_WORKSPACE})`,
        ),
      );

      const config = loadConfig();
      const identity = config.gitIdentity === false ? {} : gitIdentity();
      const hooks = createHttpHooks({
        secrets: Object.fromEntries(
          Object.entries(config.secrets ?? {}).map(([name, secret]) => [
            name,
            {
              hosts: secret.hosts,
              value: process.env[secret.valueFromEnv] ?? "",
            },
          ]),
        ),
      });

      const created = await VM.create({
        // vm-config.json IS the VM.create options, plus two JSON-friendly
        // extras: `mounts` (strings -> vfs providers) and `secrets` (-> http hooks).
        ...config,
        ssh: buildSsh(config.ssh),
        vfs: {
          mounts: buildMounts(localCwd, config.mounts ?? []),
        },
        httpHooks: hooks.httpHooks,
        env: {
          // Guest ssh/git talks to the host-side proxy whose host key is
          // ephemeral, so skip host-key verification inside the guest (the
          // host still verifies the real upstream against known_hosts).
          GIT_SSH_COMMAND:
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null -o LogLevel=ERROR",
          // inherit the host's git identity (disable with "gitIdentity": false)
          ...(identity.name
            ? { GIT_AUTHOR_NAME: identity.name, GIT_COMMITTER_NAME: identity.name }
            : {}),
          ...(identity.email
            ? {
                GIT_AUTHOR_EMAIL: identity.email,
                GIT_COMMITTER_EMAIL: identity.email,
              }
            : {}),
          ...hooks.env,
          ...(config.env ?? {}),
        },
      });

      vm = created;
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: running (${localCwd} -> ${GUEST_WORKSPACE})`,
        ),
      );
      ctx?.ui.notify(
        `Gondolin VM ready. Host ${localCwd} mounted at ${GUEST_WORKSPACE}`,
        "info",
      );
      return created;
    })();

    return vmStarting;
  }

  pi.on("session_start", async (_event, ctx) => {
    // Start eagerly so the user sees errors early (missing qemu, etc.)
    envNoteInjected = false; // each fresh session gets one env note
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!vm) return;
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Gondolin: stopping"),
    );
    try {
      await vm.close();
    } finally {
      vm = null;
      vmStarting = null;
    }
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(localCwd, {
        operations: createGondolinReadOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(localCwd, {
        operations: createGondolinWriteOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(localCwd, {
        operations: createGondolinEditOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // Run user `!` commands inside the VM too
  pi.on("user_bash", (_event, ctx) => {
    if (!vm) return;
    return { operations: createGondolinBashOps(vm, localCwd) };
  });

  // Replace the CWD line in the system prompt so the model sees /workspace
  pi.on("before_agent_start", async (event, ctx) => {
    await ensureVm(ctx);
    // system prompt: only fix the CWD line (a system-prompt concern).
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM, mounted from host: ${localCwd})`,
    );
    // user context: inject the environment note as a persistent message on
    // the FIRST user turn only, so it rides along with the conversation
    // instead of being baked into the system prompt.
    const result: Record<string, unknown> = { systemPrompt: modified };
    if (!envNoteInjected) {
      envNoteInjected = true;
      result.message = {
        customType: "gondolin-env",
        content: buildEnvNote(loadConfig()),
        display: true,
      };
    }
    return result;
  });
}
