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
import os from "node:os";
import path from "node:path";

export const GONDOLINFILE = "Gondolinfile";
export const GONDOLIN_CACHE_DIR = ".gondolin";
export const GONDOLIN_BUILD_METADATA_FILE = "image-build.json";

type BuildConfig = Record<string, unknown>;
type BuildOptions = Record<string, unknown>;
type BuildResult = { outputDir: string; [key: string]: unknown };
type ImportedImage = { buildId: string; arch: string; [key: string]: unknown };
type LocalImageRef = Record<string, unknown>;
type ResolvedImage = Record<string, unknown>;

export interface GondolinImageBuildPlan {
  imageTag: string;
  gondolinfilePath: string;
  configDir: string;
}

export interface GondolinImageBuildResult {
  build: BuildResult;
  imported: ImportedImage;
  ref: LocalImageRef;
  metadata: GondolinImageBuildMetadata;
}

export interface GondolinImageBuildMetadata {
  imageTag: string;
  builtAt: string;
  buildId: string;
  arch: string;
  gondolinfilePath: string;
  gondolinfileMtimeMs: number;
}

export type GondolinImageEnsureResult =
  | { status: "none" }
  | { status: "current"; image: ResolvedImage }
  | { status: "built"; result: GondolinImageBuildResult; reason: "missing" | "stale" | "forced" };

export interface GondolinImageSdk {
  resolveImageSelector(imageTag: string): ResolvedImage;
  parseBuildConfig(json: string): BuildConfig;
  buildAssets(config: BuildConfig, options: BuildOptions): Promise<BuildResult>;
  importImageFromDirectory(assetDir: string): ImportedImage;
  setImageRef(reference: string, buildId: string, arch: string): LocalImageRef;
}

async function loadGondolinSdk(): Promise<GondolinImageSdk> {
  return (await import("@earendil-works/gondolin")) as GondolinImageSdk;
}

export function getGondolinfilePath(projectDir: string): string {
  return path.join(projectDir, GONDOLINFILE);
}

export function getGondolinBuildMetadataPath(projectDir: string): string {
  return path.join(projectDir, GONDOLIN_CACHE_DIR, GONDOLIN_BUILD_METADATA_FILE);
}

export function createGondolinImageBuildPlan(
  projectDir: string,
  imageTag: string,
): GondolinImageBuildPlan {
  const gondolinfilePath = getGondolinfilePath(projectDir);
  return {
    imageTag,
    gondolinfilePath,
    configDir: path.dirname(gondolinfilePath),
  };
}

export async function gondolinImageExists(
  imageTag: string,
  sdk?: Pick<GondolinImageSdk, "resolveImageSelector">,
): Promise<boolean> {
  const activeSdk = sdk ?? (await loadGondolinSdk());
  try {
    activeSdk.resolveImageSelector(imageTag);
    return true;
  } catch {
    return false;
  }
}

export function loadGondolinfileConfig(
  gondolinfilePath: string,
  sdk: Pick<GondolinImageSdk, "parseBuildConfig">,
): BuildConfig {
  return sdk.parseBuildConfig(fs.readFileSync(gondolinfilePath, "utf8"));
}

export function loadGondolinImageBuildMetadata(
  projectDir: string,
): GondolinImageBuildMetadata | undefined {
  const metadataPath = getGondolinBuildMetadataPath(projectDir);
  if (!fs.existsSync(metadataPath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object") return undefined;
  const metadata = parsed as Partial<GondolinImageBuildMetadata>;
  if (
    typeof metadata.imageTag !== "string" ||
    typeof metadata.builtAt !== "string" ||
    typeof metadata.buildId !== "string" ||
    typeof metadata.arch !== "string" ||
    typeof metadata.gondolinfilePath !== "string" ||
    typeof metadata.gondolinfileMtimeMs !== "number"
  ) {
    return undefined;
  }

  return metadata as GondolinImageBuildMetadata;
}

function writeGondolinImageBuildMetadata(
  projectDir: string,
  metadata: GondolinImageBuildMetadata,
): void {
  const metadataPath = getGondolinBuildMetadataPath(projectDir);
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

export function isGondolinImageBuildStale(
  projectDir: string,
  imageTag: string,
): boolean {
  const gondolinfilePath = getGondolinfilePath(projectDir);
  if (!fs.existsSync(gondolinfilePath)) return false;

  const metadata = loadGondolinImageBuildMetadata(projectDir);
  if (!metadata || metadata.imageTag !== imageTag) return true;

  const gondolinfileMtimeMs = fs.statSync(gondolinfilePath).mtimeMs;
  return gondolinfileMtimeMs > metadata.gondolinfileMtimeMs;
}

export async function buildGondolinImageFromFile(
  plan: GondolinImageBuildPlan,
  sdk?: Pick<
    GondolinImageSdk,
    "parseBuildConfig" | "buildAssets" | "importImageFromDirectory" | "setImageRef"
  >,
): Promise<GondolinImageBuildResult> {
  const activeSdk = sdk ?? (await loadGondolinSdk());
  const config = loadGondolinfileConfig(plan.gondolinfilePath, activeSdk);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-build-"));

  try {
    const options: BuildOptions = {
      outputDir,
      configDir: plan.configDir,
      verbose: true,
    };
    const build = await activeSdk.buildAssets(config, options);
    const imported = activeSdk.importImageFromDirectory(build.outputDir);
    const ref = activeSdk.setImageRef(
      plan.imageTag,
      imported.buildId,
      imported.arch,
    );
    const gondolinfileMtimeMs = fs.statSync(plan.gondolinfilePath).mtimeMs;
    const metadata: GondolinImageBuildMetadata = {
      imageTag: plan.imageTag,
      builtAt: new Date().toISOString(),
      buildId: imported.buildId,
      arch: imported.arch,
      gondolinfilePath: plan.gondolinfilePath,
      gondolinfileMtimeMs,
    };

    writeGondolinImageBuildMetadata(plan.configDir, metadata);

    return { build, imported, ref, metadata };
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

export async function ensureGondolinImage(
  projectDir: string,
  imageTag: string | undefined,
  sdk?: GondolinImageSdk,
  options?: { forceBuild?: boolean },
): Promise<GondolinImageEnsureResult> {
  if (!imageTag) return { status: "none" };

  const activeSdk = sdk ?? (await loadGondolinSdk());
  const plan = createGondolinImageBuildPlan(projectDir, imageTag);

  let image: ResolvedImage | undefined;
  try {
    image = activeSdk.resolveImageSelector(imageTag);
  } catch {
    image = undefined;
  }

  const shouldBuild = options?.forceBuild || !image || isGondolinImageBuildStale(projectDir, imageTag);
  if (!shouldBuild && image) return { status: "current", image };

  if (!fs.existsSync(plan.gondolinfilePath)) {
    if (image) return { status: "current", image };
    throw new Error(
      `Gondolin image ${imageTag} was not found and ${plan.gondolinfilePath} does not exist`,
    );
  }

  try {
    const result = await buildGondolinImageFromFile(plan, activeSdk);
    return {
      status: "built",
      result,
      reason: options?.forceBuild ? "forced" : image ? "stale" : "missing",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to build Gondolin image ${imageTag}: ${message}`);
  }
}
