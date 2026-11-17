# Connecting your own agents

TeXdraft works with the agents you already use. You can connect them in three ways. Whichever you choose, edits sync live into open editors, and a checkpoint is saved before an agent's first edit so you can restore it from History.

## 1. Claude Code or Codex on your computer, driven from the web chat

Use the subscription you already have, from TeXdraft's AI panel. Your computer does not need a public IP.

1. In the AI panel, open the backend menu and choose **Use Codex / Claude Code on your computer…**. The dialog shows two commands. The first downloads the bridge (`texdraft-bridge.mjs`, a single file that needs Node.js 22+ and has no dependencies). The second runs it with an access token.
2. While the bridge is running, pick the agent on **your computer** in the same menu and chat as usual.

The bridge only runs `claude` or `codex`, and it builds their command lines itself from a fixed template. The agent may only use TeXdraft's MCP tools: Claude Code's built-in tools are disabled, and Codex's shell, code execution, browser and web search are turned off. The agent cannot read or write files on your computer.

## 2. CLI agents over MCP (Claude Code, Codex, Gemini CLI)

In the editor, open **More → Connect local agent**. Create an access token, which you can limit to one project, and run the command shown, for example:

```bash
claude mcp add -s user --transport http texdraft https://tex.example.com/mcp --header "Authorization: Bearer tp_…"
```

## 3. ChatGPT and Claude.ai

Add a custom MCP connector:

- URL: `https://tex.example.com/mcp`
- Authentication: OAuth. Leave the client ID and secret empty.

You sign in to TeXdraft and choose which projects to grant. Connections appear in the token list and can be revoked there.

If the site is behind an access proxy such as Cloudflare Access, let these paths through: `/mcp`, `/.well-known/oauth-*`, `/oauth/token` and `/oauth/register`. They are protected by OAuth themselves.

## MCP tools (33)

| Group | Tools |
|---|---|
| Files | `list_files` `read_file` `grep` `str_replace` `write_file` `delete_file` `move_file` `copy_file` `upload_file` `replace_in_project` |
| Folders | `create_folder` (may stay empty) `move_folder` (with contents) `delete_folder` |
| Projects | `list_projects` (with your tags, optional tag filter) `create_project` `copy_project` `get_project` `update_project` (rename, main file, engine) `tag_project` `get_outline` |
| Compile and references | `compile` `get_compile_result` `search_citations` `add_citation` |
| Paper review | `get_pdf_pages` (rendered pages and text), `get_compile_diagnostics` (file:line, source excerpt, hints), `get_project_dependencies`, `get_citation_context` |
| Atomic multi-file edits | `apply_patch` (edit list or unified diff, dry run, rollback) |
| History | `list_versions` `save_version` `restore_version` `get_file_diff` |

Authentication options:

- **CLI agents** use personal access tokens.
- **ChatGPT and Claude.ai** use OAuth 2.1 with PKCE, refresh-token rotation, Client ID Metadata Documents and dynamic client registration.
