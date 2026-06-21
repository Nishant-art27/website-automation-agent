/**
 * agents/types.ts
 * ---------------
 * Shared contracts implemented by every "brain" (heuristic or LLM). Keeping the
 * interface small lets the entry point treat the two interchangeably.
 */

import type { FieldTarget } from "../config";

/** Outcome of attempting to fill a single field. */
export interface FieldOutcome {
  field: string;
  matchedLabel: string | null;
  typedValue: string;
  success: boolean;
  detail: string;
}

/** Outcome of running the whole task. */
export interface TaskResult {
  success: boolean;
  url: string;
  fields: FieldOutcome[];
  steps: number;
  summary: string;
}

/** What every brain must implement. */
export interface Agent {
  /** Human-readable name for logs/reports. */
  readonly name: string;
  /**
   * Run the automation task: navigate to `url` and fill the given `fields`.
   * Implementations should perform their own logging and screenshots.
   */
  run(url: string, fields: FieldTarget[]): Promise<TaskResult>;
}
