# Vyra Knowledge Dashboard

A visual, shareable-by-link version of the knowledge hub — charts, hierarchy and a consistent design system instead of raw Markdown. Each file here is a self-contained HTML page, published as a Claude Artifact so it can be shared by link.

## Sections

| File | Live link | Status |
| --- | --- | --- |
| [index.html](./index.html) | https://claude.ai/code/artifact/1485c888-e5f8-4130-b204-82e6c45ddc35 | Live — hub |
| [architecture.html](./architecture.html) — Sales Agent Architecture (how the Sales Agent is built) | _in the hub artifact_ | Live |
| [market-research.html](./market-research.html) | https://claude.ai/code/artifact/2aa41b71-5b88-4b40-acae-77bb08e84856 | Live |
| [agents.html](./agents.html) — The Two Agents (what it does) | https://claude.ai/code/artifact/3d6078c4-c4db-4afd-b737-a5b99212ca3d | Live |
| [roadmap.html](./roadmap.html) | https://claude.ai/code/artifact/e8010af9-4100-4978-93ec-20a1b096dfb2 | Live |
| [build-plan.html](./build-plan.html) | _in the hub artifact_ | Live — interactive |
| Product / handoff brief | — | Not started |
| Implementation status | — | Not started |

The hub link publishes all six pages together, plus `assets/`,, so relative navigation works inside it — share that one rather than the individual pages.

On Netlify, the build plan syncs progress between devices through a Netlify Function and a site-wide Netlify Blobs store. Enter the owner's shared access code on each device; it is remembered for that tab's browser session. The repository contains only a SHA-256 verifier for a randomly generated 192-bit code, never the code itself. To rotate access, set `VYRA_PROGRESS_PASSCODE` in the site's Netlify environment and redeploy; that value overrides the verifier. The page keeps a local copy and retries pending saves after connection failures. It imports existing browser ticks when the shared store is first created. If shared progress already exists, it offers a manual import of ticks found only in that browser. Changes from other devices are refreshed when the page regains focus and every 15 seconds while it is open.

Live links are private by default — share from the artifact's own share menu when a page is ready for others to see.

## Working notes

- Each page is a single HTML file with inline CSS. The design system is: Inter Tight for display type, Inter for body and UI, a three-level depth ladder (`#DFDFDF` canvas → `#F1F1F1` surface → `#FFFFFF` card), `#00A651` green accent, 24px card radius and pill-shaped tags.
- Pages about *figures* carry a confidence tag (`Reported` / `Modeled` / `Needs validation`); pages about *scope* carry a scope tag (`In MVP` / `Post-MVP` / `Human only`). Both use the same tag component. Every item gets one — pulled directly from the epistemic caveats already present in `docs/Vyra-MARKET-RESEARCH.md` and `WHATSAPP-AGENT-BRIEF.md`. Keep that convention when adding new sections so the dashboard doesn't present estimates with more confidence than the source material does.
- Source content lives in `docs/` and the root-level briefs — this folder is a presentation layer on top of that content, not a replacement for it. Update the source doc first, then reflect the change here.
- The HTML files here are the last-published version. If you edit and republish via Claude, copy the updated file back into this folder to keep the repo in sync.
