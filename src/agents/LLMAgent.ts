/**
 * agents/LLMAgent.ts
 * ------------------
 * The AI brain. It drives the browser through an autonomous perceive → reason →
 * act loop powered by a Groq vision model with function (tool) calling.
 * Groq exposes an OpenAI-compatible chat completions API via the official
 * `groq-sdk`, so the message/tool shapes below are the standard ones.
 *
 * On each turn the model is shown a screenshot of the page plus a structured
 * list of the interactive elements (their labels and centre coordinates) and
 * decides which primitive tool to invoke next: navigate_to_url,
 * click_on_screen(x, y), double_click(x, y), send_keys, scroll, press_key,
 * take_screenshot or get_page_elements. When it believes the task is done it
 * calls task_complete. We then independently verify the result by reading the
 * live field values, so success is never just the model's word.
 *
 * If no GROQ_API_KEY is configured this class is never constructed — the
 * entry point falls back to the HeuristicAgent.
 */

import Groq from "groq-sdk";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "groq-sdk/resources/chat/completions";
import type { AgentConfig, FieldTarget } from "../config";
import type { Logger } from "../logger";
import { BrowserController } from "../browser/BrowserController";
import type { Agent, FieldOutcome, TaskResult } from "./types";

/** OpenAI function-tool schemas mirroring the BrowserController primitives. */
const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "navigate_to_url",
      description: "Navigate the browser to a URL.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "take_screenshot",
      description:
        "Capture the current viewport. The image is returned so you can see the page.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_page_elements",
      description:
        "Return a JSON list of the visible interactive elements with their index, tag, type, accessible label, current value and centre (x, y) coordinates in viewport pixels. Use the centre coordinates with click_on_screen.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "click_on_screen",
      description:
        "Click at viewport pixel coordinates (x, y). Use this to focus an input or press a button. Coordinates must be inside the viewport.",
      parameters: {
        type: "object",
        properties: {
          // Accept number-or-string: some models emit numeric args as strings,
          // and Groq strictly validates against this schema. We coerce in code.
          x: { type: ["number", "string"] },
          y: { type: ["number", "string"] },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "double_click",
      description: "Double-click at viewport pixel coordinates (x, y).",
      parameters: {
        type: "object",
        properties: {
          // Accept number-or-string: some models emit numeric args as strings,
          // and Groq strictly validates against this schema. We coerce in code.
          x: { type: ["number", "string"] },
          y: { type: ["number", "string"] },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_keys",
      description:
        "Type text into the element that currently has focus. Set clear_first=true to clear the field before typing.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          clear_first: { type: ["boolean", "string"] },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description: "Press a single key such as Enter, Tab or Escape.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the page up or down by an optional pixel amount.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"] },
          amount: { type: ["number", "string"] },
        },
        required: ["direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_complete",
      description:
        "Call this when every requested field has been filled. Provide a short summary of what you did.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  },
];

/** Coerce a tool argument to boolean, treating the strings "true"/"1" as true. */
function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "1", "yes"].includes(v.toLowerCase());
  return Boolean(v);
}

export class LLMAgent implements Agent {
  readonly name = "LLMAgent";
  private readonly client: Groq;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly browser: BrowserController,
    private readonly log: Logger
  ) {
    this.client = new Groq({
      apiKey: cfg.groqApiKey,
      // Defaults to Groq's endpoint; override via GROQ_BASE_URL if needed.
      ...(cfg.groqBaseUrl ? { baseURL: cfg.groqBaseUrl } : {}),
    });
  }

  private systemPrompt(fields: FieldTarget[]): string {
    const lines: string[] = [
      "You are an autonomous website automation agent that controls a real web browser.",
      "Your job is to fill in a form on a web page without any human help.",
      "",
      "The viewport is " +
        `${this.cfg.viewport.width}x${this.cfg.viewport.height} pixels. ` +
        "All click coordinates are viewport pixels with (0,0) at the top-left.",
      "",
      "Workflow you should follow:",
      "  1. You are given a list of the page's form elements, each with an exact",
      "     centre {x, y}. ALWAYS use those coordinates — never guess pixel",
      "     positions. Call get_page_elements again any time you need a fresh list.",
      "  2. Match each value to the most appropriate field by its label. Labels may",
      "     differ from what you expect (e.g. 'Bug Title' for a name). Use judgement:",
      "     put short values in single-line <input>s and long text in a <textarea>.",
      "  3. Fill ONE field at a time, in this exact order: first click_on_screen",
      "     at the target field's centre, THEN immediately send_keys with",
      "     clear_first=true for THAT field. Never send two values without a",
      "     click in between — typing always goes to the last-clicked field.",
      "  4. Only use coordinates whose y is between 0 and the viewport height. If a",
      "     field's y is outside the viewport, scroll toward it and then call",
      "     get_page_elements again to get updated coordinates before clicking.",
      "  5. When all requested values are filled, call task_complete.",
    ];
    if (this.cfg.llmUseVision) {
      lines.push("  You may also call take_screenshot to visually confirm the layout.");
    }

    // Free-text instruction takes priority; structured fields are listed if any.
    if (this.cfg.taskInstruction) {
      lines.push(
        "",
        "User's instruction — extract the field values from it and fill them:",
        `  ${this.cfg.taskInstruction}`
      );
    }
    if (fields.length > 0) {
      lines.push(
        "",
        "Fill these specific values:",
        ...fields.map((f) => `  - ${f.label}: type the text """${f.value}"""`)
      );
    }
    if (!this.cfg.taskInstruction && fields.length === 0) {
      lines.push("", "Identify and sensibly fill the editable text fields on the form.");
    }

    lines.push("", "Be efficient and decisive. Do not ask the user questions.");
    return lines.join("\n");
  }

  async run(url: string, fields: FieldTarget[]): Promise<TaskResult> {
    this.log.section(`LLM agent (${this.cfg.groqModel}): start`);
    await this.browser.openBrowser();
    await this.browser.navigateToUrl(url);

    // Bring the form into view first so every field has valid, on-screen
    // coordinates (the demo form sits near the bottom of the page). This makes
    // the model's clicks land reliably instead of falling below the fold.
    const all = await this.browser.getInteractiveElements();
    const firstField = all.find(
      (e) =>
        e.tag === "textarea" ||
        (e.tag === "input" &&
          [null, "text", "email", "search"].includes(e.type as any))
    );
    if (firstField) await this.browser.scrollElementIntoView(firstField.index);

    await this.browser.takeScreenshot("llm-initial"); // saved for the record

    // Ground the model on the actual form elements (compact, token-cheap).
    const initialElements = await this.formElementsJson();

    const initialText =
      `I have opened ${url}. Here are the interactive form elements ` +
      `currently on the page (use their centre coordinates):\n${initialElements}\n\n` +
      "Fill in the requested fields autonomously.";

    const userContent: any = this.cfg.llmUseVision
      ? [
          { type: "text", text: initialText },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${(await this.browser.takeScreenshot("llm-vision")).base64}`,
              detail: "low",
            },
          },
        ]
      : initialText;

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: this.systemPrompt(fields) },
      { role: "user", content: userContent },
    ];

    let steps = 0;
    let completed = false;
    let summary = "Agent stopped before signalling completion.";

    while (steps < this.cfg.maxSteps && !completed) {
      steps++;
      this.log.section(`LLM step ${steps}/${this.cfg.maxSteps}`);

      let response;
      try {
        response = await this.client.chat.completions.create({
          model: this.cfg.groqModel,
          messages,
          tools: TOOLS,
          tool_choice: "auto",
          temperature: 0,
        });
      } catch (err) {
        // Groq returns a 400 "tool_use_failed" when the model emits arguments
        // that don't satisfy a tool's JSON schema. Rather than abort the whole
        // run, feed the error back so the model can correct itself next turn.
        const message = String(err);
        if (message.includes("tool_use_failed") || message.includes("400")) {
          this.log.warn("Model produced invalid tool arguments; asking it to retry", {
            error: message,
          });
          messages.push({
            role: "user",
            content:
              "Your last tool call had invalid arguments and was rejected. " +
              "Please call the tool again with correctly typed arguments " +
              "(numbers as numbers, booleans as true/false).",
          });
          continue;
        }
        this.log.error("Groq request failed", { error: message });
        throw err;
      }

      const choice = response.choices[0];
      const msg = choice.message;
      messages.push(msg);

      if (msg.content) this.log.info("🤖 model", msg.content);

      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // No tool call — nudge the model once, then stop if it persists.
        this.log.warn("Model returned no tool call");
        messages.push({
          role: "user",
          content:
            "Please continue by calling a tool (get_page_elements, click_on_screen, send_keys, …) or task_complete.",
        });
        continue;
      }

      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        const { name } = call.function;
        let args: any = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          this.log.warn("Could not parse tool arguments", call.function.arguments);
        }

        const { text, image } = await this.dispatch(name, args, () => {
          completed = true;
          summary = typeof args.summary === "string" ? args.summary : summary;
        });

        // Tool result (text channel).
        messages.push({ role: "tool", tool_call_id: call.id, content: text });

        // If the tool produced an image (vision mode only), surface it as a user turn.
        if (image) {
          messages.push({
            role: "user",
            content: [
              { type: "text", text: "Here is the current screenshot." },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${image}`, detail: "low" },
              },
            ],
          });
        }
      }

      this.pruneOldImages(messages);
    }

    // Independent verification — never trust the model's self-report alone.
    const outcomes = await this.verifyFields(fields);
    await this.browser.takeScreenshot("llm-final");
    const success = outcomes.every((o) => o.success);

    return {
      success,
      url: this.browser.url(),
      fields: outcomes,
      steps,
      summary: completed
        ? summary
        : "Reached step limit before the agent signalled completion.",
    };
  }

  /**
   * Execute one tool call against the browser and return a text result plus an
   * optional screenshot (base64) to show the model.
   */
  private async dispatch(
    name: string,
    args: any,
    onComplete: () => void
  ): Promise<{ text: string; image?: string }> {
    try {
      switch (name) {
        case "navigate_to_url":
          await this.browser.navigateToUrl(String(args.url));
          return { text: `Navigated to ${args.url}.` };

        case "take_screenshot": {
          const s = await this.browser.takeScreenshot("llm-step");
          // Only feed the image back to the model when vision is enabled,
          // otherwise it just bloats the token budget.
          return this.cfg.llmUseVision
            ? { text: "Screenshot captured.", image: s.base64 }
            : { text: `Screenshot saved to ${s.filePath} (vision disabled; rely on get_page_elements).` };
        }

        case "get_page_elements":
          return { text: await this.formElementsJson() };

        case "click_on_screen":
          await this.browser.clickOnScreen(Number(args.x), Number(args.y));
          return { text: `Clicked at (${args.x}, ${args.y}).` };

        case "double_click":
          await this.browser.doubleClick(Number(args.x), Number(args.y));
          return { text: `Double-clicked at (${args.x}, ${args.y}).` };

        case "send_keys":
          await this.browser.sendKeys(String(args.text), {
            clearFirst: toBool(args.clear_first),
          });
          return { text: `Typed ${String(args.text).length} characters.` };

        case "press_key":
          await this.browser.pressKey(String(args.key));
          return { text: `Pressed ${args.key}.` };

        case "scroll":
          await this.browser.scroll(
            args.direction === "up" ? "up" : "down",
            args.amount !== undefined ? Number(args.amount) : undefined
          );
          return { text: `Scrolled ${args.direction}.` };

        case "task_complete":
          onComplete();
          return { text: "Acknowledged task completion." };

        default:
          return { text: `Unknown tool "${name}".` };
      }
    } catch (err) {
      // Errors are reported back to the model so it can recover (retry/scroll).
      this.log.warn(`Tool "${name}" errored`, { error: String(err) });
      return { text: `ERROR running ${name}: ${String(err)}` };
    }
  }

  /**
   * Build a compact JSON list of the *form-relevant* elements (inputs,
   * textareas, selects and buttons) with their centre coordinates. Anchor/nav
   * links are dropped and the list is capped, keeping the prompt small enough
   * for free-tier token limits while still giving the model exact coordinates.
   */
  private async formElementsJson(): Promise<string> {
    const els = await this.browser.getInteractiveElements();
    const relevant = els
      .filter((e) => ["input", "textarea", "select", "button"].includes(e.tag))
      .slice(0, 40)
      .map((e) => ({
        index: e.index,
        tag: e.tag,
        type: e.type,
        label: e.label,
        value: e.value,
        center: e.center,
        inViewport: e.inViewport,
      }));
    return JSON.stringify(relevant);
  }

  /** Read live field values and decide, objectively, whether each was filled. */
  private async verifyFields(fields: FieldTarget[]): Promise<FieldOutcome[]> {
    const els = await this.browser.getInteractiveElements();
    return fields.map((field) => {
      const target = field.value.trim();
      const hit = els.find((e) => e.value.trim() === target);
      // Also accept a "contains" match (value truncated to 80 chars on read).
      const partial =
        hit ??
        els.find(
          (e) =>
            e.value.trim().length > 0 &&
            target.startsWith(e.value.trim().slice(0, 40))
        );
      const matched = hit ?? partial;
      return {
        field: field.label,
        matchedLabel: matched?.label ?? null,
        typedValue: field.value,
        success: Boolean(matched),
        detail: matched
          ? `verified in ${matched.tag} "${matched.label}"`
          : "value not found in any field after run",
      };
    });
  }

  /**
   * Keep token usage bounded: retain only the two most recent screenshots in
   * the message history, replacing older image turns with a short placeholder.
   */
  private pruneOldImages(messages: ChatCompletionMessageParam[]): void {
    const imageTurns: number[] = [];
    messages.forEach((m, i) => {
      if (
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((c: { type: string }) => c.type === "image_url")
      ) {
        imageTurns.push(i);
      }
    });
    const toStrip = imageTurns.slice(0, Math.max(0, imageTurns.length - 2));
    for (const i of toStrip) {
      messages[i] = {
        role: "user",
        content: "[older screenshot omitted to save context]",
      };
    }
  }
}
