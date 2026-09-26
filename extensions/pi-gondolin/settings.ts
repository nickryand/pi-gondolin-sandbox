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
 */

import fs from "node:fs";
import path from "node:path";

export const GONDOLIN_SETTINGS_FILE = ".gondolin";
export const GONDOLIN_SETTINGS_JSON_FILE = ".gondolin.json";

export interface GondolinMountSpec {
  path?: string;
  hostPath?: string;
  root?: string;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GondolinImageSettings {
  tag?: string;
  [key: string]: unknown;
}

export interface GondolinNetworkPanelSettings {
  enabled?: boolean;
  expandShortcut?: string;
  [key: string]: unknown;
}

export interface GondolinNetworkSettings {
  allowHosts?: string[];
  tcpMap?: Record<string, string>;
  panel?: boolean | GondolinNetworkPanelSettings;
  [key: string]: unknown;
}

export interface GondolinListenerRoute {
  prefix: string;
  port: number;
  stripPrefix?: boolean;
}

export interface GondolinIngressSettings {
  host?: string;
  port?: number;
}

export interface GondolinVmSettings {
  cpus?: number;
  memory?: string;
  [key: string]: unknown;
}

export interface GondolinSecretSpec {
  hosts: string[];
  value: string;
}

export interface GondolinSettings {
  mounts: Record<string, string | GondolinMountSpec>;
  imageTag?: string;
  image?: GondolinImageSettings;
  network?: GondolinNetworkSettings;
  vm?: GondolinVmSettings;
  secrets?: Record<string, GondolinSecretSpec>;
  listeners?: GondolinListenerRoute[];
  ingress?: GondolinIngressSettings;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveProjectPath(projectDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectDir, value);
}

export function loadGondolinSettings(
  projectDir: string,
  fileName?: string,
): GondolinSettings {
  const settingsPath = fileName
    ? path.join(projectDir, fileName)
    : [GONDOLIN_SETTINGS_JSON_FILE, GONDOLIN_SETTINGS_FILE]
        .map((candidate) => path.join(projectDir, candidate))
        .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());

