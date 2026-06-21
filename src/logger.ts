/**
 * logger.ts
 * ---------
 * A tiny, dependency-free structured logger.
 *
 * Logs are written to the console (with colour + level filtering) and, in
 * parallel, appended to a timestamped run log inside the artifacts directory so
 * every agent action and decision is traceable after the fact.
 */

import * as fs from "fs";
import * as path from "path";
import type { LogLevel } from "./config";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

export class Logger {
  private readonly threshold: number;
  private readonly fileStream: fs.WriteStream | null;
  readonly logFilePath: string | null;

  constructor(level: LogLevel, artifactsDir: string) {
    this.threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;

    let stream: fs.WriteStream | null = null;
    let filePath: string | null = null;
    try {
      fs.mkdirSync(artifactsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      filePath = path.join(artifactsDir, `run-${stamp}.log`);
      stream = fs.createWriteStream(filePath, { flags: "a" });
    } catch {
      // If we cannot open a log file we still log to the console.
      stream = null;
      filePath = null;
    }
    this.fileStream = stream;
    this.logFilePath = filePath;
  }

  private write(level: LogLevel, msg: string, meta?: unknown): void {
    const ts = new Date().toISOString();

    // Always persist to file (full fidelity), regardless of console threshold.
    if (this.fileStream) {
      const line =
        JSON.stringify({ ts, level, msg, ...(meta !== undefined ? { meta } : {}) }) + "\n";
      this.fileStream.write(line);
    }

    if (LEVEL_ORDER[level] < this.threshold) return;

    const color = COLORS[level];
    const tag = `${color}${BOLD}${level.toUpperCase().padEnd(5)}${RESET}`;
    const time = `\x1b[90m${ts}${RESET}`;
    let out = `${time} ${tag} ${msg}`;
    if (meta !== undefined) {
      const rendered = typeof meta === "string" ? meta : JSON.stringify(meta);
      out += ` ${color}${rendered}${RESET}`;
    }
    // eslint-disable-next-line no-console
    console.log(out);
  }

  debug(msg: string, meta?: unknown): void {
    this.write("debug", msg, meta);
  }
  info(msg: string, meta?: unknown): void {
    this.write("info", msg, meta);
  }
  warn(msg: string, meta?: unknown): void {
    this.write("warn", msg, meta);
  }
  error(msg: string, meta?: unknown): void {
    this.write("error", msg, meta);
  }

  /** Visual section break to make multi-step runs readable in the console. */
  section(title: string): void {
    const bar = "─".repeat(Math.max(0, 60 - title.length));
    this.info(`\x1b[35m▸ ${title}\x1b[0m ${"\x1b[90m"}${bar}${RESET}`);
  }

  close(): void {
    this.fileStream?.end();
  }
}
