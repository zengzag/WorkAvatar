# WorkAvatar

<div align="center">

![Version](https://img.shields.io/badge/version-1.4.0-blue)
![Electron](https://img.shields.io/badge/Electron-35-green)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-6-blue)
![License](https://img.shields.io/badge/license-MIT-green)

**English** | [简体中文](README.zh-CN.md)

</div>

WorkAvatar is a Windows desktop application centered around **digital employee agents**. Each digital employee is an independently working AI role with its own instructions, default model, and tool set — it plans steps on its own, invokes tools, reads and writes local files, and completes tasks. Two featured capabilities support it: a **local knowledge base search engine** so employees can quickly look up documents on your computer, and an **extensible plugin system** that lets the application grow over time.

---

## Table of Contents

- [Digital Employees](#digital-employees)
- [Local Knowledge Base](#local-knowledge-base)
- [Plugin Ecosystem](#plugin-ecosystem)
- [Quick Start](#quick-start)
- [Use Cases](#use-cases)
- [For Developers](#for-developers)

---

## Digital Employees

<div align="center">
  <img src="images/agent-chat.gif" alt="A digital employee working through a task" width="88%" />
</div>

Digital employees are the core of WorkAvatar. You can create as many as you want; each has its own role instructions, default model, tool set, and memory.

Describe a task, and the employee plans the steps and invokes tools on its own. The whole execution unfolds in a conversation — you see what it is thinking, which files it reads, what it writes, and where it runs into problems.

<div align="center">
  <img src="images/employees.png" alt="Digital employee management" width="88%" />
</div>

**Tool set** — file read / write / edit / delete, shell commands, JavaScript execution, web search, image recognition, and Word / Excel / PowerPoint document generation. Tools can be configured per employee; external MCP servers can also be attached.

**File safety** — all file operations go through a unified permission gate. Employees read and write freely inside an authorized workspace; anything outside the workspace or sensitive files (`.env`, private keys, `.git`) requires confirmation with a diff preview of the change. Every write and delete creates a snapshot, so any change can be rolled back.

**Sub-task delegation** — employees can split work into sub-tasks and hand them to other employees, in parallel or sequentially, up to three levels deep. Each sub-task runs in its own workspace and returns only a result summary, keeping the supervisor's context clean.

**Memory & Skills** — cross-task memory lets employees remember your preferences and prior lessons. Skills are Markdown-defined packages of specialized capabilities that employees load on demand. The application ships with a Knowledge Search Assistant and a Plugin Development Assistant; plugins can add their own employees.

---

## Local Knowledge Base

<div align="center">
  <img src="images/kms-search.gif" alt="Searching the local knowledge base" width="88%" />
</div>

The knowledge base lets digital employees quickly look up documents on your computer — project files, contracts, reports, meeting notes — by adding folders to it.

**Usable immediately** — add a folder and keyword search works right away, no waiting for vectorization to finish. The index tracks file changes automatically and supports incremental rebuilds.

**Hybrid search** — three search paths run in parallel: full-text keyword, semantic vector, and filename match, then merged into a single ranking. Switch between Hybrid / Keyword / Semantic / Filename modes, and filter by file type, time range, directory, or collection.

**Progressive enhancement** — files that are frequently opened or hit by search are automatically promoted in the background, gaining paragraph summaries, semantic vectors, and knowledge cards. Cold files stay as lightweight index entries, so resource usage scales with demand. The knowledge base is usable from day one and gets smarter with use.

**Collections** — group thematically related files into a collection. Each collection gets an auto-generated summary and table of contents for topic-based browsing or to hand as context to an employee.

**Offline-first** — document parsing, tokenization, indexing, and search all run locally. Keyword search remains usable even when the configured model service is unavailable. Supported formats: PDF, Word, Excel, PowerPoint, Markdown, plain text, HTML, and images via local OCR.

**MCP service** — a built-in MCP service exposes knowledge base search to other applications on the same machine. It binds only to 127.0.0.1 and requires a generated access token.

---

## Plugin Ecosystem

<div align="center">
  <img src="images/plugins.gif" alt="Managing plugins in Settings" width="88%" />
</div>

WorkAvatar was designed for plugins from the start. Notes, calendar, voice recognition, automation, data modeling, document editing, task templates, and third-party AI aggregation are all delivered as plugins. Enable, disable, import, remove, and upgrade from Settings → Plugins — changes take effect immediately, no restart needed.

Plugins can add navigation pages, settings tabs, and chat toolbars. They automatically follow the application's theme and language settings.

A bundled **Plugin Development Assistant** lets a digital employee develop and install a plugin inside the application. Plugins shared as `.wap` packages can also be imported.

### First-party plugins

| Plugin | Description |
|------|------|
| **Notes** | Markdown notes stored as `.md` files, so the folder works with sync services and other editors. Three-pane layout: file tree, editor, outline — with split preview and full-text search. |
| **Calendar & To-dos** | Month / week / day views, recurring events, reminders, optional one-way Outlook sync. Digital employees can create and edit events on request. |
| **Voice Recognition** | Offline recognition powered by sherpa-onnx. Live subtitles during recording, floating subtitle window, and meeting minutes generated after recording ends. |
| **Automation** | Run a digital employee task on a daily, weekly, or monthly schedule, with retry on failure and a notification when done. Each run links back to its conversation. |
| **Data Model** | Design database schemas on a canvas with DBML import and export. Models can also be edited through conversation. |
| **Document Editor** | Word-fidelity `.docx` editor with import / export, PDF export, and version snapshots. The AI assistant edits the open document directly — rewrite, replace, insert, delete, reorder, and adjust styles. Editor interface is in Chinese. |
| **Task Templates** | Build multi-step workflows on a canvas — agent, review, condition, loop, parallel, and human nodes — with pass / fail gating and round limits. A bundled Template Designer employee can turn a written requirement into a runnable template. |
| **AI Aggregator** | Open third-party AI websites such as Doubao and DeepSeek inside the app, in single-pane, dual-pane, or tabbed layouts, with isolated login state per site. Subject to each site's own terms of service. |

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

## Quick Start

On first launch, an onboarding wizard walks you through model service setup, creating your first digital employee, and the basics of the knowledge base. The wizard can be skipped and re-run later from Settings → General.

Manual setup is three steps:

1. **Add a knowledge base** — open Knowledge Base → Document Management from the left navigation, add a folder, and the index builds and stays in sync automatically.
2. **Search documents** — type keywords into the top search box. Switch between Hybrid / Keyword / Semantic / Filename modes, filter by type or time range.
3. **Start a conversation** — switch to Digital Employees, pick an employee (or create one), describe your task. The employee searches the knowledge base as needed and writes output files into the task's isolated workspace.

---

## Use Cases

- Let AI work on **local documents** — contract comparison, report drafting, project research — without uploading to the cloud.
- Build a **long-lived, reusable AI employee** for a team or personal use, with customizable role, tools, and memory.
- Hand repetitive work to **automation** — for example, auto-generate a daily morning briefing.
- Expose your local document search to other AI applications via the built-in **MCP service**.

---

## For Developers

### Plugin Development

The plugin protocol, API documentation, and example project ship with the repository:

- Protocol specification: [plugin-sdk/PROTOCOL.md](plugin-sdk/PROTOCOL.md)
- API reference: [plugin-sdk/API_REFERENCE.md](plugin-sdk/API_REFERENCE.md)
- Capability matrix: [plugin-sdk/CAPABILITY_MATRIX.md](plugin-sdk/CAPABILITY_MATRIX.md)
- Tutorial: [plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md](plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md)
- Example plugin: [plugins/examples/hello-world/](plugins/examples/hello-world/)

### Tech Stack

| Category | Technology |
|------|------|
| Runtime | Electron 35 |
| Frontend | React 19 + TypeScript 6 + Ant Design 6 |
| Build | Vite 8 |
| Local database | SQLite (FTS5 full-text + sqlite-vec vector) |
| Document parsing | PDF, Word, Excel, PowerPoint, HTML, OCR (PaddleOCR) |
| Speech recognition | sherpa-onnx (offline) |
| Internationalization | i18next (Chinese and English) |

> The source of the first-party plugins (notes, calendar, voice, automation, data model, document editor, task templates) lives in a separate repository, `WorkAvatar-Plugins`, and is included as the `plugins/` git submodule. `plugin-sdk/`, the plugin protocol type definitions, is maintained in this repository. Run `git submodule update --init --recursive` after cloning.

### Build from Source

**Requirements:** Windows 10/11, Node.js 20+, npm 10+

```bash
# Fetch the plugins submodule
git submodule update --init --recursive

npm install

# Development mode
npm run dev

# Production build
npm run build
```

### License

[MIT License](LICENSE)

Third-party product names, logos, and trademarks mentioned in this document belong to their respective owners and are used for identification only.
