/**
 * BrowserController.ts
 * --------------------
 * The low-level "hands" of the agent. This class wraps Playwright and exposes
 * exactly the primitive capabilities required by the assignment as small,
 * composable, well-typed tools:
 *
 *   - open_browser       -> openBrowser()
 *   - navigate_to_url    -> navigateToUrl(url)
 *   - take_screenshot    -> takeScreenshot()
 *   - click_on_screen    -> clickOnScreen(x, y)
 *   - double_click       -> doubleClick(x, y)
 *   - send_keys          -> sendKeys(text)
 *   - scroll             -> scroll(direction, amount)
 *
 * It also provides higher-level perception helpers (`getInteractiveElements`)
 * used by both the heuristic and the LLM brains for intelligent element
 * detection. Every action is logged, and every screenshot is persisted to the
 * artifacts directory.
 *
 * IMPORTANT — coordinate model: the browser viewport is fixed and the
 * screenshot is captured at deviceScaleFactor 1, so screenshot pixel
 * coordinates map 1:1 onto Playwright mouse coordinates. That lets the LLM
 * "look" at a screenshot and click precise (x, y) points.
 */

import * as fs from "fs";
import * as path from "path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type { AgentConfig } from "../config";
import type { Logger } from "../logger";

/** Result of capturing the screen. */
export interface Screenshot {
  /** Base64-encoded PNG (no data: prefix) — handy for vision models. */
  base64: string;
  /** Absolute path of the saved PNG file. */
  filePath: string;
  width: number;
  height: number;
}

/** A perceived interactive element on the page. */
export interface PageElement {
  /** Stable index for this snapshot (used to reference the element). */
  index: number;
  /** Best-effort accessible label (label text, aria-label, placeholder, …). */
  label: string;
  /** HTML tag, lower-case: "input" | "textarea" | "button" | "select" | "a". */
  tag: string;
  /** input type attribute when relevant (text, email, checkbox, …). */
  type: string | null;
  /** Current value/text content (trimmed). */
  value: string;
  /** Whether the element is currently inside the viewport. */
  inViewport: boolean;
  /** Centre point in viewport (CSS) pixels — feed straight to clickOnScreen. */
  center: { x: number; y: number };
  /** Bounding box in viewport pixels. */
  box: { x: number; y: number; width: number; height: number };
}

