<div align="center">

# WorkAvatar

### AI employees that do the work themselves, on your own machine.

WorkAvatar is an open-source desktop app for AI agents. You create a digital employee with its own role, model and tool set; it plans the steps, calls tools, reads and writes files on your computer, and returns the result. Notes, calendar, voice recognition, automation, task templates and an AI web aggregator all ship as plugins, so you can turn them off or replace them with your own.

[![Stars](https://img.shields.io/github/stars/zengzag/WorkAvatar?style=flat-square&color=yellow)](https://github.com/zengzag/WorkAvatar/stargazers)
[![Release](https://img.shields.io/github/v/release/zengzag/WorkAvatar?style=flat-square)](https://github.com/zengzag/WorkAvatar/releases)
[![Downloads](https://img.shields.io/github/downloads/zengzag/WorkAvatar/total?style=flat-square)](https://github.com/zengzag/WorkAvatar/releases)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-0aa?style=flat-square)](#quick-start)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?style=flat-square)](#contributing)

[**Download for Windows**](https://github.com/zengzag/WorkAvatar/releases/latest) · [Highlights](#highlights) · [Features](#features) · [Plugin SDK](plugin-sdk/PROTOCOL.md) · [Build from source](#build-from-source)

**English** | [简体中文](README.zh-CN.md)

<img src="images/agent-chat.gif" alt="An employee planning a task, reading files and writing output" width="92%" />

</div>

---

## Highlights

WorkAvatar is less about chatting and more about letting an agent act on your computer: read files, write files, run commands, search your documents. A few concrete choices make that practical:

- **Your documents stay local.** Parsing, tokenizing, indexing and search all run on your machine. Only the content a task actually needs is sent to the model provider you configured.
- **Commands run in an OS sandbox.** A restricted token plus directory ACLs on Windows, Seatbelt on macOS. Reads are unrestricted; writes are limited to the task workspace and a private temp directory. A write outside those paths is denied by the kernel, so the command fails.
- **Features ship as plugins.** Notes, calendar, voice recognition, automation, task templates and the AI web aggregator are separate plugins. Enable, disable, remove or replace them individually; changes apply without a restart.
- **The knowledge base is searchable right away.** Keyword search works as soon as a folder is added. Vectors, summaries and knowledge cards are built in the background for the files you actually use.

---

## Features

### Digital employees

Each employee has its own instructions, default model, tool set and memory. Describe a task and it plans the steps and calls tools, with the whole run visible in the conversation: what it is doing, which file it opened, what it wrote, where it failed.

<img src="images/employees.png" alt="Digital employee management" width="92%" />

- **Tools** — read, write, edit, copy and delete files, run shell commands, search the web (local browser or DeepSeek / Tavily / Brave API), recognize images, and generate Word / Excel / PowerPoint documents. Tools can be configured per employee, and external MCP servers can be attached.
- **Delegation** — split work into sub-tasks and hand them to other employees, in parallel or in sequence, up to two levels. Each sub-task runs in its own workspace and returns only a result summary, so the supervisor's context stays focused. Built-in `explore` (read-only research) and `general` (full capability) roles are included.
- **Memory and skills** — cross-task memory keeps your preferences and past lessons; skills are Markdown-defined capabilities loaded on demand. A Knowledge Search Assistant and a Plugin Development Assistant are built in.
- **File permissions** — file tools can freely read and write inside the current task's workspace; anything else requires your confirmation first. When a task genuinely needs broader access, the assistant asks for it and, once approved, the rest of the task runs without that restriction; deletions and other irreversible actions still ask every time, and you can switch back to manual approval from the execution mode whenever you like.

### Desktop secretary

A small pet sits on your desktop and takes a task in one sentence. Click it, pick an employee, type — the run starts in the background and lands in the normal task list, with tools, file permissions and results intact. The pet shows idle / working / waiting-for-you / done states, keeps a badge for results you have not opened, answers to `Ctrl+Alt+Space`, and can be resized, muted or hidden from Settings → Secretary.

Avatars can also be an uploaded image now; the same picture identifies the employee everywhere, including as the secretary's badge.

### Local knowledge base

<img src="images/kms-search.gif" alt="Hybrid search across local documents" width="92%" />

Add folders to the knowledge base and employees can search the project files, contracts, reports and meeting notes inside them.

- **Hybrid search** — full-text keyword, semantic vector and filename matching run in parallel, then merge into one ranking. Switch between Hybrid / Keyword / Semantic / Filename, and filter by file type, time range, directory or collection.
- **Progressive enhancement** — files that are opened or matched often gain paragraph summaries, vectors and knowledge cards in the background. Cold files stay as lightweight index entries, so cost grows with actual use.
- **Collections** — group related files and get an auto-generated summary and table of contents, ready to browse or to hand to an employee as context.
- **Works offline** — parsing, tokenizing, indexing and search are local. Keyword search keeps working when the model service is unreachable. Supported formats: PDF, Word, Excel, PowerPoint, Markdown, plain text, HTML, and images through local OCR.
- **Built-in MCP service** — exposes search to other MCP clients on the same machine at `127.0.0.1`, with a generated access token.

### Plugin ecosystem

<img src="images/plugins.gif" alt="Enabling and managing plugins" width="92%" />

Plugins can add navigation pages, settings tabs, chat toolbars, agent tools, MCP tools and keyboard shortcuts, and can provide their own digital employees. They follow the app's theme and language, keep data in a separate SQLite database, and are enabled, disabled, imported, removed or upgraded from Settings without a restart.

A bundled **Plugin Development Assistant** lets an employee write a plugin inside the app and install it. Plugins are shared as `.wap` packages.

| Plugin | What it does |
|------|------|
| **Notes** | Markdown notes stored as plain `.md` files, so sync services and other editors work with them directly. File tree, editor and outline in three panes, with split preview and full-text search. |
| **Calendar & To-dos** | Month / week / day views, recurring events, reminders and optional one-way Outlook sync. Employees can create and edit events on request. |
| **Voice Recognition** | Offline recognition via sherpa-onnx, with live subtitles and a floating subtitle window during recording, and meeting minutes generated when it stops. |
| **Automation** | Runs an employee task daily, weekly or monthly, retries on failure, and notifies you when done. Every run links back to its conversation. |
| **Task Templates** | Build multi-step workflows on a canvas with agent, review, condition, loop, parallel and human nodes, plus pass / fail gating and round limits. A built-in Template Designer turns a written requirement into a runnable template. |
| **AI Aggregator** | Opens third-party AI sites such as Doubao and DeepSeek inside the app in single, dual or tabbed layouts, with isolated login state per site. Any HTTPS page can be added. Subject to each site's own terms. |
| **Image Studio** | Built for slide visuals, research figures, architecture and flow diagrams: purpose presets for PPT slides and covers, scientific schematics, paper figures, charts, infographics, architecture diagrams, flowcharts and academic posters that set aspect ratio, text space, palette and no-text constraints automatically, plus AI prompt optimization. Works with Volcengine Seedream, Qwen Image and OpenAI GPT Image, with transparent backgrounds and reference images. Results are saved locally and employees can generate images through an agent tool. |

<div align="center">
  <table><tr>
    <td><img src="images/notes.png" alt="Notes" width="100%" /></td>
    <td><img src="images/calendar.png" alt="Calendar & To-dos" width="100%" /></td>
  </tr><tr>
    <td><img src="images/voice.png" alt="Voice Recognition" width="100%" /></td>
    <td><img src="images/automation.png" alt="Automation" width="100%" /></td>
  </tr><tr>
    <td colspan="2"><img src="images/workflow.png" alt="Task Templates canvas" width="100%" /></td>
  </tr></table>
</div>

---

## Quick start

### Install the app

Download the latest build from [Releases](https://github.com/zengzag/WorkAvatar/releases/latest) (Windows 10/11 installer). On macOS, [build from source](#build-from-source).

The first launch opens a short setup that walks you through connecting a model service and creating your first employee. You can skip it and run it again from Settings → General.

### First run

1. **Add a knowledge base** — in Knowledge Base → Document Management, add a folder. The index builds and stays in sync automatically.
2. **Search it** — type a keyword in the top search box and switch between Hybrid / Keyword / Semantic / Filename as needed.
3. **Hand over a task** — go to Digital Employees, pick or create an employee, and describe the task. It searches the knowledge base as needed and writes output into the task's own workspace. The sidebar button at the top right of a task opens workspace files, a terminal and in-place previews.

### Build from source

**Requirements:** Windows 10/11 or macOS, Node.js 24+, npm 11+.

```bash
git clone --recurse-submodules https://github.com/zengzag/WorkAvatar.git
cd WorkAvatar
npm install
npm run dev        # development
npm run build      # production build
```

Already cloned? Fetch the plugin sources with `git submodule update --init --recursive`.

> Since Electron 42 the binary is no longer downloaded by `npm install`; it is fetched on demand the first time you run `npm run dev` (or `npx install-electron`). On restricted networks keep the repo `.npmrc` `electron_mirror`, or set `ELECTRON_MIRROR` yourself.

---

## Use cases

| Scenario | What WorkAvatar does |
|------|------|
| **Local document work** | Contract comparison, report drafting, project research — on your own folders, without uploading a library to a cloud drive first. |
| **A long-lived team employee** | A fixed role, tool set and memory that a team can hand the same kind of work to again and again. |
| **Scheduled background work** | A daily briefing or weekly digest generated by an automation and delivered to a conversation. |
| **Exposing your search** | Let other local AI clients search your documents through the built-in MCP service. |
| **Internal tool plugins** | Package an internal workflow as a plugin, with its own navigation page, settings and agent tools. |

---

## Interface design

The 2026 visual direction is "precision grayscale with a light liquid-glass touch": density first, with glass reserved for the shell — title bar, navigation rail, task list, composer and workspace panel — while content surfaces stay solid for long-form reading and tables.

- Semantic tokens live in `src/styles/theme.css` (`--wa-*`) with matching light and dark sets; antd theme tokens are injected in `src/main.tsx`
- Light / dark / follow-system, four font-size levels, zh/en locales and `prefers-reduced-motion` are preserved
- New pages should reuse semantic variables or antd tokens instead of hard-coded colors

---

## Plugin development

A plugin is a folder with a `manifest.json`, a CommonJS main entry, an optional ESM renderer entry and locale files. Capabilities must be declared; the host checks them on each call, and services you did not declare are not available.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "engine": ">=0.2.0",
  "main": "dist/main/index.cjs",
  "renderer": "dist/renderer/index.js",
  "ipc": ["list-things"],
  "capabilities": [
    { "domain": "data", "entities": ["conversations"], "access": "read" },
    { "domain": "execute", "kinds": ["llm-chat"] },
    { "domain": "ui", "views": ["chat.toolbar", "settings.tab"] }
  ]
}
```

```ts
import type { PluginContext } from '@workavatar/plugin-sdk'

export async function activate(ctx: PluginContext): Promise<void> {
  ctx.ipc.handle('list-things', () => ctx.storage.openSqlite('index').prepare('SELECT * FROM things').all())

  ctx.contributions.registerAgentTools([{
    id: 'my_thing_lookup',
    name: 'my_thing_lookup',
    title: 'Look up my data',
    description: 'Query plugin data by keyword',
    parameters: { type: 'object', properties: { keyword: { type: 'string' } } },
    handler: (args) => `results for ${args.keyword}`,
    onDemand: true,
  }])
}
```

- Protocol: [plugin-sdk/PROTOCOL.md](plugin-sdk/PROTOCOL.md)
- API reference: [plugin-sdk/API_REFERENCE.md](plugin-sdk/API_REFERENCE.md)
- Capability matrix: [plugin-sdk/CAPABILITY_MATRIX.md](plugin-sdk/CAPABILITY_MATRIX.md)
- Tutorial: [plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md](plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md)
- Minimal example: [plugins/examples/hello-world/](plugins/examples/hello-world/)

React, ReactDOM, antd and i18next are injected by the host through `__WA_HOST__`, so you do not install them yourself and there is only one React instance.

---

## Architecture

WorkAvatar runs on Electron, with the agent runtime, the UI and the plugin host kept in separate layers.

- **Main process** — agent runtime (planning, tool execution, delegation), model providers, the knowledge base (SQLite FTS5 + sqlite-vec), the file permission service and the shell sandbox.
- **Renderer** — React 19 and Ant Design UI, streaming conversation state, and plugin pages loaded over the `plugin://` scheme.
- **Plugins** — a separate SQLite database per plugin, declared capabilities, a `plugin:<id>:` IPC namespace, and enable / disable without a restart.
- **Models** — OpenAI, Azure, DeepSeek, Qwen, Zhipu, Volcengine, Xiaomi, LM Studio and any OpenAI-compatible endpoint, over Chat Completions, Responses or Anthropic Messages.

| Category | Technology |
|------|------|
| Runtime | Electron 44 |
| Frontend | React 19 + TypeScript 7 + Ant Design 6, Vite 8 |
| Local database | SQLite (FTS5 full-text + sqlite-vec vector) |
| Document parsing | PDF, Word, Excel, PowerPoint, HTML, OCR (PaddleOCR) |
| Speech recognition | sherpa-onnx (offline) |
| Internationalization | i18next (Chinese and English) |

> First-party plugin sources live in a separate repository, `WorkAvatar-Plugins`, included here as the `plugins/` git submodule; `plugin-sdk/` is maintained in this repository.

---

## FAQ

**Does my data leave my machine?**
Indexing and search do not. A task sends only the context the model needs to the provider you configured, and workspaces stay local.

**Can I use a local model?**
Yes. Point the provider at LM Studio or any OpenAI-compatible local server. Keyword search works even with no model at all.

**Is there a macOS or Linux build?**
macOS currently requires building from source. Linux is not packaged yet.

**Can it damage my files?**
Shell commands are constrained by the OS sandbox, and writes outside the workspace are rejected. File tools show a diff and ask for confirmation when the target is outside the workspace or sensitive.

**How do I publish a plugin?**
Read the [protocol](plugin-sdk/PROTOCOL.md), start from [hello-world](plugins/examples/hello-world/), or let the built-in Plugin Development Assistant scaffold it. Package it as a `.wap` file to share.

---

## Contributing

Issues and pull requests are welcome. Bug reports with reproduction steps and screenshots are usually fixed fastest.

```bash
npm run test      # core tests
npm run test:all  # core + plugin tests
```

Plugins, translations, documentation and example templates are welcome too.

If WorkAvatar is useful to you, a star is appreciated.

---

## License

[MIT License](LICENSE)

Third-party product names and trademarks mentioned here belong to their respective owners and are used for identification only.
