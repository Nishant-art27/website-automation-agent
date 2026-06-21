# 🤖 Website Automation Agent

An intelligent, **AI-driven website automation agent** that opens a browser, navigates to a web page, **detects form elements on its own**, and fills them in **without any manual intervention**.

It's a mini version of tools like [Browser Use](https://github.com/browser-use/browser-use), built on [Playwright](https://playwright.dev/).

---

## 🎯 What It Does

> **Target task (from the assignment):**
> Navigate to `https://ui.shadcn.com/docs/forms/react-hook-form`, identify the form fields (**Name** and **Description**), and fill them in automatically.

There's a twist: the live page actually labels its fields **"Bug Title"** and **"Description"** — not "Name". So the agent has to be *smart* about it:

- It maps the requested **"Name"** → the first single-line text input.
- It maps **"Description"** → the textarea.

This element detection is the interesting part, and it's handled in **two different ways**:

| Brain | When it runs | How it decides what to click |
| :--- | :--- | :--- |
| 🧠 **LLM agent** | When `GROQ_API_KEY` is set | A **Groq vision** model (Llama 4) looks at a screenshot + element list and chooses tools/coordinates in an autonomous loop. |
| ⚙️ **Heuristic agent** | When **no** API key is set *(default)* | Deterministic scoring over the page's accessibility labels, control types, and document order. No API, fully offline. |

Both brains drive the **same set of primitive tools** — they only differ in *how* they choose coordinates.

> 💡 The heuristic brain means **the demo always works**, even with no API key and no internet model access.

---

## ✨ Features

- ✅ **All seven required tools**, implemented in `BrowserController`:
  `open_browser`, `navigate_to_url`, `take_screenshot`, `click_on_screen(x, y)`, `send_keys`, `scroll`, `double_click` *(plus `press_key`)*.
- 🔌 **Pluggable brain** — LLM when a key is present, heuristic fallback otherwise.
- 🔍 **Intelligent element detection** — uses accessible labels, `aria-*`, placeholders, associated `<label>`s, control-type preference, and positional fallback *(`src/agents/matcher.ts`)*.
- 🔁 **Self-verification** — after filling, the agent reads the live field values back and only reports success if they actually match.
- 🛡️ **Robust error handling** — navigation / timeout / element-not-found errors are caught, logged, and (for the LLM) fed back so it can recover.
- 📋 **Comprehensive logging** — colourised console output **and** a full JSON run log written to `artifacts/`.
- 📸 **Artifacts** — a screenshot is saved at every meaningful step, plus a machine-readable `artifacts/result.json`.
- ⚙️ **Config via env vars / CLI** — nothing is hard-coded.

---

## 🚀 Quick Start

### Prerequisites

- **Node.js 18+** *(tested on Node 24)*
- Internet access to reach the target page

### 1. Install

```bash
npm install        # also downloads the Chromium browser (postinstall)
```

### 2. Run — no API key needed (uses the heuristic brain)

```bash
npm run agent
```

A Chromium window opens, the agent navigates to the shadcn form, fills in the Name/Title and Description fields, and prints a result report. Screenshots and `result.json` land in `./artifacts`.

### Other ways to run

**Headless** *(e.g. on a server / CI):*

```bash
HEADLESS=true npm run agent
```

**With the LLM brain:**

```bash
cp .env.example .env
# edit .env and set GROQ_API_KEY=gsk_...   (free key: https://console.groq.com/keys)
npm run agent

# or force it:
npm run agent -- --mode llm
```

---

## 🕹️ Usage & CLI Options

```bash
npm run agent -- [options]
```

> With **no options** it runs the built-in test (the shadcn form, default Name + Description). Pass options to point it at any other form.

| Option | Description | Default |
| :--- | :--- | :--- |
| `--url <url>` | Target page | shadcn react-hook-form docs |
| `--field "Label=Value"` | A field to fill — **repeatable**. When given, these *replace* the default Name/Description fields. | — |
| `--task "<text>"` | Free-text instruction for the LLM brain to interpret | — |
| `--mode <m>` | `auto` \| `llm` \| `heuristic` | `auto` |
| `--model <name>` | Groq model | `meta-llama/llama-4-scout-17b-16e-instruct` |
| `--name <text>` | Shortcut for the default Name/Title field | `John Doe` |
| `--description <text>` | Shortcut for the default Description field | see `.env.example` |
| `--headed` / `--headless` | Show / hide the browser window | headed |
| `--log <level>` | `debug` \| `info` \| `warn` \| `error` | `info` |
| `-h`, `--help` | Show help | — |

### Filling *any* form

There are **three ways** to tell the agent what to fill:

