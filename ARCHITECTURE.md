# Architecture & Design Decisions

This document explains *why* the Website Automation Agent is built the way it
is, and walks through the agent's perceive → reason → act workflow.

---

## 1. Design goals

1. **Complete the target task reliably** — fill the Name/Title and Description
   fields on the shadcn react-hook-form page, autonomously.
2. **Be genuinely "agentic"** — perceive the page, reason about it, decide which
   action to take next, and verify the outcome.
3. **Work in a viva with or without API credits** — so intelligence is
   *pluggable*: an LLM when a key is available, a deterministic engine otherwise.
4. **Be modular and readable** — primitive browser tools are cleanly separated
   from the decision-making "brain".

---

## 2. The three-layer architecture

```
┌──────────────────────────────────────────────────────────────┐
│  index.ts  — CLI, config resolution, reporting                 │
└───────────────┬───────────────────────────────────────────────┘
                │ selects a brain (auto / llm / heuristic)
        ┌───────┴────────────────────────────┐
        ▼                                     ▼
┌───────────────────┐                 ┌──────────────────────┐
│  LLMAgent          │                 │  HeuristicAgent       │   ← REASONING
│  (Groq vision +    │                 │  (matcher.ts scoring) │     ("the brain")
│   tool calling)    │                 │                       │
└─────────┬──────────┘                 └───────────┬───────────┘
          │           both call the same             │
          ▼           primitive tools                ▼
┌──────────────────────────────────────────────────────────────┐
│  BrowserController  — open_browser, navigate_to_url,           │   ← ACTION + PERCEPTION
│  take_screenshot, click_on_screen, double_click, send_keys,    │     ("the hands & eyes")
│  scroll, + getInteractiveElements (perception)                 │
└───────────────────────────┬────────────────────────────────────┘
                            ▼
                         Playwright → Chromium
```

The key separation: **the brain decides *what* to do; the `BrowserController`
knows *how* to do it.** Swapping brains changes the intelligence without
touching the automation primitives, and vice-versa.

---

## 3. Why a pluggable brain?

The assignment frames this as an *AI-driven* agent and asks for API keys in
config. But an agent that *only* works when a paid LLM key is present is fragile
for a live demonstration. So the brain is an interface (`Agent`) with two
implementations:

- **`LLMAgent`** — the "real" AI: a **Groq**-hosted vision model (Llama 4,
  via the OpenAI-compatible `groq-sdk`) runs an autonomous tool-calling loop.
  This is what showcases AI-driven decision-making.
