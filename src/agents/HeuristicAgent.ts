/**
 * agents/HeuristicAgent.ts
 * ------------------------
 * The offline brain. It needs no API key and is fully deterministic, which
 * makes it perfect for a reliable live demo.
 *
 * It still demonstrates the required primitive tools end to end: it *perceives*
 * the page (getInteractiveElements), *reasons* about which element is the Name
 * and which is the Description (matcher.ts), then *acts* through the exact same
 * low-level tools the assignment asks for — scroll, click_on_screen(x, y) and
 * send_keys — using DOM-measured coordinates. In other words, the only thing
 * that differs from the LLM brain is *how the coordinates are chosen*.
 */

import type { FieldTarget } from "../config";
import type { Logger } from "../logger";
import { BrowserController } from "../browser/BrowserController";
import { matchFields } from "./matcher";
import type { Agent, FieldOutcome, TaskResult } from "./types";

export class HeuristicAgent implements Agent {
  readonly name = "HeuristicAgent";

  constructor(
    private readonly browser: BrowserController,
    private readonly log: Logger
  ) {}

  async run(url: string, fields: FieldTarget[]): Promise<TaskResult> {
    let steps = 0;

    // 1. Open + navigate.
    this.log.section("Heuristic agent: navigate");
    await this.browser.openBrowser();
    steps++;
    await this.browser.navigateToUrl(url);
    steps++;
    await this.browser.takeScreenshot("after-navigate");

    // 2. Perceive the page.
    this.log.section("Heuristic agent: perceive");
    const elements = await this.browser.getInteractiveElements();
    this.log.info(`Perceived ${elements.length} interactive elements`);
    for (const el of elements.slice(0, 20)) {
      this.log.debug("  element", {
        i: el.index,
        tag: el.tag,
        type: el.type,
        label: el.label,
      });
    }

    // 3. Reason: assign an element to each field.
    this.log.section("Heuristic agent: match elements");
    const matches = matchFields(elements, fields);

    // 4. Act: fill each matched field via the primitive tools.
    this.log.section("Heuristic agent: fill form");
    const outcomes: FieldOutcome[] = [];
    for (const field of fields) {
      const match = matches.get(field) ?? null;
      if (!match) {
        this.log.warn(`No element found for "${field.label}"`);
        outcomes.push({
          field: field.label,
          matchedLabel: null,
          typedValue: field.value,
          success: false,
          detail: "no matching element on page",
        });
        continue;
      }

      this.log.info(
        `Field "${field.label}" → element #${match.element.index} ` +
          `(${match.element.tag}, "${match.element.label}")`,
        { score: match.score, reason: match.reason }
      );

      try {
        // Ensure the target is on screen, then refresh its coordinates.
        await this.browser.scrollElementIntoView(match.element.index);
        steps++;
        const refreshed = await this.browser.getInteractiveElements();
        const live =
          refreshed.find((e) => e.index === match.element.index) ?? match.element;

        // click_on_screen(x, y) to focus, then send_keys to type.
        await this.browser.clickOnScreen(live.center.x, live.center.y);
        steps++;
        await this.browser.sendKeys(field.value, { clearFirst: true });
        steps++;

        // Verify what actually landed in the field.
        const actual = await this.browser.readElementValue(match.element.index);
        const ok = actual.trim() === field.value.trim();
        outcomes.push({
          field: field.label,
          matchedLabel: match.element.label,
          typedValue: field.value,
          success: ok,
          detail: ok
            ? `typed into ${match.element.tag} at (${live.center.x}, ${live.center.y})`
            : `value mismatch — field holds "${actual.slice(0, 40)}"`,
        });
        this.log[ok ? "info" : "warn"](
          `${ok ? "✅" : "⚠️"} "${field.label}" ${ok ? "filled" : "verification failed"}`
        );
      } catch (err) {
        this.log.error(`Failed to fill "${field.label}"`, { error: String(err) });
        outcomes.push({
          field: field.label,
          matchedLabel: match.element.label,
          typedValue: field.value,
          success: false,
          detail: String(err),
        });
      }
    }

    await this.browser.takeScreenshot("after-fill");

    const success = outcomes.every((o) => o.success);
    return {
      success,
      url: this.browser.url(),
      fields: outcomes,
      steps,
      summary: success
        ? "All fields filled and verified by the heuristic engine."
        : "Some fields could not be filled — see field details.",
    };
  }
}
