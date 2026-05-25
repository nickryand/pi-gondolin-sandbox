/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Portions of this file are derived from the Gondolin pi sandbox example:
 * https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts
 */

/**
 * Pi + Gondolin Sandbox Example (pi extension)
 *
 * This extension overrides pi's built-in `read`/`write`/`edit`/`bash` tools so
 * they execute inside a Gondolin micro-VM instead of on the host.
 *
 * The directory you start `pi` in is mounted read-write at
 * `/workspace/<project-folder-name>` inside the VM.
 *
 * How to run:
 *   1. Install dependencies for this repo (so imports resolve):
 *        pnpm install
 *   2. Ensure QEMU is installed (see the gondolin README "Quick Start")
 *   3. Install this package in pi configuration:
 *        pi install /absolute/path/to/pi-gondolin
 *      or project-local:
 *        pi install -l /absolute/path/to/pi-gondolin
 *   4. Start pi in the project you want to sandbox:
 *        cd /path/to/your/project
 *        pi
 *
 *      For quick testing without installing, use:
 *        pi -e /absolute/path/to/pi-gondolin
 *
 * Notes:
 *   - The VM is started on `session_start` (and lazily if a tool is used before that)
 *   - User `!` commands are also executed inside the VM
 *   - Module resolution happens relative to this file, so keeping it inside the
 *     gondolin repo (or installing `@earendil-works/gondolin` next to it) is easiest
 */

import path from "node:path";

import { ensureGondolinImage } from "./image.ts";
import {
  getGondolinImageTag,
  loadGondolinSettings,
  normalizeMountSpecs,
} from "./settings.ts";

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

import Gondolin from "@earendil-works/gondolin";

const { RealFSProvider, VM } = Gondolin;

const GUEST_WORKSPACE_ROOT = "/workspace";

function getGuestProjectWorkspace(localCwd: string): string {
  return path.posix.join(
    GUEST_WORKSPACE_ROOT,
    path.basename(localCwd) || "project",
  );
}

