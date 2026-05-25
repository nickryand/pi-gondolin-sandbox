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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureGondolinImage, getGondolinBuildMetadataPath } from "./image.ts";

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-image-"));
const gondolinfilePath = path.join(projectDir, "Gondolinfile");
fs.writeFileSync(gondolinfilePath, JSON.stringify({ arch: "x86_64", distro: "alpine" }));

const calls: string[] = [];
const sdk = {
  resolveImageSelector(imageTag: string) {
    calls.push(`resolve:${imageTag}`);
    throw new Error("missing image");
  },
  parseBuildConfig(json: string) {
    calls.push(`parse:${json}`);
    return JSON.parse(json);
  },
  async buildAssets(config: Record<string, unknown>, options: Record<string, unknown>) {
    calls.push(`build:${config.arch}:${options.configDir}`);
    return { outputDir: String(options.outputDir) };
  },
  importImageFromDirectory(assetDir: string) {
    calls.push(`import:${assetDir.startsWith(os.tmpdir())}`);
    return { buildId: "00000000-0000-4000-8000-000000000000", arch: "x86_64" };
  },
  setImageRef(reference: string, buildId: string, arch: string) {
    calls.push(`tag:${reference}:${buildId}:${arch}`);
    return { reference };
  },
};

const result = await ensureGondolinImage(projectDir, "pi-sandbox:test", sdk);

assert.equal(result.status, "built");
assert.equal(result.status === "built" ? result.reason : undefined, "missing");

assert.deepEqual(calls, [
  "resolve:pi-sandbox:test",
  `parse:${JSON.stringify({ arch: "x86_64", distro: "alpine" })}`,
  `build:x86_64:${projectDir}`,
  "import:true",
  "tag:pi-sandbox:test:00000000-0000-4000-8000-000000000000:x86_64",
]);

const metadata = JSON.parse(fs.readFileSync(getGondolinBuildMetadataPath(projectDir), "utf8"));
assert.equal(metadata.imageTag, "pi-sandbox:test");
assert.equal(metadata.buildId, "00000000-0000-4000-8000-000000000000");
assert.equal(metadata.arch, "x86_64");
assert.equal(metadata.gondolinfilePath, gondolinfilePath);
assert.equal(typeof metadata.gondolinfileMtimeMs, "number");

calls.length = 0;
const staleTime = new Date(metadata.gondolinfileMtimeMs + 10_000);
fs.utimesSync(gondolinfilePath, staleTime, staleTime);
const staleResult = await ensureGondolinImage(projectDir, "pi-sandbox:test", {
  ...sdk,
  resolveImageSelector(imageTag: string) {
    calls.push(`resolve:${imageTag}`);
    return { reference: imageTag };
  },
});

assert.equal(staleResult.status, "built");
assert.equal(staleResult.status === "built" ? staleResult.reason : undefined, "stale");
assert.equal(calls[0], "resolve:pi-sandbox:test");
assert.equal(calls.includes(`build:x86_64:${projectDir}`), true);

console.log("image tests passed");
