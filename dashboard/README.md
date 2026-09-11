# Vyra Knowledge Dashboard

A visual, shareable-by-link version of the knowledge hub — charts, hierarchy and a consistent design system instead of raw Markdown. Each file here is a self-contained HTML page, published as a Claude Artifact so it can be shared by link.

## Sections

| File | Live link | Status |
| --- | --- | --- |
| [market-research.html](./market-research.html) | https://claude.ai/code/artifact/2aa41b71-5b88-4b40-acae-77bb08e84856 | Live |
| Product / handoff brief | — | Not started |
| Implementation status | — | Not started |
| Roadmap | — | Not started |

Live links are private by default — share from the artifact's own share menu when a page is ready for others to see.

## Working notes

- Each page is a single HTML file: inline CSS, IBM Plex Mono for data, Fraunces for display type, Manrope for body/UI text.
- Every figure carries a confidence tag (`Reported` / `Modeled` / `Needs validation`) — pulled directly from the epistemic caveats already present in `docs/Vyra-MARKET-RESEARCH.md` and `WHATSAPP-AGENT-BRIEF.md`. Keep that convention when adding new sections so the dashboard doesn't present estimates with more confidence than the source material does.
- Source content lives in `docs/` and the root-level briefs — this folder is a presentation layer on top of that content, not a replacement for it. Update the source doc first, then reflect the change here.
- The HTML files here are the last-published version. If you edit and republish via Claude, copy the updated file back into this folder to keep the repo in sync.
