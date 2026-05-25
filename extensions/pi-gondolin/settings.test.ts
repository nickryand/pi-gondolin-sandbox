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

import { createGondolinImageBuildPlan, getGondolinfilePath } from "./image.ts";
import {
  GONDOLIN_SETTINGS_FILE,
  GONDOLIN_SETTINGS_JSON_FILE,
  getGondolinImageTag,
  loadGondolinSettings,
  normalizeMountSpecs,
} from "./settings.ts";

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-settings-"));

fs.writeFileSync(
  path.join(projectDir, GONDOLIN_SETTINGS_JSON_FILE),
  JSON.stringify({
    image: {
      tag: "pi-sandbox:test",
    },
    mounts: {
      "/cache": "./.cache",
      "/readonly": {
        path: "../shared-data",
        readOnly: true,
        cache: "auto",
      },
      "/nested-options": {
        hostPath: "/var/tmp/gondolin-extra",
        options: {
          readOnly: false,
          uid: 1000,
        },
      },
    },
    network: {
      allowHosts: ["api.github.com", "*.npmjs.org"],
      tcpMap: {
        "postgres.local:5432": "127.0.0.1:5432",
      },
      panel: true,
    },
  }),
);

const settings = loadGondolinSettings(projectDir);
const mounts = normalizeMountSpecs(projectDir, settings);
const imageTag = getGondolinImageTag(settings);
const imageBuildPlan = createGondolinImageBuildPlan(projectDir, imageTag!);

assert.equal(imageTag, "pi-sandbox:test");
assert.deepEqual(imageBuildPlan, {
  imageTag: "pi-sandbox:test",
  gondolinfilePath: path.join(projectDir, "Gondolinfile"),
  configDir: projectDir,
});
assert.equal(getGondolinfilePath(projectDir), path.join(projectDir, "Gondolinfile"));

assert.deepEqual(mounts["/cache"], {
  path: path.join(projectDir, ".cache"),
});

assert.equal(mounts["/readonly"].path, path.resolve(projectDir, "../shared-data"));
assert.equal(mounts["/readonly"].readOnly, true);
assert.equal(mounts["/readonly"].cache, "auto");

assert.equal(mounts["/nested-options"].hostPath, "/var/tmp/gondolin-extra");
assert.deepEqual(mounts["/nested-options"].options, {
  readOnly: false,
  uid: 1000,
});

assert.deepEqual(settings.network, {
  allowHosts: ["api.github.com", "*.npmjs.org"],
  tcpMap: {
    "postgres.local:5432": "127.0.0.1:5432",
  },
  panel: true,
});

const legacyProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-settings-legacy-"));
fs.writeFileSync(
  path.join(legacyProjectDir, GONDOLIN_SETTINGS_FILE),
  JSON.stringify({ imageTag: "pi-sandbox:legacy", mounts: {} }),
);
assert.equal(getGondolinImageTag(loadGondolinSettings(legacyProjectDir)), "pi-sandbox:legacy");

console.log("settings tests passed");
