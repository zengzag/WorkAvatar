# WorkAvatar — Office Digital Employee Workbench

<div align="center">

![Version](https://img.shields.io/badge/version-1.3.0-blue)
![Electron](https://img.shields.io/badge/Electron-35-green)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-6-blue)
![License](https://img.shields.io/badge/license-MIT-green)

**A local-first digital employee workbench for Windows — organize document knowledge with a knowledge base, extend capabilities with plugins.**

Document parsing, index building, speech recognition, and retrieval run on your machine. Model inference and embedding use the model service you configure — a local service or a cloud API — so whether data leaves your device depends on that configuration.

**English** | [简体中文](README.zh-CN.md)

</div>

---

## Table of Contents

- [Why WorkAvatar](#why-workavatar)
- [Digital Employees: AI Colleagues That Use Tools](#digital-employees-ai-colleagues-that-use-tools)
- [Local Knowledge Base (KMS)](#local-knowledge-base-kms)
- [Plugin-Based Extensibility](#plugin-based-extensibility)
- [Quick Tour](#quick-tour)
- [Key Features](#key-features)
- [Use Cases](#use-cases)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [License](#license)

---

## Why WorkAvatar

Office work accumulates a large amount of local documents — project files, contracts, reports, technical docs, meeting notes. To let AI truly make use of this knowledge, common approaches each have trade-offs:

- **Keyword search**: quick to start, but literal matching only — weak for cross-document synthesis and concept-level understanding.
- **RAG semantic search**: understands meaning, but usually requires full-scale vectorization upfront — the more documents, the longer the wait. Pure semantic matching also produces "looks relevant, actually isn't" results.
- **Knowledge graphs**: strong at relationships, but costly to build and maintain, and best suited to deep, domain-specific applications.

WorkAvatar takes a middle path: **start lightweight, refine progressively.** Add a directory and search immediately with a lightweight keyword index; as you use it, semantic vectors, summaries, and knowledge cards are filled in gradually, so retrieval quality keeps improving over time.

---

## Digital Employees: AI Colleagues That Use Tools

<div align="center">
  <img src="images/agent-chat.gif" alt="Digital employee task conversation" width="88%" />
</div>

Digital employees are the core of WorkAvatar: each role gets its own profile — system prompt, default model, available tools, external MCP services, and persistent memory. Pick an employee, describe your request, and it autonomously calls tools to complete the task with a fully visible process.

<div align="center">
  <img src="images/employees.png" alt="Digital employee management" width="88%" />
</div>

- **Streaming conversation**: streaming responses with reasoning and tool calls shown step by step; supports asking multiple models in parallel for side-by-side comparison.
- **Tool system**: built-in tools for file read/write/edit/delete (deletion moves to the recycle bin and is recoverable), code execution, web search, knowledge base retrieval, Office document generation, and more — configured per tool as **always-on / on-demand / off**; MCP tools are dynamically integrated.
- **File safety & rollback**: all file write/edit/delete operations pass a unified permission gate. Operations outside the workspace, or on sensitive files (`.env`, keys, `.git`, …), require confirmation; irreversible deletes can never be pre-authorized ("always allow" / "don't remind again" are unavailable); the change is previewed as a diff in the confirmation dialog; and every change can be rolled back from the task's file-change history.
- **Task delegation**: digital employees can delegate sub-tasks to each other, with parallel dispatch and follow-up queries, and a delegation depth cap of 3 levels. Sub-tasks run independently and only return a summary.
- **Persistent memory**: preferences, constraints, and lessons learned during conversations are captured automatically. Pinned and key memories stay resident, the rest are retrieved on demand; a cross-employee global memory is also available.
- **Skills extension**: supports skills in the SKILL.md format, so third-party skills can be installed.
- **Isolated workspaces**: each task gets its own sub-directory with no interference; employee profiles can be exported/imported for team reuse.
- **Built-in and plugin employees**: the host ships built-in employees such as the "Knowledge Search Assistant", and plugins can declare their own digital employees. Built-in/plugin employees are grouped and read-only, and can be personalized after saving a copy.

---

## Local Knowledge Base (KMS)

<div align="center">
  <img src="images/kms-search.gif" alt="Local knowledge base hybrid search" width="88%" />
</div>

Hand your local folders over to the knowledge base for personal and team document retrieval:

- **Ready on add**: adding a directory builds a keyword index first, so you can search without waiting for full vectorization. File additions, changes, and deletions sync to the index automatically, and you can also rebuild incrementally from a given node.
- **Hybrid retrieval**: full-text keywords (SQLite FTS5 + Chinese tokenization), semantic vectors, and file names are retrieved in three parallel paths and fused with RRF ranking — exact matching as the baseline, semantic search for recall, balancing precision and coverage.
- **Progressive refinement (hot/cold tiers)**: cold data stores only a lightweight index; frequently accessed files are automatically promoted to hot data, gaining chapter summaries, semantic vectors, and knowledge cards, improving over time with use. Long-unused content is automatically demoted to control resource usage.
- **Collections**: hand-pick files into topical collections with automatically generated global summaries and table-of-contents structures, making them easy to search by topic or feed to digital employees.
- **Format coverage**: PDF, Word, Excel, PPT, Markdown, TXT, HTML, and images (OCR). When the LLM is unavailable, it falls back to basic retrieval.

> Data handling: document parsing, index building, and retrieval are performed locally. Embedding and model inference are executed by the model service you configure (local or cloud), so whether data leaves your device depends on that configuration. The knowledge base retrieval capability can also be exposed to other local agent tools via a built-in MCP service (listening on 127.0.0.1 only).

---

## Plugin-Based Extensibility

<div align="center">
  <img src="images/plugins.gif" alt="Plugin management" width="88%" />
</div>

WorkAvatar does not hard-wire features into the main program: **navigation-page features (notes, calendar, voice recognition, automation, data model, and more) are all delivered as plugins**, using exactly the same loading logic as third-party plugins. Plugins use a **manifest declaration + dual-entry plugin package + host extension points** architecture, and open up data access, a unified execution entry, an event bus, and UI injection through **capability authorization**, maximizing extensibility within a controlled boundary.

- **Independent distribution**: plugins are packaged as `.wap` (a zip archive) and can be imported, enabled/disabled, deleted, and upgraded in place via **Settings → Plugins** — all taking effect immediately without a restart.
- **Independent storage**: each plugin uses its own SQLite database (`userData/plugin-data/<id>/`), isolated from one another and from the main database.
- **UI injection**: plugins can register navigation pages, settings-page tabs, conversation-page toolbars, and other views; the renderer shares the host's React/antd singletons and automatically inherits light/dark themes and i18n.
- **AI-assisted development**: a built-in plugin-dev Skill lets digital employees help develop plugins straight from the installed app — scaffolding, coding, building, and installing, end to end.
- **Plugin digital employees**: plugins can declare their own digital employees in the manifest (e.g., a "Calendar Assistant"), grouped with built-in employees and personalized after saving a copy.

| Plugins shipped with the app | Description |
|------|------|
| **Notes** | Markdown notes stored as `.md` files, with repositories directly accessible to external tools and sync drives; a three-pane file tree / editor / outline layout with split preview and full-text search |
| **Calendar & To-dos** | Month/week/day schedule views plus quick to-do capture, with recurrence rules and reminders, and optional one-way sync with Outlook; digital employees can create and modify items on your behalf |
| **Voice Recognition** | Local offline speech recognition (sherpa-onnx), real-time subtitles from recording transcription, floating-window screen display, and structured meeting minutes generated on completion |
| **Automation** | Schedule digital employees to run recurring tasks on daily/weekly/monthly rules, with failure retries, completion notifications, and a traceable execution history back to conversations |
| **Data Model** | Canvas-based schema design with DBML import/export; conversational AI modeling with edits reflected on the canvas in real time |
| **Document Editor** | A full-featured document editor: `.docx` import/export and PDF export, rich-text layout, an AI assistant that edits directly (read structure / read body / rewrite paragraphs / replace / insert-delete-reorder / apply styles), version snapshots; the editor UI is localized to Chinese |
| **AI Assistants** | Open third-party AI web apps (such as Doubao and DeepSeek) in single-pane / dual-pane / tabbed layouts, with independent login state stored per site for easy multi-model comparison; use of each site is subject to its own terms of service |
| **Task Templates** | Build complex workflows on a visual canvas (input / agent / review / condition / loop / parallel / manual / tool / end), composing digital employees or template-scoped ephemeral roles; review nodes return a PASS/FAIL verdict so the flow iterates automatically until it passes (or a round limit is hit). Runs create a task on the Tasks page whose agent nodes execute as sub-sessions, with artifacts and history tracked. A built-in **Template Designer** employee can turn a plain-language requirement or an existing SOP into a ready-to-run template on its own. |

<div align="center">
  <table><tr>
    <td><img src="images/notes.png" alt="Notes" width="100%" /></td>
    <td><img src="images/calendar.png" alt="Calendar & To-dos" width="100%" /></td>
  </tr><tr>
    <td><img src="images/voice.png" alt="Voice Recognition" width="100%" /></td>
    <td><img src="images/automation.png" alt="Automation" width="100%" /></td>
  </tr></table>
</div>

Plugin protocol specs and development resources:

- Plugin protocol spec: [plugin-sdk/PROTOCOL.md](plugin-sdk/PROTOCOL.md)
- Plugin API reference: [plugin-sdk/API_REFERENCE.md](plugin-sdk/API_REFERENCE.md)
- Plugin capability matrix: [plugin-sdk/CAPABILITY_MATRIX.md](plugin-sdk/CAPABILITY_MATRIX.md)
- Plugin development & packaging tutorial: [plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md](plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md)
- Plugin example project: [plugins/examples/](plugins/examples/)

---

## Quick Tour

On first launch, an **onboarding wizard** starts automatically: connect a model service → create your first digital employee → learn how to use the knowledge base (skippable; you can re-run it later in **Settings → General**). You can also configure things manually as follows:

1. **Add a document directory**: open **Knowledge Base** → **Document Management** in the left navigation → add a directory; the index builds and syncs incrementally.
2. **Search documents**: enter keywords in the top search box for results, with four modes (hybrid / keyword / semantic / file name) and filters by file type and time range.
3. **Build collections**: pick files in Document Management to form topical collections with automatically generated global summaries and tables of contents.
4. **Dispatch tasks**: switch to **Digital Employees**, choose or create an employee, and start chatting; it will automatically search the knowledge base, call tools, and generate Word/Excel/PPT deliverables.

---

## Key Features

| Feature | Description |
|------|------|
| **Lightweight start** | Keyword indexing is enough to get going — no waiting for full vectorization |
| **Hybrid retrieval** | Keyword + semantic + file name in three paths, fused with RRF ranking |
| **Progressive precision** | Hot/cold tiering auto-promotes/demotes; frequently accessed content is deeply processed, improving as you use it |
| **Local-first** | Parsing, indexing, and retrieval run on your machine; inference and embedding use the model service you configure |
| **Plugin extensibility** | Core features are plugins, capability-domain authorized, with independent enable/disable and secondary development |
| **Multi-agent collaboration** | Task delegation and parallel dispatch between employees, with isolated sub-task execution |
| **File safety & rollback** | Unified permission gate with sensitive-file protection, diff preview before confirmation, and per-task file change rollback |
| **LLM fault tolerance** | Falls back to basic retrieval when the LLM is unavailable |

## Use Cases

- **Personal knowledge management**: quickly locate local documents, with AI-assisted organization, summarization, and document generation.
- **Sensitive document handling**: contracts, reports, and internal documents — document parsing and retrieval stay on your machine; configure a local model service if you also need inference to stay on-device.
- **Internal team knowledge base**: private deployment supporting daily document lookup and business analysis.
- **Agent development**: provide other agents with local document retrieval through the built-in MCP service.
- **Topical research**: organize subject materials with collections and process them progressively in depth.

---

## Tech Stack

| Category | Technology |
|------|------|
| Runtime | Electron 35 |
| Frontend | React 19 + TypeScript 6 + Ant Design 6 |
| Build | Vite 8 |
| State management | Zustand |
| Database | better-sqlite3 (FTS5 full-text index + sqlite-vec vector search) |
| Chinese tokenization | @node-rs/jieba |
| File parsing | PDF / Word / Excel / PPT / OCR |
| Speech recognition | sherpa-onnx |
| Internationalization | i18next |

> **Repository structure**: the source of the built-in plugins (notes/calendar/voice/automation/data-model/workflow) lives in a separate git repository, `WorkAvatar-Plugins`, as the `plugins/` submodule of this repo; `plugin-sdk/` (the plugin protocol type contracts) is owned by this repo. After cloning, run `git submodule update --init --recursive` to fetch the plugin sources.

---

## Getting Started

### Requirements

- Node.js >= 20.x
- npm >= 10.x
- Windows 10/11

### Install dependencies

```bash
# Fetch the plugin submodule (built-in plugin sources)
git submodule update --init --recursive

npm install
```

### Development mode

```bash
npm run dev
```

### Production build

```bash
npm run build
```

---

## License

[MIT](LICENSE)

Third-party product names, logos, and trademarks mentioned in this document belong to their respective owners and are used for identification purposes only.

---

<div align="center">

**WorkAvatar — Let digital employees work for you**

</div>
