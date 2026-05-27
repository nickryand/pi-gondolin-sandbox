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

import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayOptions,
} from "@earendil-works/pi-tui";

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

import * as Gondolin from "@earendil-works/gondolin";

const GondolinSdk = ((Gondolin as any).default ?? Gondolin) as any;
const { createHttpHooks, RealFSProvider, VM } = GondolinSdk;
type GondolinVM = InstanceType<typeof VM>;

// The end '/' here is very important.
const GUEST_WORKSPACE_ROOT = "/workspace/";
const NETWORK_EVENT_LIMIT = 200;
const DEFAULT_NETWORK_PANEL_EXPAND_SHORTCUT = "alt+m";

type NetworkEventAction = "allow" | "deny";
type NetworkEventKind = "http" | "tcp";

interface NetworkEvent {
  timestamp: Date;
  kind: NetworkEventKind;
  action: NetworkEventAction;
  target: string;
  detail?: string;
}

interface NetworkStats {
  httpAllow: number;
  httpDeny: number;
  tcpAllow: number;
  tcpDeny: number;
}

class GondolinNetworkPanel implements Component {
  private readonly events: NetworkEvent[];
  private readonly stats: NetworkStats;
  private readonly getConfiguredText: () => string[];
  private readonly theme: ExtensionContext["ui"]["theme"];
  private readonly expanded: boolean;
  private readonly expandShortcut: string;
  private readonly onCollapse: () => void;

  constructor(
    events: NetworkEvent[],
    stats: NetworkStats,
    getConfiguredText: () => string[],
    theme: ExtensionContext["ui"]["theme"],
    expanded: boolean,
    expandShortcut: string,
    onCollapse: () => void,
  ) {
    this.events = events;
    this.stats = stats;
    this.getConfiguredText = getConfiguredText;
    this.theme = theme;
    this.expanded = expanded;
    this.expandShortcut = expandShortcut;
    this.onCollapse = onCollapse;
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerWidth = Math.max(1, width - 2);
    const border = (s: string) => th.fg("border", s);
    const pad = (line: string) => {
      const text = line.replace(/\t/g, "  ");
      const truncated = truncateToWidth(text, innerWidth, "…");
      return `${border("│")}${truncated}${" ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))}${border("│")}`;
    };
    const accepted = this.stats.httpAllow + this.stats.tcpAllow;
    const denied = this.stats.httpDeny + this.stats.tcpDeny;

    const lines = [
      border(`╭${"─".repeat(innerWidth)}╮`),
      pad(` ${th.fg("accent", th.bold("Gondolin network"))}`),
      pad(
        ` Accepted ${th.fg("success", String(accepted))}  Denied ${th.fg("error", String(denied))}`,
      ),
    ];

    if (!this.expanded) {
      lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
      return lines.map((line) => truncateToWidth(line, width, ""));
    }

    lines.push(
      pad(
        ` HTTP ${th.fg("success", String(this.stats.httpAllow))}/${th.fg("error", String(this.stats.httpDeny))}  TCP ${th.fg("success", String(this.stats.tcpAllow))}/${th.fg("error", String(this.stats.tcpDeny))}`,
      ),
      pad(` ${th.fg("dim", `${this.expandShortcut} or escape to collapse`)}`),
      pad(""),
    );

    for (const configuredLine of this.getConfiguredText()) {
      lines.push(pad(` ${th.fg("dim", configuredLine)}`));
    }

    lines.push(pad(""));
    lines.push(pad(` ${th.fg("dim", "domain requests")}`));

    const recent = this.events.slice().reverse();
    if (recent.length === 0) {
      lines.push(pad(` ${th.fg("dim", "no network events yet")}`));
    }

    for (const event of recent) {
      const time = event.timestamp.toLocaleTimeString();
      const marker =
        event.action === "allow" ? th.fg("success", "✓") : th.fg("error", "✗");
      const detail = event.detail ? th.fg("dim", ` ${event.detail}`) : "";
      lines.push(
        pad(` ${marker} ${time} ${event.kind} ${event.target}${detail}`),
      );
    }

    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    if (this.expanded && matchesKey(data, "escape")) {
      this.onCollapse();
    }
  }

  invalidate(): void {}
}

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

export function toGuestPath(localCwd: string, localPath: string): string {
  // const projectDir = path.basename(localCwd);
  const projectParent = path.dirname(localCwd);
  const normalizedLocalCwd = path.resolve(localCwd);
  const normalizedLocalPath = path.isAbsolute(localPath)
    ? localPath
    : path.resolve(normalizedLocalCwd, localPath);

  if (
    !normalizedLocalPath.startsWith(projectParent) &&
    !normalizedLocalPath.startsWith(GUEST_WORKSPACE_ROOT)
  ) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }

  const guestPath = normalizedLocalPath.replace(
    projectParent,
    GUEST_WORKSPACE_ROOT,
  );
  return path.normalize(guestPath);
}