export type ScrollDirection = "up" | "down";

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private screenshotCount = 0;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly log: Logger
  ) {}

  /** Guard that returns the active page or throws a clear error. */
  private requirePage(): Page {
    if (!this.page) {
      throw new Error("Browser is not open. Call openBrowser() first.");
    }
    return this.page;
  }

  // ──────────────────────────────────────────────────────────────────────
  // TOOL: open_browser
  // ──────────────────────────────────────────────────────────────────────
  /** Launch Chromium and open a fresh page with a fixed viewport. */
  async openBrowser(): Promise<void> {
    if (this.browser) {
      this.log.debug("open_browser called but a browser is already open");
      return;
    }
    this.log.info("🌐 open_browser", {
      headless: this.cfg.headless,
      viewport: this.cfg.viewport,
    });
    this.browser = await chromium.launch({
      headless: this.cfg.headless,
      slowMo: this.cfg.slowMoMs,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    this.context = await this.browser.newContext({
      viewport: this.cfg.viewport,
      deviceScaleFactor: 1, // keep screenshot pixels == CSS pixels
    });
    // Some bundlers (esbuild/tsx) inject a `__name` helper into the functions we
    // hand to page.evaluate. Define a no-op shim in every page context so those
    // serialized functions run inside the browser. Passed as a raw string so it
    // is not itself transformed by the bundler.
    await this.context.addInitScript({
      content:
        "window.__name = window.__name || function (fn) { return fn; };",
    });
    this.context.setDefaultTimeout(this.cfg.defaultTimeoutMs);
    this.context.setDefaultNavigationTimeout(this.cfg.defaultTimeoutMs);
    this.page = await this.context.newPage();
  }

  // ──────────────────────────────────────────────────────────────────────
  // TOOL: navigate_to_url
  // ──────────────────────────────────────────────────────────────────────
  /** Navigate to a URL and wait for the network to settle. */
  async navigateToUrl(url: string): Promise<void> {
    const page = this.requirePage();
    this.log.info("➡️  navigate_to_url", { url });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      // Best-effort wait for client-rendered content (docs sites hydrate late).
      await page
        .waitForLoadState("networkidle", { timeout: 8000 })
        .catch(() => this.log.debug("networkidle not reached; continuing"));
    } catch (err) {
      this.log.error("navigate_to_url failed", { url, error: String(err) });
      throw err;
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // TOOL: take_screenshot
  // ──────────────────────────────────────────────────────────────────────
  /** Capture the current viewport, persist it, and return it as base64 PNG. */
  async takeScreenshot(tag = "step"): Promise<Screenshot> {
    const page = this.requirePage();
    this.screenshotCount += 1;
    const idx = String(this.screenshotCount).padStart(2, "0");
    const safeTag = tag.replace(/[^a-z0-9-_]/gi, "_");
    const filePath = path.resolve(
      this.cfg.artifactsDir,
      `screenshot-${idx}-${safeTag}.png`
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const buffer = await page.screenshot({ type: "png" });
    fs.writeFileSync(filePath, buffer);

    this.log.info("📸 take_screenshot", { file: path.basename(filePath) });
    return {
      base64: buffer.toString("base64"),
      filePath,
      width: this.cfg.viewport.width,
      height: this.cfg.viewport.height,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // TOOL: click_on_screen(x, y)
  // ──────────────────────────────────────────────────────────────────────
  /** Move the mouse to (x, y) in viewport pixels and click. */
  async clickOnScreen(x: number, y: number): Promise<void> {
    const page = this.requirePage();
    this.assertInViewport(x, y);
    this.log.info("🖱️  click_on_screen", { x, y });
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
  }

  // ──────────────────────────────────────────────────────────────────────
  // TOOL: double_click(x, y)
  // ──────────────────────────────────────────────────────────────────────
  /** Double-click at (x, y) — e.g. to select a word for replacement. */
  async doubleClick(x: number, y: number): Promise<void> {
    const page = this.requirePage();
    this.assertInViewport(x, y);
    this.log.info("🖱️🖱️ double_click", { x, y });
    await page.mouse.move(x, y);
    await page.mouse.dblclick(x, y);
  }

  // ──────────────────────────────────────────────────────────────────────
  // TOOL: send_keys
  // ──────────────────────────────────────────────────────────────────────
  /**
   * Type text into whatever element currently has focus.
   * Optionally clears the field first (select-all + delete).
   */
  async sendKeys(text: string, opts: { clearFirst?: boolean } = {}): Promise<void> {
    const page = this.requirePage();
    this.log.info("⌨️  send_keys", {
      text: text.length > 60 ? text.slice(0, 57) + "…" : text,
      clearFirst: opts.clearFirst ?? false,
    });
    if (opts.clearFirst) {
      const mod = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${mod}+A`);
      await page.keyboard.press("Delete");
    }
    await page.keyboard.type(text, { delay: 20 });
  }

  /** Press a single named key (Enter, Tab, Escape, …). */
  async pressKey(key: string): Promise<void> {
    const page = this.requirePage();
    this.log.info("⌨️  press_key", { key });
    await page.keyboard.press(key);
  }

  // ──────────────────────────────────────────────────────────────────────
  // TOOL: scroll
  // ──────────────────────────────────────────────────────────────────────
  /** Scroll the page up or down by `amount` pixels (default ~one screenful). */
  async scroll(direction: ScrollDirection, amount?: number): Promise<void> {
    const page = this.requirePage();
    const delta =
      (amount ?? Math.round(this.cfg.viewport.height * 0.8)) *
      (direction === "up" ? -1 : 1);
    this.log.info("🔃 scroll", { direction, amount: Math.abs(delta) });
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(250); // let lazy content settle
  }

  /** Scroll a specific element into the centre of the viewport. */
  async scrollElementIntoView(index: number): Promise<void> {
    const page = this.requirePage();
    await page.evaluate((i) => {
      const el = (window as any).__agentElements?.[i] as HTMLElement | undefined;
      if (el) el.scrollIntoView({ block: "center", inline: "center" });
    }, index);
    await page.waitForTimeout(200);
  }

  // ──────────────────────────────────────────────────────────────────────
  // PERCEPTION: intelligent element detection
  // ──────────────────────────────────────────────────────────────────────
  /**
   * Scan the page for interactive form elements and return them with rich
   * accessible labels and viewport coordinates. The element handles are also
   * cached on `window.__agentElements` so they can be scrolled into view later.
   *
   * Labelling strategy (first hit wins): associated <label>, aria-label,
   * aria-labelledby, placeholder, name, nearby preceding text, then id.
   */
  async getInteractiveElements(): Promise<PageElement[]> {
    const page = this.requirePage();
    const elements = await page.evaluate(() => {
      const SELECTOR =
        'input:not([type="hidden"]), textarea, select, button, [role="textbox"], [contenteditable="true"], a[href]';
      const nodes = Array.from(document.querySelectorAll(SELECTOR));

      // Cache handles for later scroll-into-view by index.
      (window as any).__agentElements = nodes;

      function labelFor(el: Element): string {
        const htmlEl = el as HTMLElement;

        // 1. <label for="id"> or wrapping <label>
        const id = htmlEl.getAttribute("id");
        if (id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl?.textContent?.trim()) return lbl.textContent.trim();
        }
        const wrapping = htmlEl.closest("label");
        if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();

        // 2. aria-label / aria-labelledby
        const aria = htmlEl.getAttribute("aria-label");
        if (aria?.trim()) return aria.trim();
        const labelledby = htmlEl.getAttribute("aria-labelledby");
        if (labelledby) {
          const ref = document.getElementById(labelledby);
          if (ref?.textContent?.trim()) return ref.textContent.trim();
        }

        // 3. placeholder
        const ph = htmlEl.getAttribute("placeholder");
        if (ph?.trim()) return ph.trim();

        // 4. button / link text
        if (["BUTTON", "A"].includes(htmlEl.tagName) && htmlEl.textContent?.trim()) {
          return htmlEl.textContent.trim();
        }

        // 5. nearby preceding text within the same form item container
        const container = htmlEl.closest(
          "div,fieldset,section,li,p,form"
        ) as HTMLElement | null;
        if (container) {
          const text = Array.from(container.querySelectorAll("label,span,p,div"))
            .map((n) => n.textContent?.trim() || "")
            .find((t) => t.length > 0 && t.length < 60);
          if (text) return text;
        }

        // 6. name / id fallback
        return (
          htmlEl.getAttribute("name") ||
          htmlEl.getAttribute("id") ||
          htmlEl.tagName.toLowerCase()
        );
      }

      return nodes
        .map((el, index) => {
          const rect = el.getBoundingClientRect();
          const htmlEl = el as HTMLElement;
          const style = window.getComputedStyle(htmlEl);
          const visible =
            rect.width > 1 &&
            rect.height > 1 &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            Number(style.opacity) > 0.05;
          const inViewport =
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= window.innerHeight &&
            rect.right <= window.innerWidth;

          const valueOf = (): string => {
            if (htmlEl instanceof HTMLInputElement) return htmlEl.value;
            if (htmlEl instanceof HTMLTextAreaElement) return htmlEl.value;
            if (htmlEl instanceof HTMLSelectElement) return htmlEl.value;
            return (htmlEl.textContent || "").trim();
          };

          return {
            index,
            visible,
            label: labelFor(el).replace(/\s+/g, " ").slice(0, 80),
            tag: htmlEl.tagName.toLowerCase(),
            type: htmlEl.getAttribute("type"),
            value: valueOf().slice(0, 80),
            inViewport,
            center: {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            },
            box: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        })
        .filter((e) => e.visible)
        .map(({ visible, ...rest }) => rest);
    });

    this.log.debug("perceived interactive elements", {
      count: elements.length,
    });
    return elements as PageElement[];
  }

  /** Read the value currently held by an element (for verification). */
  async readElementValue(index: number): Promise<string> {
    const page = this.requirePage();
    return page.evaluate((i) => {
      const el = (window as any).__agentElements?.[i] as HTMLElement | undefined;
      if (!el) return "";
      if (el instanceof HTMLInputElement) return el.value;
      if (el instanceof HTMLTextAreaElement) return el.value;
      return (el.textContent || "").trim();
    }, index);
  }

  /** Current page URL (for logging / reporting). */
  url(): string {
    return this.page?.url() ?? "about:blank";
  }

  /** Bounds check so we fail loudly instead of clicking off-screen. */
  private assertInViewport(x: number, y: number): void {
    const { width, height } = this.cfg.viewport;
    if (x < 0 || y < 0 || x > width || y > height) {
      throw new Error(
        `Coordinate (${x}, ${y}) is outside the ${width}x${height} viewport. ` +
          `Scroll the target into view first.`
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────────────────
  /** Close the page, context and browser, releasing all resources. */
  async close(): Promise<void> {
    this.log.debug("closing browser");
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}
