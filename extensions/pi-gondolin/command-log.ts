import fs from "node:fs";
import path from "node:path";

export const COMMAND_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const COMMAND_LOG_COPIES = 5;

export class RotatingCommandLog {
  private readonly directory: string;
  private currentSize: number;

  constructor(directory: string) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.currentSize = fs.existsSync(this.filePath(1))
      ? fs.statSync(this.filePath(1)).size
      : 0;
    if (this.currentSize >= COMMAND_LOG_MAX_BYTES) this.rotate();
  }

  write(stream: "stdout" | "stderr" | "process", data: Buffer): void {
    let remaining = data;
    while (remaining.length > 0) {
      if (this.currentSize >= COMMAND_LOG_MAX_BYTES) this.rotate();
      const prefix = Buffer.from(`[${new Date().toISOString()}] ${stream}: `);
      const newline = Buffer.from("\n");
      const room = COMMAND_LOG_MAX_BYTES - this.currentSize;
      const part = remaining.subarray(0, Math.max(1, room - prefix.length - newline.length));
      const record = Buffer.concat([prefix, part, newline]);
      if (this.currentSize + record.length > COMMAND_LOG_MAX_BYTES && this.currentSize > 0) {
        this.rotate();
        continue;
      }
      fs.appendFileSync(this.filePath(1), record);
      this.currentSize += record.length;
      remaining = remaining.subarray(part.length);
    }
  }

  private filePath(index: number): string {
    return path.join(this.directory, `command_${index}.log`);
  }

  private rotate(): void {
    for (let index = COMMAND_LOG_COPIES; index >= 1; index--) {
      const source = this.filePath(index);
      const target = this.filePath(index + 1);
      if (index === COMMAND_LOG_COPIES) fs.rmSync(source, { force: true });
      else if (fs.existsSync(source)) fs.renameSync(source, target);
    }
    this.currentSize = 0;
  }
}