**1. Built-in test** — no arguments needed:

```bash
npm run agent
```

**2. Explicit fields** on any site — repeat `--field` (works with both brains). Labels are fuzzy-matched, so `"Customer name"` finds the right input:

```bash
npm run agent -- --url "https://www.selenium.dev/selenium/web/web-form.html" \
  --field "Text input=John Doe" \
  --field "Password=secret123" \
  --field "Textarea=Filled by the agent"
```

**3. Free-text instruction** — the Groq LLM figures out the mapping *(needs a key)*:

```bash
npm run agent -- --url "https://site.com/contact" \
  --task "Fill the form: name John Doe, email john@x.com, message Hello there"
```

### Other handy examples

```bash
# Force the offline brain and watch every decision
npm run agent -- --mode heuristic --log debug

# Just change the two default values
npm run agent -- --name "Ada Lovelace" --description "First programmer."
```

> All options also work as environment variables — see **`.env.example`** for the full, documented list.

---

## 🔧 Configuration

Copy `.env.example` to `.env` and edit. Highlights:

| Variable | Purpose |
| :--- | :--- |
| `GROQ_API_KEY` | Enables the LLM brain. Unset → heuristic brain. |
| `GROQ_MODEL` | Groq vision model (default `meta-llama/llama-4-scout-17b-16e-instruct`). |
| `GROQ_BASE_URL` | Override Groq's API endpoint (rarely needed). |
| `AGENT_MODE` | `auto` / `llm` / `heuristic`. |
| `TARGET_URL` | Page to automate. |
| `FIELD_NAME_VALUE`, `FIELD_DESCRIPTION_VALUE` | Text to type. |
| `HEADLESS` | Hide the browser window. |
| `VIEWPORT_WIDTH/HEIGHT`, `SLOW_MO_MS`, `DEFAULT_TIMEOUT_MS` | Browser tuning. |
| `MAX_STEPS` | Safety cap on the LLM agent loop. |
| `LOG_LEVEL`, `ARTIFACTS_DIR` | Logging / output. |

---

## 📁 Project Structure

```
.
├── src/
│   ├── index.ts                  # CLI entry point + run report
│   ├── config.ts                 # env/CLI configuration (validated)
│   ├── logger.ts                 # console + file structured logger
│   ├── browser/
│   │   └── BrowserController.ts   # Playwright wrapper = the 7 primitive tools
│   └── agents/
│       ├── types.ts              # Agent interface + result types
│       ├── matcher.ts            # element-scoring "intelligence" (shared)
│       ├── HeuristicAgent.ts     # offline brain
│       └── LLMAgent.ts           # Groq vision + tool-calling brain
├── artifacts/                    # screenshots + result.json + run log (gitignored)
├── .env.example
├── ARCHITECTURE.md               # design decisions & agent workflow
├── package.json
└── tsconfig.json
```

---

## 🧪 Scripts

| Script | What it does |
| :--- | :--- |
| `npm run agent` / `npm start` | Run the agent with `tsx` (no build step). |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run serve` | Run the compiled build (`node dist/index.js`). |
| `npm run typecheck` | Type-check without emitting. |

---

## 🛠️ How It Maps to the Assignment

| Requirement | Where |
| :--- | :--- |
| `take_screenshot` | `BrowserController.takeScreenshot` |
| `open_browser` | `BrowserController.openBrowser` |
| `navigate_to_url` | `BrowserController.navigateToUrl` |
| `click_on_screen(x, y)` | `BrowserController.clickOnScreen` |
| `send_keys` | `BrowserController.sendKeys` |
| `scroll` | `BrowserController.scroll` |
| `double_click` | `BrowserController.doubleClick` |
| Modular, composable tools | `BrowserController` + `Agent` interface |
| Intelligent element detection | `matcher.ts` (heuristic) + vision loop (LLM) |
| Error handling | try/catch + bounds checks + LLM error feedback |
| Logging | `logger.ts` (console + `artifacts/*.log`) |
| Configuration via env/files | `config.ts` + `.env` |

> 📖 See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the design rationale and the full **perceive → reason → act** workflow.

---

## 🩺 Troubleshooting

| Problem | Fix |
| :--- | :--- |
| **`browserType.launch: Executable doesn't exist`** | Run `npx playwright install chromium`. |
| **Nothing happens / blank page** | The docs site may be slow — increase `DEFAULT_TIMEOUT_MS`. Re-run with `--log debug` to see every step. |
| **LLM brain not used** | Confirm `GROQ_API_KEY` is set, or force it with `--mode llm`. |
| **Want to see it live in a viva** | Run without `HEADLESS` and with `SLOW_MO_MS=400` so each action is easy to follow. |