  if (!settingsPath) return { mounts: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to read ${settingsPath}: ${message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${settingsPath} must contain a JSON object`);
  }

  const mounts = parsed.mounts ?? {};
  if (!isPlainObject(mounts)) {
    throw new Error(`${settingsPath} field "mounts" must be an object`);
  }

  const network = parsed.network;
  if (network !== undefined && !isPlainObject(network)) {
    throw new Error(`${settingsPath} field "network" must be an object`);
  }

  const vm = parsed.vm;
  if (vm !== undefined && !isPlainObject(vm)) {
    throw new Error(`${settingsPath} field "vm" must be an object`);
  }

  const listeners = parsed.listeners;
  if (listeners !== undefined && !Array.isArray(listeners)) {
    throw new Error(`${settingsPath} field "listeners" must be an array`);
  }

  const ingress = parsed.ingress;
  if (ingress !== undefined && !isPlainObject(ingress)) {
    throw new Error(`${settingsPath} field "ingress" must be an object`);
  }

  const secrets = parsed.secrets;
  if (secrets !== undefined && !isPlainObject(secrets)) {
    throw new Error(`${settingsPath} field "secrets" must be an object`);
  }

  return {
    ...parsed,
    mounts: mounts as Record<string, string | GondolinMountSpec>,
    ...(network !== undefined
      ? { network: normalizeNetworkSettings(network, settingsPath) }
      : {}),
    ...(vm !== undefined ? { vm: normalizeVmSettings(vm, settingsPath) } : {}),
    ...(secrets !== undefined
      ? { secrets: normalizeSecrets(secrets, settingsPath) }
      : {}),
    ...(listeners !== undefined
      ? { listeners: normalizeListeners(listeners, settingsPath) }
      : {}),
    ...(ingress !== undefined
      ? { ingress: normalizeIngress(ingress, settingsPath) }
      : {}),
  };
}

function normalizeListeners(
  listeners: unknown[],
  settingsPath: string,
): GondolinListenerRoute[] {
  return listeners.map((route, index) => {
    const field = `listeners[${index}]`;
    if (!isPlainObject(route)) {
      throw new Error(`${settingsPath} field "${field}" must be an object`);
    }
    if (typeof route.prefix !== "string" || !route.prefix.startsWith("/")) {
      throw new Error(`${settingsPath} field "${field}.prefix" must start with "/"`);
    }
    if (!Number.isInteger(route.port) || route.port < 1 || route.port > 65535) {
      throw new Error(`${settingsPath} field "${field}.port" must be an integer from 1 to 65535`);
    }
    if (route.stripPrefix !== undefined && typeof route.stripPrefix !== "boolean") {
      throw new Error(`${settingsPath} field "${field}.stripPrefix" must be a boolean`);
    }
    return {
      prefix: route.prefix,
      port: route.port,
      ...(route.stripPrefix !== undefined ? { stripPrefix: route.stripPrefix } : {}),
    };
  });
}

function normalizeIngress(
  ingress: Record<string, unknown>,
  settingsPath: string,
): GondolinIngressSettings {
  const normalized: GondolinIngressSettings = {};
  if (ingress.host !== undefined) {
    if (typeof ingress.host !== "string" || ingress.host.length === 0) {
      throw new Error(`${settingsPath} field "ingress.host" must be a non-empty string`);
    }
    normalized.host = ingress.host;
  }
  if (ingress.port !== undefined) {
    if (!Number.isInteger(ingress.port) || ingress.port < 0 || ingress.port > 65535) {
      throw new Error(`${settingsPath} field "ingress.port" must be an integer from 0 to 65535`);
    }
    normalized.port = ingress.port;
  }
  return normalized;
}

function normalizeSecrets(
  secrets: Record<string, unknown>,
  settingsPath: string,
): Record<string, GondolinSecretSpec> {
  const normalized: Record<string, GondolinSecretSpec> = {};

  for (const [name, value] of Object.entries(secrets)) {
    if (!isPlainObject(value)) {
      throw new Error(`${settingsPath} field "secrets.${name}" must be an object`);
    }
    if (!Array.isArray(value.hosts)) {
      throw new Error(`${settingsPath} field "secrets.${name}.hosts" must be an array`);
    }
    const hosts = value.hosts.map((host, i) => {
      if (typeof host !== "string" || host.length === 0) {
        throw new Error(
          `${settingsPath} field "secrets.${name}.hosts[${i}]" must be a non-empty string`,
        );
      }
      return host;
    });
    if (typeof value.value !== "string") {
      throw new Error(
        `${settingsPath} field "secrets.${name}.value" must be a string`,
      );
    }

    const envReference = value.value.match(/^\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}$/);
    const secretValue = envReference
      ? process.env[envReference[1]]
      : value.value;
    if (envReference && secretValue === undefined) {
      throw new Error(
        `${settingsPath} field "secrets.${name}.value" references unset environment variable "${envReference[1]}"`,
      );
    }

    normalized[name] = { hosts, value: secretValue ?? value.value };
  }

  return normalized;
}

function normalizeVmSettings(
  vm: Record<string, unknown>,
  settingsPath: string,
): GondolinVmSettings {
  const normalized: GondolinVmSettings = { ...vm };

  if (vm.cpus !== undefined) {
    if (!Number.isInteger(vm.cpus) || vm.cpus < 1) {
      throw new Error(
        `${settingsPath} field "vm.cpus" must be a positive integer`,
      );
    }
    normalized.cpus = vm.cpus;
  }

  if (vm.memory !== undefined) {
    if (typeof vm.memory !== "string" || vm.memory.length === 0) {
      throw new Error(
        `${settingsPath} field "vm.memory" must be a non-empty string`,
      );
    }
    normalized.memory = vm.memory;
  }

  return normalized;
}

function normalizeNetworkSettings(
  network: Record<string, unknown>,
  settingsPath: string,
): GondolinNetworkSettings {
  const normalized: GondolinNetworkSettings = { ...network };

  if (network.allowHosts !== undefined) {
    if (!Array.isArray(network.allowHosts)) {
      throw new Error(`${settingsPath} field "network.allowHosts" must be an array`);
    }
    normalized.allowHosts = network.allowHosts.map((host, i) => {
      if (typeof host !== "string" || host.length === 0) {
        throw new Error(
          `${settingsPath} field "network.allowHosts[${i}]" must be a non-empty string`,
        );
      }
      return host;
    });
  }

  if (network.tcpMap !== undefined) {
    if (!isPlainObject(network.tcpMap)) {
      throw new Error(`${settingsPath} field "network.tcpMap" must be an object`);
    }
    normalized.tcpMap = {};
    for (const [guest, upstream] of Object.entries(network.tcpMap)) {
      if (typeof upstream !== "string" || upstream.length === 0) {
        throw new Error(
          `${settingsPath} field "network.tcpMap.${guest}" must be a non-empty string`,
        );
      }
      normalized.tcpMap[guest] = upstream;
    }
  }

  if (network.panel !== undefined) {
    if (typeof network.panel === "boolean") {
      normalized.panel = network.panel;
    } else if (isPlainObject(network.panel)) {
      const panel = network.panel;
      if (panel.enabled !== undefined && typeof panel.enabled !== "boolean") {
        throw new Error(`${settingsPath} field "network.panel.enabled" must be a boolean`);
      }
      if (panel.expandShortcut !== undefined) {
        if (typeof panel.expandShortcut !== "string" || panel.expandShortcut.length === 0) {
          throw new Error(
            `${settingsPath} field "network.panel.expandShortcut" must be a non-empty string`,
          );
        }
      }
      normalized.panel = panel;
    } else {
      throw new Error(`${settingsPath} field "network.panel" must be a boolean or object`);
    }
  }

  return normalized;
}

export function getGondolinImageTag(settings: GondolinSettings): string | undefined {
  const imageTag = settings.imageTag ?? settings.image?.tag;
  if (imageTag === undefined) return undefined;
  if (typeof imageTag !== "string" || imageTag.length === 0) {
    throw new Error("Gondolin image tag must be a non-empty string");
  }
  return imageTag;
}

export function normalizeMountSpecs(
  projectDir: string,
  settings: GondolinSettings,
): Record<string, GondolinMountSpec> {
  const mounts = settings.mounts ?? {};
  const normalized: Record<string, GondolinMountSpec> = {};

  for (const [guestPath, spec] of Object.entries(mounts)) {
    if (!path.posix.isAbsolute(guestPath)) {
      throw new Error(`mount path must be absolute in guest: ${guestPath}`);
    }

    if (typeof spec === "string") {
      normalized[guestPath] = { path: resolveProjectPath(projectDir, spec) };
      continue;
    }

    if (!isPlainObject(spec)) {
      throw new Error(`mount ${guestPath} must be a string path or object`);
    }

    const hostPathKey = ["path", "hostPath", "root"].find(
      (key) => typeof spec[key] === "string",
    );

    if (!hostPathKey) {
      throw new Error(
        `mount ${guestPath} must include a string "path", "hostPath", or "root"`,
      );
    }

    normalized[guestPath] = {
      ...spec,
      [hostPathKey]: resolveProjectPath(projectDir, spec[hostPathKey]),
    } as GondolinMountSpec;
  }

  return normalized;
}
