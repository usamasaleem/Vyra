# Vyra Knowledge Dashboard

A visual, shareable-by-link version of the knowledge hub — charts, hierarchy and a consistent design system instead of raw Markdown. Each file here is a self-contained HTML page, published as a Claude Artifact so it can be shared by link.

## Sections

| File | Live link | Status |
| --- | --- | --- |
| [index.html](./index.html) | https://claude.ai/code/artifact/1485c888-e5f8-4130-b204-82e6c45ddc35 | Live — hub |
| [market-research.html](./market-research.html) | https://claude.ai/code/artifact/2aa41b71-5b88-4b40-acae-77bb08e84856 | Live |
| [agents.html](./agents.html) | https://claude.ai/code/artifact/3d6078c4-c4db-4afd-b737-a5b99212ca3d | Live |
| [roadmap.html](./roadmap.html) | https://claude.ai/code/artifact/e8010af9-4100-4978-93ec-20a1b096dfb2 | Live |
| Product / handoff brief | — | Not started |
| Implementation status | — | Not started |

The hub link publishes all four pages together, so relative navigation works inside it — share that one rather than the individual pages.

Live links are private by default — share from the artifact's own share menu when a page is ready for others to see.

## Working notes

- Each page is a single HTML file with inline CSS. The design system is: Inter Tight for display type, Inter for body and UI, a three-level depth ladder (`#DFDFDF` canvas → `#F1F1F1` surface → `#FFFFFF` card), `#00A651` green accent, 24px card radius and pill-shaped tags.
- Pages about *figures* carry a confidence tag (`Reported` / `Modeled` / `Needs validation`); pages about *scope* carry a scope tag (`In MVP` / `Post-MVP` / `Human only`). Both use the same tag component. Every item gets one — pulled directly from the epistemic caveats already present in `docs/Vyra-MARKET-RESEARCH.md` and `WHATSAPP-AGENT-BRIEF.md`. Keep that convention when adding new sections so the dashboard doesn't present estimates with more confidence than the source material does.
- Source content lives in `docs/` and the root-level briefs — this folder is a presentation layer on top of that content, not a replacement for it. Update the source doc first, then reflect the change here.
- The HTML files here are the last-published version. If you edit and republish via Claude, copy the updated file back into this folder to keep the repo in sync.
