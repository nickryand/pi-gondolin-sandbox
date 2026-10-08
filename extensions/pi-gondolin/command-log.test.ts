import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMAND_LOG_COPIES, COMMAND_LOG_MAX_BYTES, RotatingCommandLog } from "./command-log.ts";

const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-command-log-"));
const directory = path.join(parent, ".gondolin");
assert.ok(!fs.existsSync(directory));
const log = new RotatingCommandLog(directory);
assert.ok(fs.statSync(directory).isDirectory());
log.write("process", Buffer.from('launched: ["/usr/bin/hunk","server"]'));
assert.match(fs.readFileSync(path.join(directory, "command_1.log"), "utf8"), /launched:/);
for (let i = 0; i < COMMAND_LOG_COPIES + 1; i++) {
  log.write("stdout", Buffer.alloc(COMMAND_LOG_MAX_BYTES, 120));
}
for (let index = 1; index <= COMMAND_LOG_COPIES; index++) {
  const file = path.join(directory, `command_${index}.log`);
  assert.ok(fs.existsSync(file));
  assert.ok(fs.statSync(file).size <= COMMAND_LOG_MAX_BYTES);
}
assert.ok(!fs.existsSync(path.join(directory, `command_${COMMAND_LOG_COPIES + 1}.log`)));
console.log("command log tests passed");