- **`HeuristicAgent`** — a deterministic fallback that encodes the same kind of
  reasoning ("the textarea is the description; the first text input is the
  name") as explicit scoring rules. Zero dependencies on external services.

`resolveMode()` picks `llm` when `GROQ_API_KEY` exists, otherwise
`heuristic`. Either can be forced with `--mode`.

Crucially, **both brains drive the identical primitive tools** — including
`click_on_screen(x, y)`. The heuristic brain isn't "cheating" by using selector
clicks: it measures each element's bounding box in the DOM, computes the centre
coordinate, and then clicks *that coordinate*, exactly as the LLM does from a
screenshot. The only difference is the *source* of the coordinate (DOM geometry
vs. vision).

---

## 4. The primitive tools (`BrowserController`)

Each required capability is one small, logged, error-handled method:

| Tool | Implementation note |
| --- | --- |
| `open_browser` | Launches Chromium with a **fixed viewport** and `deviceScaleFactor: 1`. |
| `navigate_to_url` | `goto` + best-effort `networkidle` wait for client-rendered docs. |
| `take_screenshot` | Captures the viewport, saves a PNG to `artifacts/`, returns base64. |
| `click_on_screen(x, y)` | `mouse.move` + `mouse.click`; bounds-checked against the viewport. |
| `double_click(x, y)` | `mouse.dblclick`; useful for word-selection before replacing text. |
| `send_keys(text)` | Types into the focused element; optional select-all + clear first. |
| `scroll(dir, amount)` | `mouse.wheel`; also `scrollElementIntoView(index)` helper. |

### The coordinate model (why `click_on_screen(x, y)` is reliable)
The viewport is fixed (default `1280×900`) and screenshots are taken at scale 1.
Therefore **one screenshot pixel == one CSS pixel == one Playwright mouse
coordinate**. A model (or the heuristic) can point at a pixel in the screenshot
and we click the same coordinate in the browser, with no scaling math.

### Perception: `getInteractiveElements()`
A single `page.evaluate` scan returns every visible interactive element with:
its **best accessible label** (resolved in priority order:
`<label for>` → wrapping `<label>` → `aria-label`/`aria-labelledby` →
`placeholder` → button/link text → nearby text → `name`/`id`), its tag/type,
current value, in-viewport flag, and **centre coordinates**. This is the shared
"eyes" both brains rely on for intelligent element detection.

> Implementation note: a tiny `window.__name` shim is injected via
> `addInitScript` so functions serialized into `page.evaluate` by the
> bundler (tsx/esbuild) run correctly inside the browser context.

---

## 5. Reasoning — element detection

### Heuristic brain (`matcher.ts`)
For each `(element, field)` pair it computes a score:

- **Label match** against the field's aliases: exact (`+100`) > whole-word
  (`+70`) > substring (`+45`). This is how requested **"Name"** matches the
  page's **"Bug Title"** (the alias list includes `title`/`bug title`).
- **Control-type preference**: a `Description` prefers `<textarea>` (`+30`); a
  `Name` prefers `<input>` (`+20`); type mismatches are penalised.
- **Empty-field bonus** (`+5`).

Matches are assigned greedily, strongest first, never reusing an element. Any
field left unmatched falls back to **positional assignment** (first free
textarea / text input). This combination of *semantic* + *structural* +
*positional* signals is what lets it adapt when labels don't match verbatim.

### LLM brain (`LLMAgent.ts`)
The model is given a system prompt describing the task, the viewport size and
the workflow, then on each turn it sees a **screenshot** and can call
`get_page_elements` to get the structured element list (labels + centre
coordinates). It autonomously chooses tools — typically:
`get_page_elements → click_on_screen → send_keys (clear_first) → … →
task_complete`. Tool errors are returned to the model so it can recover (e.g.
scroll, then retry). Old screenshots are pruned from history to bound token use.

---

## 6. Acting & self-verification

Both brains finish by **independently verifying** the result:
`getInteractiveElements()` is read back and each field is only marked successful
if the live control actually contains the typed value. The agent never reports
success on the model's word alone — verification is grounded in the real DOM.

Results are summarised to the console and written to `artifacts/result.json`,
with before/after screenshots saved alongside.

---

## 7. Error handling strategy

- **Navigation/timeout**: `navigate_to_url` catches and logs failures; the
  `networkidle` wait is best-effort so a slow analytics request can't hang the
  run.
- **Element not found**: matcher returns `null` → the field is reported as a
  clean failure rather than crashing; the LLM is told and can scroll/retry.
- **Off-screen clicks**: `click_on_screen` bounds-checks coordinates and throws
  a descriptive error instructing the caller to scroll first.
- **LLM faults**: malformed tool arguments are caught; a turn with no tool call
  triggers a single nudge; a hard step cap (`MAX_STEPS`) prevents infinite loops.
- **Cleanup**: the browser is always closed in a `finally` block.

---

## 8. Logging & observability

`logger.ts` writes colourised, level-filtered output to the console **and** a
full-fidelity JSON line per event to `artifacts/run-<timestamp>.log`. Every tool
invocation logs its arguments, and the run ends with a structured report, so an
evaluator can reconstruct exactly what the agent perceived and did.

---

## 9. Possible extensions

- Cross-`<iframe>` perception with coordinate offsetting.
- A planning step that breaks complex goals into sub-tasks.
- Retry-with-vision when DOM detection is ambiguous.
- A pytest/Playwright-test harness asserting `result.json` for CI.
- Support for additional providers behind the same `Agent` interface
  (Anthropic, local models) — the abstraction already allows it.