function createGondolinReadOps(
  vm: GondolinVM,
  localCwd: string,
): ReadOperations {
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

function createGondolinWriteOps(
  vm: GondolinVM,
  localCwd: string,
): WriteOperations {
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

function createGondolinEditOps(
  vm: GondolinVM,
  localCwd: string,
): EditOperations {
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

function createGondolinBashOps(
  vm: GondolinVM,
  localCwd: string,
): BashOperations {
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

  const guestProjectWorkspace = getGuestProjectWorkspace(localCwd);

  function readRuntimeSettings() {
    const gondolinSettings = loadGondolinSettings(localCwd);
    const additionalMountSpecs = normalizeMountSpecs(
      localCwd,
      gondolinSettings,
    );
    const imageTag = getGondolinImageTag(gondolinSettings);
    const networkSettings = gondolinSettings.network ?? {};
    const configuredAllowHosts = networkSettings.allowHosts;
    const configuredTcpMap = networkSettings.tcpMap ?? {};
    const hasTcpMap = Object.keys(configuredTcpMap).length > 0;

    return {
      additionalMountSpecs,
      imageTag,
      networkSettings,
      configuredAllowHosts,
      configuredTcpMap,
      hasTcpMap,
    };
  }

  let runtimeSettings = readRuntimeSettings();

  let vm: GondolinVM | null = null;
  let vmStarting: Promise<GondolinVM> | null = null;
  let imageEnsuring: Promise<boolean> | null = null;
  let networkPanelDone: ((result?: void) => void) | null = null;
  let networkPanelComponent: GondolinNetworkPanel | null = null;
  let networkPanelTui: { requestRender(): void } | null = null;
  let networkPanelExpanded = false;
  let networkPanelGeneration = 0;

  const networkEvents: NetworkEvent[] = [];
  const networkStats: NetworkStats = {
    httpAllow: 0,
    httpDeny: 0,
    tcpAllow: 0,
    tcpDeny: 0,
  };

  function recordNetworkEvent(event: Omit<NetworkEvent, "timestamp">) {
    networkEvents.push({ ...event, timestamp: new Date() });
    if (networkEvents.length > NETWORK_EVENT_LIMIT) {
      networkEvents.splice(0, networkEvents.length - NETWORK_EVENT_LIMIT);
    }

    if (event.kind === "http" && event.action === "allow")
      networkStats.httpAllow++;
    if (event.kind === "http" && event.action === "deny")
      networkStats.httpDeny++;
    if (event.kind === "tcp" && event.action === "allow")
      networkStats.tcpAllow++;
    if (event.kind === "tcp" && event.action === "deny") networkStats.tcpDeny++;

    networkPanelComponent?.invalidate();
    networkPanelTui?.requestRender();
  }

  function getConfiguredNetworkText() {
    const lines: string[] = [];
    if (runtimeSettings.configuredAllowHosts !== undefined) {
      lines.push(
        `allowHosts: ${runtimeSettings.configuredAllowHosts.length > 0 ? runtimeSettings.configuredAllowHosts.join(", ") : "(deny all)"}`,
      );
    } else {
      lines.push("allowHosts: (not configured)");
    }
    if (runtimeSettings.hasTcpMap) {
      for (const [guest, upstream] of Object.entries(
        runtimeSettings.configuredTcpMap,
      )) {
        lines.push(`tcpMap: ${guest} → ${upstream}`);
      }
    } else {
      lines.push("tcpMap: (not configured)");
    }
    return lines;
  }

  function createRealFSProviderFromSpec(spec: Record<string, unknown>) {
    const hostPath = spec.hostPath ?? spec.path ?? spec.root;
    if (typeof hostPath !== "string") {
      throw new Error(
        "mount spec must include a string path, hostPath, or root",
      );
    }

    const {
      hostPath: _hostPath,
      path: _path,
      root: _root,
      options,
      ...rest
    } = spec;
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

    for (const [guestPath, spec] of Object.entries(
      runtimeSettings.additionalMountSpecs,
    )) {
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

  function createNetworkOptions() {
    const options: Record<string, unknown> = {};

    const result = createHttpHooks({
      allowedHosts: runtimeSettings.configuredAllowHosts,
    });
    const baseIsIpAllowed = result.httpHooks.isIpAllowed;
    result.httpHooks.isIpAllowed = async (info: any) => {
      const allowed = baseIsIpAllowed ? await baseIsIpAllowed(info) : true;
      recordNetworkEvent({
        kind: "http",
        action: allowed ? "allow" : "deny",
        target: `${info.protocol}://${info.hostname}:${info.port}`,
        detail: `${info.ip}`,
      });
      return allowed;
    };
    options.httpHooks = result.httpHooks;
    options.env = result.env;

    if (runtimeSettings.hasTcpMap) {
      options.tcp = { hosts: runtimeSettings.configuredTcpMap };
      options.dns = { mode: "synthetic", syntheticHostMapping: "per-host" };
    }

    return options;
  }

  function recordNetworkDebugMessage(component: unknown, message: unknown) {
    if (component !== "net" || typeof message !== "string") return;

    const tcpMap = message.match(/^tcp map \S+ (\S+) -> (\S+)$/);
    if (tcpMap) {
      recordNetworkEvent({
        kind: "tcp",
        action: "allow",
        target: tcpMap[1]!,
        detail: `→ ${tcpMap[2]!}`,
      });
      return;
    }

    const tcpBlocked = message.match(/^tcp blocked \S+ -> (\S+) \(tcp\)$/);
    if (tcpBlocked) {
      recordNetworkEvent({
        kind: "tcp",
        action: "deny",
        target: tcpBlocked[1]!,
      });
    }
  }

  function shouldShowNetworkPanel() {
    const panel = runtimeSettings.networkSettings.panel;
    return (
      panel !== false && !(typeof panel === "object" && panel.enabled === false)
    );
  }

  function getNetworkPanelExpandShortcut() {
    const panel = runtimeSettings.networkSettings.panel;
    if (typeof panel === "object" && typeof panel.expandShortcut === "string") {
      return panel.expandShortcut;
    }
    return DEFAULT_NETWORK_PANEL_EXPAND_SHORTCUT;
  }

  function getNetworkPanelOverlayOptions(): OverlayOptions {
    return networkPanelExpanded
      ? {
          anchor: "center" as const,
          width: "95%" as const,
          maxHeight: "95%" as const,
          margin: 1,
          visible: (termWidth: number, termHeight: number) =>
            termWidth >= 40 && termHeight >= 8,
        }
      : {
          anchor: "top-right" as const,
          width: 34,
          minWidth: 34,
          maxHeight: 4,
          margin: { top: 1, right: 1 },
          nonCapturing: true,
          visible: (termWidth: number) => termWidth >= 40,
        };
  }

  function showNetworkPanel(ctx?: ExtensionContext) {
    if (!ctx || !ctx.hasUI || networkPanelDone) return;

    const generation = ++networkPanelGeneration;
    void ctx.ui
      .custom<void>(
        (tui, theme, _keybindings, done) => {
          networkPanelTui = tui;
          networkPanelDone = done;
          networkPanelComponent = new GondolinNetworkPanel(
            networkEvents,
            networkStats,
            getConfiguredNetworkText,
            theme,
            networkPanelExpanded,
            getNetworkPanelExpandShortcut(),
            () => setNetworkPanelExpanded(false, ctx),
          );
          return networkPanelComponent;
        },
        {
          overlay: true,
          overlayOptions: getNetworkPanelOverlayOptions(),
        },
      )
      .finally(() => {
        if (generation !== networkPanelGeneration) return;
        networkPanelDone = null;
        networkPanelComponent = null;
        networkPanelTui = null;
      });
  }

  function hideNetworkPanel() {
    networkPanelGeneration++;
    networkPanelDone?.();
    networkPanelDone = null;
    networkPanelComponent = null;
    networkPanelTui = null;
  }

  function showNetworkPanelFromCommand(ctx?: ExtensionContext) {
    showNetworkPanel(ctx);
    ctx?.ui.notify("Gondolin network panel shown.", "info");
  }

  function hideNetworkPanelFromCommand(ctx?: ExtensionContext) {
    hideNetworkPanel();
    ctx?.ui.notify("Gondolin network panel hidden.", "info");
  }

  function toggleNetworkPanel(ctx?: ExtensionContext) {
    if (networkPanelDone) {
      hideNetworkPanelFromCommand(ctx);
      return;
    }
    showNetworkPanelFromCommand(ctx);
  }

  function setNetworkPanelExpanded(expanded: boolean, ctx?: ExtensionContext) {
    networkPanelExpanded = expanded;
    if (networkPanelDone) {
      hideNetworkPanel();
    }
    showNetworkPanel(ctx);
    ctx?.ui.notify(
      networkPanelExpanded
        ? "Gondolin network panel expanded."
        : "Gondolin network panel collapsed.",
      "info",
    );
  }

  function toggleNetworkPanelExpanded(ctx?: ExtensionContext) {
    setNetworkPanelExpanded(!networkPanelExpanded, ctx);
  }

  async function ensureImage(
    ctx?: ExtensionContext,
    options?: { forceBuild?: boolean; promptReloadIfRunning?: boolean },
  ): Promise<boolean> {
    if (!runtimeSettings.imageTag) return false;
    if (imageEnsuring && !options?.forceBuild) return imageEnsuring;

    imageEnsuring = (async () => {
      const result = await ensureGondolinImage(
        localCwd,
        runtimeSettings.imageTag,
        undefined,
        {
          forceBuild: options?.forceBuild,
        },
      );
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
        ...(runtimeSettings.imageTag || runtimeSettings.hasTcpMap
          ? {
              sandbox: {
                ...(runtimeSettings.imageTag
                  ? { imagePath: runtimeSettings.imageTag }
                  : {}),
                ...(runtimeSettings.hasTcpMap ? { debug: ["net"] } : {}),
              },
            }
          : {}),
        ...(runtimeSettings.hasTcpMap
          ? { debugLog: recordNetworkDebugMessage }
          : {}),
        ...createNetworkOptions(),
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
    const nextSettings = readRuntimeSettings();
    runtimeSettings = nextSettings;
    imageEnsuring = null;
    networkPanelComponent?.invalidate();
    networkPanelTui?.requestRender();

    await stopVm(ctx);
    const reloaded = await ensureVm(ctx);
    if (shouldShowNetworkPanel()) showNetworkPanel(ctx);
    return reloaded;
  }

  async function buildImageFromCommand(ctx?: ExtensionContext) {
    if (!runtimeSettings.imageTag) {
      ctx?.ui.notify("No Gondolin image tag configured.", "warning");
      return;
    }
    ctx?.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg(
        "accent",
        `Gondolin: building ${runtimeSettings.imageTag}`,
      ),
    );
    await ensureImage(ctx, { forceBuild: true, promptReloadIfRunning: true });
    ctx?.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg(
        "accent",
        vm
          ? `Gondolin: running (${localCwd} -> ${guestProjectWorkspace})`
          : `Gondolin: image ready (${runtimeSettings.imageTag})`,
      ),
    );
    ctx?.ui.notify(`Gondolin image ${runtimeSettings.imageTag} built.`, "info");
  }

  function registerGondolinCommands() {
    const api = pi as any;
    const panelCommandUsage =
      "Available /gondolin panel subcommands: show, hide, toggle, expand, collapse, toggle-expanded";
    const runPanelCommand = (
      action: string | undefined,
      ctx?: ExtensionContext,
    ) => {
      switch (action) {
        case "show":
          showNetworkPanelFromCommand(ctx);
          return;
        case "hide":
          hideNetworkPanelFromCommand(ctx);
          return;
        case "toggle":
          toggleNetworkPanel(ctx);
          return;
        case "expand":
          setNetworkPanelExpanded(true, ctx);
          return;
        case "collapse":
          setNetworkPanelExpanded(false, ctx);
          return;
        case "toggle-expanded":
          toggleNetworkPanelExpanded(ctx);
          return;
        case undefined:
        default:
          ctx?.ui.notify(panelCommandUsage, "info");
      }
    };
    const run = async (args: string[], ctx?: ExtensionContext) => {
      switch (args[0]) {
        case "build":
          await buildImageFromCommand(ctx);
          return;
        case "reload":
          await reloadVm(ctx);
          ctx?.ui.notify("Gondolin VM reloaded.", "info");
          return;
        case "panel":
          runPanelCommand(args[1], ctx);
          return;
        default:
          ctx?.ui.notify(
            "Usage: /gondolin build, /gondolin reload, or /gondolin panel [show|hide|toggle|expand|collapse|toggle-expanded]",
            "info",
          );
      }
    };

    const parseArgs = (args: string | string[] | undefined) =>
      Array.isArray(args)
        ? args
        : (args?.trim().split(/\s+/).filter(Boolean) ?? []);

    if (typeof api.registerCommand === "function") {
      api.registerCommand("gondolin", {
        description:
          "Build/reload Gondolin or control network panel: /gondolin build|reload|panel",
        getArgumentCompletions: (prefix: string) => {
          const items = ["build", "reload", "panel"].map((value) => ({
            value,
            label: value,
          }));
          const filtered = items.filter((item) =>
            item.value.startsWith(prefix),
          );
          return filtered.length > 0 ? filtered : null;
        },
        handler: async (args: string, ctx: ExtensionContext) => {
          await run(parseArgs(args), ctx);
        },
      });
      return;
    }

    if (typeof api.registerSlashCommand === "function") {
      api.registerSlashCommand(
        "gondolin",
        async (args: string[], ctx: ExtensionContext) => {
          await run(parseArgs(args), ctx);
        },
      );
    }
  }

  registerGondolinCommands();

  pi.registerShortcut(getNetworkPanelExpandShortcut(), {
    description: "Expand or collapse the Gondolin network panel",
    handler: (ctx) => {
      toggleNetworkPanelExpanded(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Start eagerly so the user sees errors early (missing qemu, etc.)
    await ensureVm(ctx);
    if (shouldShowNetworkPanel()) showNetworkPanel(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    hideNetworkPanel();
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
