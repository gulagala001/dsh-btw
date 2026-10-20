# DSH BTW

English | [中文](README.zh.md)

Ask side questions in DeepSeek Harness while your main task keeps running. BTW uses the current conversation as context and keeps its answers in a compact, dismissible popover above the main composer.

![Side question and history menu in DSH](docs/images/side-chat.png)

*Example with synthetic conversation content.*

## Usage

- Type `/btw your question` to ask directly. Type `/btw` without a question to open the popover and revisit side-chat history.
- The popover uses native DSH components for Markdown, code copying and follow-up questions. Its history icon opens a list of previous questions, including when opened with `/btw your question`.
- **Stop side chat** cancels only the side request. **Esc** or closing the popover hides it while the answer continues. Clicking outside returns to the main interface.
- Each main conversation has its own latest 20 side exchanges. These live only in the current window's memory and disappear on reload, window closure, or plugin removal.

BTW preserves the main conversation's message prefix, last-used model configuration, tool declarations and cache affinity, then appends the side question to allow provider cache reuse. Actual cache hits depend on the provider. The snapshot includes completed tool results; a main reply still being generated is not included. Previously finished conversations are supported too.

Side requests never execute tools or append their questions and answers to the main conversation. They use your existing model provider and incur normal usage. Send at least one main message before using `/btw`.

The slash command preserves a draft containing attachments and explains that side questions accept text only. Attachments are not discarded.

## Installation

For **DeepSeek Harness 0.2.1-rc.2**, **Cordis 4.0.5** and **Node.js 22.19+**. Open **Plugins → Add Plugin** and paste:

```text
https://github.com/gulagala001/dsh-btw/releases/download/v0.1.0-dsh.0.2.1-rc.2/gulagala001-dsh-btw-0.1.0-dsh.0.2.1-rc.2.tgz
```

Restart that instance after its tasks finish. Package identity: `@gulagala001/dsh-btw`. Packages are distributed through GitHub Releases.

[Installation guide](docs/install.md) · [Release notes](docs/releases/v0.1.0-dsh.0.2.1-rc.2.md)

Validated with the native Web client on macOS. Windows, Linux and the Electron desktop shell have not been tested.

## Development

```sh
npm ci
npm run build
npm test
npm pack
```

The client imports `Menu`, `MenuSurface`, `Input`, `Button`, `MarkdownText` and `TextShimmer` from the host. Its only entry point, `/btw`, uses native input triggers. The server reads a detached session snapshot and makes an independent streaming request without a tool executor. Cold sessions are replayed only in memory without activating the main agent.

[MIT license](LICENSE).
