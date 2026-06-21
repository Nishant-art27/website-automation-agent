#!/usr/bin/env node
/**
 * index.ts
 * --------
 * Command-line entry point for the Website Automation Agent.
 *
 * It loads configuration, selects the appropriate brain (LLM when a Groq key
 * is present, otherwise the offline heuristic engine), runs the target task,
 * prints a human-readable report and writes a machine-readable result.json to
 * the artifacts directory. Exit code is 0 on success, 1 on failure.
 *
 * Usage:
 *   npm run agent                         # use .env settings
 *   npm run agent -- --mode heuristic     # force the offline brain
 *   npm run agent -- --url <url> --headless
 *   npm run agent -- --name "Ada" --description "Hello world"
 */

import * as fs from "fs";
import * as path from "path";
import {
  loadConfig,
  resolveMode,
  parseFieldSpec,
  type AgentConfig,
  type FieldTarget,
} from "./config";
import { Logger } from "./logger";
import { BrowserController } from "./browser/BrowserController";
import { HeuristicAgent } from "./agents/HeuristicAgent";
import { LLMAgent } from "./agents/LLMAgent";
import type { Agent, TaskResult } from "./agents/types";

/** Apply simple `--flag value` / `--flag` CLI overrides onto the config. */
function applyCliOverrides(cfg: AgentConfig, argv: string[]): AgentConfig {
  const next = { ...cfg, viewport: { ...cfg.viewport }, fields: cfg.fields.map((f) => ({ ...f })) };
  // Collected --field flags replace the default field set when any are given.
  const cliFields: FieldTarget[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const val = argv[i + 1];
    switch (arg) {
      case "--url":
        next.targetUrl = val;
        i++;
        break;
      case "--mode":
        if (["auto", "llm", "heuristic"].includes(val)) next.mode = val as any;
        i++;
        break;
      case "--model":
        next.groqModel = val;
        i++;
        break;
      case "--headless":
        next.headless = true;
        break;
      case "--headed":
        next.headless = false;
        break;
      case "--name":
        next.fields[0].value = val;
        i++;
        break;
      case "--description":
        next.fields[1].value = val;
        i++;
        break;
      case "--field": {
        // Repeatable: --field "Label=Value"
        const parsed = parseFieldSpec(val ?? "");
        if (parsed) cliFields.push(parsed);
        else
          // eslint-disable-next-line no-console
          console.warn(`Ignoring malformed --field "${val}" (expected Label=Value).`);
        i++;
        break;
      }
      case "--task":
        next.taskInstruction = val;
        i++;
        break;
      case "--log":
        next.logLevel = val as any;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  // If the user supplied explicit fields, they fully replace the defaults.
  // If they gave only a free-text --task, drop the default fields so the LLM
  // works purely from the instruction (and we don't verify stale defaults).
  if (cliFields.length > 0) next.fields = cliFields;
  else if (next.taskInstruction) next.fields = [];

  return next;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`
Website Automation Agent

Usage: npm run agent -- [options]

With NO options it runs the built-in test: the shadcn form, filling the
default Name and Description values. Pass options to target any other form.

Options:
  --url <url>            Target page (default: shadcn react-hook-form docs)
  --field "Label=Value"  A form field to fill. Repeatable. When given, these
                         REPLACE the default Name/Description fields.
                         e.g. --field "Email=a@b.com" --field "Message=Hi"
  --task "<text>"        Free-text instruction for the LLM brain to interpret,
                         e.g. --task "fill name John, email a@b.com, msg Hi"
  --name <text>          Shortcut: value for the default Name/Title field
  --description <text>   Shortcut: value for the default Description field
  --mode <m>             auto | llm | heuristic   (default: auto)
  --model <name>         Groq model (default: llama-4-scout)
  --headed | --headless  Show or hide the browser window
  --log <level>          debug | info | warn | error
  -h, --help             Show this help

Examples:
  npm run agent
  npm run agent -- --url https://site.com/contact \\
    --field "Name=John Doe" --field "Email=john@x.com" --field "Message=Hello"
  npm run agent -- --url https://site.com/contact \\
    --task "Fill the form: name John Doe, email john@x.com, message Hello"
`);
}

function printReport(log: Logger, agentName: string, result: TaskResult): void {
  log.section("Result");
  log.info(`Brain        : ${agentName}`);
  log.info(`Final URL    : ${result.url}`);
  log.info(`Steps taken  : ${result.steps}`);
  log.info(`Overall      : ${result.success ? "✅ SUCCESS" : "❌ INCOMPLETE"}`);
  for (const f of result.fields) {
    const icon = f.success ? "✅" : "❌";
    log.info(
      `  ${icon} ${f.field} → matched "${f.matchedLabel ?? "—"}" :: ${f.detail}`
    );
  }
  log.info(`Summary      : ${result.summary}`);
}

async function main(): Promise<void> {
  const baseCfg = loadConfig();
  const cfg = applyCliOverrides(baseCfg, process.argv.slice(2));
  const log = new Logger(cfg.logLevel, cfg.artifactsDir);

  log.section("Website Automation Agent");
  const mode = resolveMode(cfg);
  log.info("Configuration", {
    mode,
    url: cfg.targetUrl,
    model: mode === "llm" ? cfg.groqModel : "(n/a)",
    headless: cfg.headless,
    hasApiKey: Boolean(cfg.groqApiKey),
    logFile: log.logFilePath,
  });
  log.info(
    "Task",
    cfg.taskInstruction
      ? { instruction: cfg.taskInstruction }
      : { fields: cfg.fields.map((f) => `${f.label}="${f.value}"`) }
  );
  if (mode === "heuristic" && cfg.mode === "auto") {
    log.warn(
      "No GROQ_API_KEY found — running the offline heuristic brain. " +
        "Set GROQ_API_KEY in .env to enable the LLM agent."
    );
  }
  if (cfg.taskInstruction && mode === "heuristic") {
    log.warn(
      "A free-text --task needs the LLM brain, but no GROQ_API_KEY is set. " +
        "Either add a key, or use explicit --field \"Label=Value\" flags instead " +
        "(the heuristic brain can fill those)."
    );
  }

  const browser = new BrowserController(cfg, log);
  const agent: Agent =
    mode === "llm"
      ? new LLMAgent(cfg, browser, log)
      : new HeuristicAgent(browser, log);

  let result: TaskResult;
  let exitCode = 0;
  try {
    result = await agent.run(cfg.targetUrl, cfg.fields);
    printReport(log, agent.name, result);
    exitCode = result.success ? 0 : 1;

    // Persist a machine-readable result alongside the screenshots.
    const resultPath = path.join(cfg.artifactsDir, "result.json");
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ agent: agent.name, mode, ...result }, null, 2)
    );
    log.info(`Artifacts written to ./${cfg.artifactsDir} (screenshots + result.json)`);
  } catch (err) {
    log.error("Agent run failed", { error: String(err) });
    exitCode = 1;
  } finally {
    // Brief pause so a human watching a headed run can see the final state.
    if (!cfg.headless) await new Promise((r) => setTimeout(r, 1500));
    await browser.close();
    log.close();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal:", err);
  process.exit(1);
});