function shQuote(value: string): string {
  // POSIX shell quoting: wraps in single quotes and escapes internal quotes
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function toGuestPath(localCwd: string, localPath: string): string {
  // pi tools pass absolute local paths; map them into /workspace/<project>.
  const guestProjectWorkspace = getGuestProjectWorkspace(localCwd);
  const rel = path.relative(localCwd, localPath);
  if (rel === "") return guestProjectWorkspace;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  // Convert platform separators to POSIX for the Linux guest
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(guestProjectWorkspace, posixRel);
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

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  const gondolinSettings = loadGondolinSettings(localCwd);
  const additionalMountSpecs = normalizeMountSpecs(localCwd, gondolinSettings);
  const imageTag = getGondolinImageTag(gondolinSettings);
  const guestProjectWorkspace = getGuestProjectWorkspace(localCwd);

  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;
  let imageEnsuring: Promise<boolean> | null = null;

  function createRealFSProviderFromSpec(spec: Record<string, unknown>) {
    const hostPath = spec.hostPath ?? spec.path ?? spec.root;
    if (typeof hostPath !== "string") {
      throw new Error("mount spec must include a string path, hostPath, or root");
    }

    const { hostPath: _hostPath, path: _path, root: _root, options, ...rest } =
      spec;
    const providerOptions = {
      ...rest,
      ...(options && typeof options === "object" ? options : {}),
    };

    return new (RealFSProvider as any)(hostPath, providerOptions);
  }

  function createMounts() {
    const mounts: Record<string, any> = {
      [guestProjectWorkspace]: new RealFSProvider(localCwd),
    };

    for (const [guestPath, spec] of Object.entries(additionalMountSpecs)) {
      if (guestPath === guestProjectWorkspace) {
        throw new Error(
          `${guestProjectWorkspace} is reserved for the project mount`,
        );
      }
      mounts[guestPath] = createRealFSProviderFromSpec(
        spec as Record<string, unknown>,
      );
    }

    return mounts;
  }

  async function ensureImage(
    ctx?: ExtensionContext,
    options?: { forceBuild?: boolean; promptReloadIfRunning?: boolean },
  ): Promise<boolean> {
    if (!imageTag) return false;
    if (imageEnsuring && !options?.forceBuild) return imageEnsuring;

    imageEnsuring = (async () => {
      const result = await ensureGondolinImage(localCwd, imageTag, undefined, {
        forceBuild: options?.forceBuild,
      });
      const built = result.status === "built";
      if (built && options?.promptReloadIfRunning && vm) {
        ctx?.ui.notify(
          "Gondolin image rebuilt. Run /gondolin reload to restart the VM with the new image.",
          "info",
        );
      }
      return built;
    })();

    try {
      return await imageEnsuring;
    } finally {
      imageEnsuring = null;
    }
  }

  async function ensureVm(ctx?: ExtensionContext) {
    if (vm) {
      await ensureImage(ctx, { promptReloadIfRunning: true });
      return vm;
    }
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: starting (mount ${guestProjectWorkspace})`,
        ),
      );

      await ensureImage(ctx);

      const created = await VM.create({
        ...(imageTag ? { sandbox: { imagePath: imageTag } } : {}),
        vfs: {
          mounts: createMounts(),
        },
      });

      vm = created;
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: running (${localCwd} -> ${guestProjectWorkspace})`,
        ),
      );
      ctx?.ui.notify(
        `Gondolin VM ready. Host ${localCwd} mounted at ${guestProjectWorkspace}`,
        "info",
      );
      return created;
    })();

    return vmStarting;
  }

  async function stopVm(ctx?: ExtensionContext) {
    if (!vm) return;
    ctx?.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Gondolin: stopping"),
    );
    try {
      await vm.close();
    } finally {
      vm = null;
      vmStarting = null;
    }
  }

  async function reloadVm(ctx?: ExtensionContext) {
    await stopVm(ctx);
    return ensureVm(ctx);
  }

  async function buildImageFromCommand(ctx?: ExtensionContext) {
    if (!imageTag) {
      ctx?.ui.notify("No Gondolin image tag configured.", "warning");
      return;
    }
    ctx?.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("accent", `Gondolin: building ${imageTag}`),
    );
    await ensureImage(ctx, { forceBuild: true, promptReloadIfRunning: true });
    ctx?.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg(
        "accent",
        vm
          ? `Gondolin: running (${localCwd} -> ${guestProjectWorkspace})`
          : `Gondolin: image ready (${imageTag})`,
      ),
    );
    ctx?.ui.notify(`Gondolin image ${imageTag} built.`, "info");
  }

  function registerGondolinCommands() {
    const api = pi as any;
    const run = async (subcommand: string | undefined, ctx?: ExtensionContext) => {
      switch (subcommand) {
        case "build":
          await buildImageFromCommand(ctx);
          return;
        case "reload":
          await reloadVm(ctx);
          ctx?.ui.notify("Gondolin VM reloaded.", "info");
          return;
        default:
          ctx?.ui.notify("Usage: /gondolin build or /gondolin reload", "info");
      }
    };

    const firstArg = (args: string | string[] | undefined) =>
      Array.isArray(args) ? args[0] : args?.trim().split(/\s+/)[0];

    if (typeof api.registerCommand === "function") {
      api.registerCommand("gondolin", {
        description: "Build or reload the Gondolin VM: /gondolin build|reload",
        getArgumentCompletions: (prefix: string) => {
          const items = ["build", "reload"].map((value) => ({ value, label: value }));
          const filtered = items.filter((item) => item.value.startsWith(prefix));
          return filtered.length > 0 ? filtered : null;
        },
        handler: async (args: string, ctx: ExtensionContext) => {
          await run(firstArg(args), ctx);
        },
      });
      return;
    }

    if (typeof api.registerSlashCommand === "function") {
      api.registerSlashCommand("gondolin", async (args: string[], ctx: ExtensionContext) => {
        await run(firstArg(args), ctx);
      });
    }
  }

  registerGondolinCommands();

  pi.on("session_start", async (_event, ctx) => {
    // Start eagerly so the user sees errors early (missing qemu, etc.)
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await stopVm(ctx);
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

  // Replace the CWD line in the system prompt so the model sees the guest project path
  pi.on("before_agent_start", async (event, ctx) => {
    await ensureVm(ctx);
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${guestProjectWorkspace} (Gondolin VM, mounted from host: ${localCwd})`,
    );
    return { systemPrompt: modified };
  });
}
