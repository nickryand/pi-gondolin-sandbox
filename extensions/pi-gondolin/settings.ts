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

export interface GondolinNetworkSettings {
  allowHosts?: string[];
  tcpMap?: Record<string, string>;
  panel?: boolean;
  [key: string]: unknown;
}

export interface GondolinSettings {
  mounts: Record<string, string | GondolinMountSpec>;
  imageTag?: string;
  image?: GondolinImageSettings;
  network?: GondolinNetworkSettings;
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

  return {
    ...parsed,
    mounts: mounts as Record<string, string | GondolinMountSpec>,
    ...(network !== undefined
      ? { network: normalizeNetworkSettings(network, settingsPath) }
      : {}),
  };
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

  if (network.panel !== undefined && typeof network.panel !== "boolean") {
    throw new Error(`${settingsPath} field "network.panel" must be a boolean`);
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
