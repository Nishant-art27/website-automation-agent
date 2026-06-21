/**
 * agents/matcher.ts
 * -----------------
 * Pure, testable scoring logic for matching a desired FieldTarget against the
 * interactive elements perceived on the page. This is the heart of the
 * heuristic "intelligence": it combines label similarity, control-type
 * preference and document order into a single score so the agent can pick the
 * most likely element even when labels do not match verbatim.
 */

import type { FieldTarget } from "../config";
import type { PageElement } from "../browser/BrowserController";

export interface ScoredMatch {
  element: PageElement;
  score: number;
  reason: string;
}

/** Normalise text for comparison: lower-case, strip punctuation/extra space. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Score how well an element satisfies a field target.
 * Returns 0 when the element is clearly unsuitable (e.g. a button for a text
 * field). Higher is better.
 */
export function scoreElement(el: PageElement, field: FieldTarget): ScoredMatch {
  const label = norm(el.label);
  const reasons: string[] = [];
  let score = 0;

  const isTextLike =
    el.tag === "textarea" ||
    el.tag === "select" ||
    (el.tag === "input" &&
      [null, "text", "email", "search", "url", "tel", "password", undefined].includes(
        el.type as any
      )) ||
    el.tag === "div"; // contenteditable / role=textbox

  // Buttons, links and checkboxes can never be a free-text field.
  if (!isTextLike) {
    return { element: el, score: 0, reason: "not a text-entry control" };
  }

  // 1. Label match against aliases (exact > word > substring).
  for (const alias of field.aliases) {
    const a = norm(alias);
    if (label === a) {
      score += 100;
      reasons.push(`label exactly "${alias}"`);
      break;
    }
    const words = label.split(" ");
    if (words.includes(a)) {
      score += 70;
      reasons.push(`label word "${alias}"`);
      break;
    }
    if (label.includes(a)) {
      score += 45;
      reasons.push(`label contains "${alias}"`);
      break;
    }
  }

  // 2. Control-type preference.
  if (field.prefer === "textarea" && el.tag === "textarea") {
    score += 30;
    reasons.push("is a <textarea>");
  } else if (field.prefer === "input" && el.tag === "input") {
    score += 20;
    reasons.push("is an <input>");
  } else if (field.prefer === "textarea" && el.tag !== "textarea") {
    score -= 10;
    reasons.push("expected a <textarea>");
  }

  // 3. Slight bonus for empty fields (we would rather fill a blank one).
  if (el.value.trim() === "") {
    score += 5;
  }

  return {
    element: el,
    score,
    reason: reasons.join(", ") || "type-compatible only",
  };
}

/**
 * Choose the best element for each field, ensuring no element is assigned to
 * two fields. Falls back to positional assignment when label matching is weak:
 * the first text input becomes the "input"-preferred field, the textarea the
 * "textarea"-preferred field.
 */
export function matchFields(
  elements: PageElement[],
  fields: FieldTarget[]
): Map<FieldTarget, ScoredMatch | null> {
  const result = new Map<FieldTarget, ScoredMatch | null>();
  const used = new Set<number>();

  // Pass 1: label/score-based assignment, strongest matches first.
  const candidates: { field: FieldTarget; match: ScoredMatch }[] = [];
  for (const field of fields) {
    for (const el of elements) {
      const m = scoreElement(el, field);
      if (m.score > 0) candidates.push({ field, match: m });
    }
  }
  candidates.sort((a, b) => b.match.score - a.match.score);

  for (const { field, match } of candidates) {
    if (result.get(field)) continue; // field already assigned
    if (used.has(match.element.index)) continue; // element already taken
    if (match.score < 20) continue; // too weak for a confident label match
    result.set(field, match);
    used.add(match.element.index);
  }

  // Pass 2: positional fallback for any unmatched field.
  for (const field of fields) {
    if (result.get(field)) continue;

    const pool = elements.filter((e) => !used.has(e.index));
    let pick: PageElement | undefined;

    if (field.prefer === "textarea") {
      pick = pool.find((e) => e.tag === "textarea");
    }
    if (!pick && field.prefer === "input") {
      pick = pool.find(
        (e) =>
          e.tag === "input" &&
          [null, "text", "email", "search"].includes(e.type as any)
      );
    }
    if (!pick) {
      pick = pool.find((e) => e.tag === "textarea" || e.tag === "input");
    }

    if (pick) {
      result.set(field, {
        element: pick,
        score: 10,
        reason: `positional fallback (first available ${pick.tag})`,
      });
      used.add(pick.index);
    } else {
      result.set(field, null);
    }
  }

  return result;
}
