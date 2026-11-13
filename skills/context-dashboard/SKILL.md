---
name: context-dashboard
description: Open or inspect the Context Dashboard sidecar panel for current conversation context usage, generation speed (TTFT / tok/s), model quotas, and local token history.
---

# Context Dashboard

This plugin provides an official Antigravity Sidecar UI panel (`context-dashboard/context_board`) rendered in the auxiliary side pane.

## Opening the Panel

Surface a clickable `sidecar://` pill so the user can open or toggle the sidecar panel:

```markdown
[Context Dashboard](sidecar://context-dashboard/context_board/)
```

## Capabilities (Read-Only)

- **Context Window & Compression**: Tracks current conversation context against both the platform compression limit (`256K` / `80K`) and physical model window (`1M` / `131K`), with compression drop detection (`> 5K`).
- **Speed & Latency**: Computes per-turn TTFT (`viewableAt - createdAt`), total generation duration (`finishedGeneratingAt - createdAt`), and output speed (`tok/s`).
- **Model Quotas**: Reads live remaining quota fractions and reset times from `GetUserStatus`.
- **Token History**: Aggregates Desktop (`~/.gemini/antigravity/brain/`) and CLI (`~/.gemini/antigravity-cli/brain/`) `transcript.jsonl` files into an 84-day heatmap and per-model breakdown.
