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

import { toGuestPath } from "./index.ts";

const localCwd = "/example/pi-gondolin";

assert.equal(
  toGuestPath(localCwd, "extensions/pi-gondolin/index.ts"),
  "/workspace/pi-gondolin/extensions/pi-gondolin/index.ts",
);

assert.equal(
  toGuestPath(localCwd, "../shared/file.txt"),
  "/workspace/shared/file.txt",
);

assert.equal(
  toGuestPath(localCwd, "/workspace/shared/file.txt"),
  "/workspace/shared/file.txt",
);

assert.equal(
  toGuestPath("/home/user/pi-gondolin", "/home/user/pi-gondolin/README.md"),
  "/workspace/pi-gondolin/README.md",
);

assert.throws(() => toGuestPath(localCwd, "extensions/../../../etc/hosts"), {
  message: "path escapes workspace: extensions/../../../etc/hosts",
});

assert.throws(() => toGuestPath(localCwd, "/workspace2/file.txt"), {
  message: "path escapes workspace: /workspace2/file.txt",
});

assert.throws(() => toGuestPath(localCwd, "../../shared/file.txt"), {
  message: "path escapes workspace: ../../shared/file.txt",
});

console.log("index tests passed");
