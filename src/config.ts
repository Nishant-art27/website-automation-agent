/**
 * config.ts
 * ---------
 * Centralised, validated configuration for the automation agent.
 *
 * Every setting can be supplied through environment variables (loaded from a
 * `.env` file via dotenv) or overridden on the command line. Sensible defaults
 * are provided so the agent runs out of the box with zero configuration.
 */

import * as dotenv from "dotenv";

dotenv.config();

/** The two ways the agent can "think". */
export type AgentMode = "auto" | "llm" | "heuristic";

/** Log verbosity levels, ordered from most to least verbose. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A single field the agent is asked to fill, with fuzzy match aliases. */
export interface FieldTarget {
  /** Human-readable name of the field, e.g. "Name". */
  label: string;
  /** Lower-cased aliases used for fuzzy matching against the live page. */
  aliases: string[];
  /** The text to type into the field. */
  value: string;
  /** Preferred control type when several candidates match. */
  prefer: "input" | "textarea" | "any";
}

export interface AgentConfig {
  // AI backend (Groq — OpenAI-compatible chat completions API)
  groqApiKey: string | undefined;
  groqBaseUrl: string | undefined;
  groqModel: string;
  mode: AgentMode;
  /** Send screenshots to the LLM (vision). Off by default to stay within
   *  free-tier token limits; the agent grounds on the element list instead. */
  llmUseVision: boolean;

  // Target task
  targetUrl: string;
  fields: FieldTarget[];
  /** Optional free-text instruction (LLM brain) describing what to fill. */
  taskInstruction: string | undefined;

  // Browser
  headless: boolean;
  viewport: { width: number; height: number };
  slowMoMs: number;
  defaultTimeoutMs: number;

  // Agent behaviour
  maxSteps: number;
  logLevel: LogLevel;
  artifactsDir: string;
}

/** Read a string env var, returning a default when unset/empty. */
function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

/** Read an optional string env var (undefined when unset/empty). */
function optStr(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

/** Read a boolean env var ("true"/"1"/"yes" => true). */
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  return ["true", "1", "yes", "y", "on"].includes(v.trim().toLowerCase());
}

/** Read an integer env var, clamped to be >= min. */
function int(name: string, fallback: number, min = 0): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, n);
}

/**
 * Build the immutable configuration object from the environment.
 * The result is validated and ready to hand to the rest of the system.
 */
export function loadConfig(): AgentConfig {
  const apiKey = optStr("GROQ_API_KEY");

  let mode = str("AGENT_MODE", "auto").toLowerCase() as AgentMode;
  if (!["auto", "llm", "heuristic"].includes(mode)) mode = "auto";

  const nameValue = str("FIELD_NAME_VALUE", "John Doe");
  const descriptionValue = str(
    "FIELD_DESCRIPTION_VALUE",
    "This form was filled in automatically by the Website Automation Agent — " +
      "an AI-driven browser automation built on Playwright."
  );

  return {
    groqApiKey: apiKey,
    groqBaseUrl: optStr("GROQ_BASE_URL"),
    // Default to a Groq model that supports BOTH vision and tool calling.
    groqModel: str("GROQ_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct"),
    mode,
    llmUseVision: bool("LLM_USE_VISION", false),

    targetUrl: str("TARGET_URL", "https://ui.shadcn.com/docs/forms/react-hook-form"),
    taskInstruction: optStr("TASK"),

    // The default task: fill a "Name"-like field and a "Description"-like field.
    // Aliases let the agent match real-world variants (e.g. shadcn's "Bug Title").
    fields: [
      {
        label: "Name",
        aliases: ["name", "full name", "your name", "title", "bug title", "username", "subject"],
        value: nameValue,
        prefer: "input",
      },
      {
        label: "Description",
        aliases: ["description", "details", "message", "about", "bio", "comment", "notes"],
        value: descriptionValue,
        prefer: "textarea",
      },
    ],

    headless: bool("HEADLESS", false),
    viewport: {
      width: int("VIEWPORT_WIDTH", 1280, 320),
      height: int("VIEWPORT_HEIGHT", 900, 320),
    },
    slowMoMs: int("SLOW_MO_MS", 150),
    defaultTimeoutMs: int("DEFAULT_TIMEOUT_MS", 30000, 1000),

    maxSteps: int("MAX_STEPS", 25, 1),
    logLevel: (str("LOG_LEVEL", "info").toLowerCase() as LogLevel) || "info",
    artifactsDir: str("ARTIFACTS_DIR", "artifacts"),
  };
}

/** Labels that usually map to a multi-line <textarea> rather than an <input>. */
const TEXTAREA_HINTS = [
  "description",
  "message",
  "comment",
  "comments",
  "notes",
  "note",
  "about",
  "bio",
  "details",
  "feedback",
  "body",
  "content",
  "address",
];

/**
 * Parse a CLI `--field "Label=Value"` specification into a FieldTarget.
 * Aliases are derived from the label so fuzzy matching still works, and the
 * preferred control type is inferred from the label's wording.
 * Returns null when the spec has no '=' or an empty label.
 */
export function parseFieldSpec(spec: string): FieldTarget | null {
  const eq = spec.indexOf("=");
  if (eq === -1) return null;
  const label = spec.slice(0, eq).trim();
  const value = spec.slice(eq + 1); // keep value verbatim (may contain spaces/'=')
  if (!label) return null;

  const lower = label.toLowerCase();
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const prefer: FieldTarget["prefer"] = TEXTAREA_HINTS.some((h) => lower.includes(h))
    ? "textarea"
    : "input";

  return {
    label,
    aliases: Array.from(new Set([lower, ...words])),
    value,
    prefer,
  };
}

/**
 * Decide which brain to use given the configuration.
 * `auto` resolves to `llm` when an API key is present, else `heuristic`.
 */
export function resolveMode(cfg: AgentConfig): "llm" | "heuristic" {
  if (cfg.mode === "llm") return "llm";
  if (cfg.mode === "heuristic") return "heuristic";
  return cfg.groqApiKey ? "llm" : "heuristic";
}
