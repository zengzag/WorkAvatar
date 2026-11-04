<div align="center">

# WorkAvatar

### AI employees that do the work themselves, on your own machine.

Create a digital employee: give it a role, a model and a tool set. It breaks the task down, calls tools, reads and writes files on your computer, runs commands, and hands you the result. Notes, calendar, voice recognition, automation, workflow templates, image generation and more are available as plugins and can be installed when you need them.

[![Stars](https://img.shields.io/github/stars/zengzag/WorkAvatar?style=flat-square&color=yellow)](https://github.com/zengzag/WorkAvatar/stargazers)
[![Release](https://img.shields.io/github/v/release/zengzag/WorkAvatar?style=flat-square)](https://github.com/zengzag/WorkAvatar/releases)
[![Downloads](https://img.shields.io/github/downloads/zengzag/WorkAvatar/total?style=flat-square)](https://github.com/zengzag/WorkAvatar/releases)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0aa?style=flat-square)](#install)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?style=flat-square)](#contributing)

[**Download**](https://github.com/zengzag/WorkAvatar/releases/latest) · [Highlights](#highlights) · [Features](#features) · [Plugins](#plugins) · [Build from source](#build-from-source)

[简体中文](README.md) | **English**

<img src="images/agent-chat.gif" alt="An employee planning a task, searching local documents, reading files and writing output" width="86%" />

</div>

---

## Highlights

- **Your documents stay local.** Parsing, tokenizing, indexing and search all run on your machine, and keyword search keeps working when the model service is unreachable. Only the content a task actually needs is sent to the provider you configured.
- **Commands run in an OS sandbox.** Reads are unrestricted; writes are limited to the task workspace and a private temp directory. A write outside those paths is denied by the kernel rather than guessed at by static analysis of the command text.
- **The knowledge base is searchable right away.** No waiting on embeddings: keyword search works as soon as a folder is added, while vectors, paragraph summaries and knowledge cards are built in the background for the files you actually use.
- **Employees are long-lived.** Role, tools and memory stay fixed, task artifacts stay in their own workspaces, and an employee can be exported and imported on another machine.
- **Light and extensible.** Plugins are supported, with around ten optional ones bundled — notes, calendar, voice, automation, workflow templates, image generation and more (see [plugins](#plugins)) — and multi-step flows can be built as template tasks on a canvas.

---

## Features

### Digital employees

Each employee has its own instructions, default model, tool set and memory. Describe a task and it plans the steps and calls tools, with the whole run visible in the conversation: what it is doing, which file it opened, what it wrote, where it failed.

<img src="images/employees.png" alt="Digital employee management" width="86%" />

- **Tools** — read, write, edit, copy and delete files, run shell commands (including long-running background jobs), search and fetch the web, recognize images, local OCR, generate Word / Excel / PowerPoint documents, search the knowledge base and past conversations. Tools are configurable per employee, and external MCP servers can be attached.
- **Delegation** — hand work to other employees or ephemeral roles, up to 5 in parallel and two levels deep. Each sub-task runs in its own workspace and returns only a result summary, so the supervisor's context stays focused. Built-in `explore` (read-only research) and `general` (full capability) roles are included.
- **Memory and skills** — cross-task memory keeps your preferences and past lessons; skills are Markdown-defined capabilities loaded on demand instead of occupying the standing context. A Knowledge Search Assistant is built in.
- **File permissions** — file tools can freely read and write inside the current task's workspace; anything else asks first. When a task genuinely needs broader access the assistant requests it, and you choose between a one-off approval, approval for the current task, or a switch of execution mode. Deletions and other irreversible actions still ask every time.
- **Exportable employees** — persona, tools, skills and related configuration can be packaged and imported on another machine.

### Desktop secretary

A small pet stays on your desktop and takes a task in one sentence: pick an employee, type — the run starts in the background and shows up in the normal task list right away, ready to open. `Ctrl+Alt+Space` brings it up; size, do-not-disturb and hiding live in Settings → Secretary.

### Local knowledge base

<img src="images/kms-search.gif" alt="Hybrid search across local documents" width="86%" />

Add folders to the knowledge base and employees can search the project files, contracts, reports and meeting notes inside them.

- **Hybrid search** — full-text keyword, semantic vector and filename matching run in parallel, then merge into one ranking. Switch between Hybrid / Keyword / Semantic / Filename, and filter by file type, time range, directory or collection.
- **Everything integration (optional)** — on Windows, Filename search can use Everything. Enable Everything's HTTP server for real-time results without maintaining directory metadata; it falls back to built-in search automatically when unavailable.
- **Progressive enhancement** — files that are opened or matched often gain paragraph summaries, vectors and knowledge cards in the background, with a dedicated knowledge-card page. Cold files stay as lightweight index entries, so cost grows with actual use.
- **Collections** — group related files and get an auto-generated summary and table of contents, ready to browse or to hand to an employee as context.
- **Supported formats** — PDF, Word, Excel, CSV, PowerPoint, Markdown, plain text, HTML, and images through local OCR.
- **Built-in MCP service** — exposes search to other MCP clients on the same machine at `127.0.0.1`, with a generated access token.

### Plugins

The app ships with a set of optional plugins, imported, enabled or removed from Settings → Plugins; changes apply without a restart.

| Plugin | What it does |
|------|------|
| **Notes** | Markdown notes stored as plain `.md` files. File tree, editor and outline in three panes, with multiple tabs and full-text search. |
| **Calendar & To-dos** | Month / week / day views, recurring events, reminders and optional one-way Outlook sync. Employees can create and edit events on request. |
| **Voice Recognition** | Offline recognition via sherpa-onnx, transcribing while recording and generating meeting minutes afterwards. |
| **Automation** | Runs an employee task on a daily, working-day, weekly, monthly or yearly schedule, retries on failure and notifies you. |
| **Task Templates** | Build multi-step workflows on a canvas with review, condition, loop, parallel and human nodes; a failing review sends the work back for another round. |
| **Image Studio** | Slide, research and architecture visuals with purpose presets and prompt optimization, working with Volcengine Seedream, Qwen Image and OpenAI GPT Image. |
| **Data Model** | Visual table / field / relationship modeling with DBML import and export. |
| **Word Editor** | Import docx, rich-text editing, AI rewrite in chat and version snapshots, exporting to docx / PDF. |
| **Skill Hub** | Deep research, draw.io diagrams, scientific figure prompts and defense decks, assignable to employees. |
| **AI Assistant Hub** | Opens third-party AI sites such as Doubao and DeepSeek inside the app with isolated login state per site. Subject to each site's own terms. |

Plugins can also contribute navigation pages, settings tabs, agent tools, MCP tools, shortcuts and their own employees. Want to write one? See [plugin development](#plugin-development), or let the built-in Plugin Development Assistant scaffold it inside the app.

<img src="images/plugins.gif" alt="Enabling and managing plugins" width="86%" />

<div align="center">
  <table><tr>
    <td><img src="images/notes.png" alt="Notes" width="100%" /></td>
    <td><img src="images/calendar.png" alt="Calendar & To-dos" width="100%" /></td>
  </tr><tr>
    <td><img src="images/voice.png" alt="Voice recognition and meeting minutes" width="100%" /></td>
    <td><img src="images/automation.png" alt="Automation" width="100%" /></td>
  </tr><tr>
    <td><img src="images/workflow.gif" alt="Task templates" width="100%" /></td>
    <td><img src="images/image-studio.gif" alt="Image Studio" width="100%" /></td>
  </tr></table>
</div>

---

## Quick start

### Install

Download the installer for your platform from [Releases](https://github.com/zengzag/WorkAvatar/releases/latest): Windows or macOS (pick the Intel or Apple silicon build). On Linux, [build from source](#build-from-source).

The first launch opens a short setup that walks you through connecting a model service and creating your first employee. You can skip it and run it again from Settings → General.

### Three steps

1. **Add a knowledge base** — in Knowledge Base → Document Management, add a folder. The index builds and stays in sync automatically.
2. **Search it** — type a keyword in the top search box and switch between Hybrid / Keyword / Semantic / Filename as needed.
3. **Hand over a task** — go to Digital Employees, pick or create an employee, and describe the task. It searches the knowledge base as needed and writes output into the task's own workspace. The sidebar button at the top right of a task opens workspace files, a terminal and in-place previews.

> To keep it within reach, open the **desktop secretary** from the task list header and give it a task in one sentence.

### Build from source

**Requirements:** Windows, macOS or Linux, Node.js 24+, npm 11+.

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
| **A long-lived team employee** | A fixed role, tool set and memory that a team can hand the same kind of work to again and again; export it to continue on another machine. |
| **Scheduled background work** | A daily briefing or weekly digest generated by an automation and delivered to a conversation. |
| **Multi-step work that needs review** | A template task that drafts, reviews, and sends failures back for another round until it passes. |
| **Exposing your search** | Let other local AI clients search your documents through the built-in MCP service. |
| **Internal tool plugins** | Package an internal workflow as a plugin with its own navigation page and tools. |

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

React, ReactDOM, antd and i18next are injected by the host through `__WA_HOST__`, so you do not install them yourself and there is only one React instance. Or let the built-in Plugin Development Assistant scaffold it for you.

---

## Architecture

WorkAvatar runs on Electron, with the agent runtime, the UI and the plugin host kept in separate layers.

- **Main process** — agent runtime (planning, tool execution, delegation), model providers, the knowledge base (SQLite + vector search), the file permission service and the shell sandbox.
- **Renderer** — React UI and streaming conversation state; plugin pages load over the `plugin://` scheme.
- **Plugins** — a separate SQLite database and declared capabilities per plugin, enabled or disabled without a restart.
- **Models** — mainstream international and Chinese providers, LM Studio and any OpenAI-compatible endpoint.

| Category | Technology |
|------|------|
| Runtime | Electron 44 |
| Frontend | React 19 + TypeScript + Ant Design 6, Vite 8 |
| Local database | SQLite (FTS5 full-text + sqlite-vec vector) |
| Document parsing | PDF, Word, Excel, PowerPoint, HTML, OCR (PaddleOCR) |
| Speech recognition | sherpa-onnx (offline) |

> First-party plugin sources live in a separate repository, `WorkAvatar-Plugins`, included here as the `plugins/` git submodule; `plugin-sdk/` is maintained in this repository.

---

## FAQ

**Does my data leave my machine?**
Indexing and search do not. A task sends only the context the model needs to the provider you configured, and workspaces stay local.

**Can I use a local model?**
Yes. Point the provider at LM Studio or any OpenAI-compatible local server. Keyword search works even with no model at all.

**Can it damage my files?**
Shell commands are constrained by the OS sandbox, and writes outside the workspace are rejected. File tools show a diff and ask for confirmation when the target is outside the workspace or sensitive; deletions and other irreversible actions ask every time.

**Which models are supported?**
Mainstream international and Chinese providers plus local servers.

**How do I publish a plugin?**
Read the [protocol](plugin-sdk/PROTOCOL.md), start from [hello-world](plugins/examples/hello-world/), or let the built-in Plugin Development Assistant scaffold it. Package it as a `.wap` file to share.

---

## Contributing

Issues and pull requests are welcome. Bug reports with reproduction steps and screenshots are usually fixed fastest.

```bash
npm run test      # core tests
npm run test:all  # core + plugin tests
```

Plugins, translations, documentation and example templates are welcome too — share a plugin or template task as a PR or in an issue.

**If WorkAvatar saved you some time, a star helps more people find it.**

---

## License

[MIT License](LICENSE)

Third-party product names and trademarks mentioned here belong to their respective owners and are used for identification only.
