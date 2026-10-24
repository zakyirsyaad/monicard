---
name: monad-blitz-score
description: Score a Monad Blitz hackathon project against the official 400-point rubric (Basic 100, Advance 200, Bonus 100), collect evidence, and list the cheapest next actions to gain points before the 4:45 PM lock. Use when the user asks to score, grade, review, or "hitung points" for their Monad Blitz project, or asks what to do next to win.
---

# Monad Blitz scorecard (400 points)

Source: the organizer slides shown at Monad Blitz Jogja Vol. 2 (24 Oct 2026). No peer voting. **Everything locks at 4:45 PM; whatever is submitted by then is what counts.** Pitch = **3 minutes, live demo, slides not required**, order of pitching = order of submission (submit early). The audience is the room of fellow builders: impress them, and focus on the live demo and the core innovation. Organizers like: novel mechanics and unique ideas, exploring the limits of Monad, solving problems in new ways. They say to worry less about perfect UI/UX, long feature lists, and polished slide decks.

## Rubric (every item, exactly as on the slides)

### BASIC: prize eligibility (100)
| ID | Item | Pts | Notes |
|---|---|---|---|
| B1 | Public GitHub repo | 25 | |
| B2 | Proper README | 25 | live public page and contract address included |
| B3 | Smart contracts deployed on Monad Testnet | 25 | |
| B4 | Project publicly hosted | 25 | any host, no custom domain needed |

**Say it out loud:** "You can pitch without these, but you can't win. Mention your repo link, contract address, live URL and deployment during the pitch."

### ADVANCE 1 of 2: does it work (100)
| ID | Item | Pts | Notes |
|---|---|---|---|
| A1 | All announced functions are working | 25 | only announce what works |
| A2 | Live transaction on chain during the demo | 25 | |
| A3 | Contract verified on the explorer | 25 | source published |
| A4 | Someone else can run it from the README | 25 | without your help |

### ADVANCE 2 of 2: did anyone see it, build in public (100)
| ID | Item | Pts | Notes |
|---|---|---|---|
| A5 | Posted on X or LinkedIn | 25 | tagging @monad, @monad_dev, @geeky_kartikey |
| A6 | Demo video posted on social | 25 | 30 seconds or more, product running |
| A7 | Creative ad video posted on social | 25 | |
| A8 | 5K+ views | 25 | collective across every post made during Blitz |

### BONUS: organizers and judges (100)
| ID | Item | Pts | Who scores |
|---|---|---|---|
| X1 | Contracts deployed on Monad Mainnet | 25 | organizers |
| X2 | Public page on a custom domain | 15 | organizers |
| X3 | Product-market fit | up to 20 | judges |
| X4 | Revenue potential and strategy | up to 20 | judges |
| X5 | Innovation and originality | up to 20 | judges |

Totals: Basic 100 + Advance 200 + Bonus 100 = **400**. Bonus items X3-X5 are judgment calls: score them honestly with the guide below, never claim 20/20 by default.

## How to run a scoring pass

1. **Automated evidence (cheap, read-only).** From the repo root run
   `bash .claude/skills/monad-blitz-score/scripts/check.sh [LIVE_URL] [DOMAIN]`.
   Defaults: LIVE_URL `https://monicard.xyz`, DOMAIN `monicard.xyz`. It checks B1-B4, A3, A4 (README side), X1, X2 and prints one status per item: **PASS/FAIL** (machine-proven), **CHECK** (machine says OK but a human must confirm; A3 is always CHECK because MonadScan needs an API key, so open every `https://testnet.monadscan.com/address/<addr>#code` page and look for verified source), **MANUAL** (needs proof from the user), **JUDGE** (judge-scored), **WARN** (note, e.g. unpushed commits). Count CHECK items as 0 points until confirmed.
2. **Manual evidence.** For every MANUAL item ask the user for the proof (URL, view count, screenshot) or verify it yourself: A1/A2 by running the demo flow, A4 by a clean-clone test (fresh directory, follow the README verbatim, `pnpm local`), A5-A8 by the posted URLs and their view counters. No proof = 0 points for that item.
3. **Judge items (X3-X5).** Score 0-20 with the guide below and write one sentence of evidence per item.
4. **Compute.** Award full points only when the item is fully satisfied; partial credit is a judgment call and must be explained. Sum per section and total.
5. **Report in this format** (Indonesian to the user, item names in English):
   - Header: current time, minutes until 4:45 PM, total score out of 400, and per-section subtotals.
   - Table: ID, item, points earned / max, status (full / partial / none), evidence.
   - **Next actions, sorted by points gained per minute of effort**, each with an owner and a concrete command or link. Put zero-dependency quick wins first (post on X, push the repo, record and post the video, fill README placeholders).
   - **Risks** that could silently lose points (e.g. README still has TODO addresses, repo private, contract unverified, announced feature not working, link dead, laptop asleep).
   - **Pitch checklist:** repo link, contract addresses (testnet and mainnet), live URL, deployment, all spoken within the 3 minutes.

## Scoring guide for the judge items (X3-X5)

- **X3 Product-market fit (0-20):** 0-5 vague "for gamers"; 6-12 a named customer and a real problem but no evidence; 13-17 named customer, problem, why now, and a demo that solves it; 18-20 all of that plus evidence of real usage today (cards minted, tx sent by people in the room, sponsor interest). Evidence to collect: count `CardMinted` events and total tx during the event.
- **X4 Revenue potential and strategy (0-20):** 0-5 "we will add ads/NFT"; 6-12 one stream described; 13-17 multiple streams with prices, and at least one is live onchain; 18-20 live streams plus a clear wedge-to-scale strategy and unit economics (cost per user vs revenue). Evidence: paid pack price into the treasury, royalty, event mode, stake rake, gas per action.
- **X5 Innovation and originality (0-20):** 0-5 a clone; 6-12 known idea with a twist; 13-17 a novel mechanic that is meaningfully onchain; 18-20 novel and it demonstrably exercises what is unique about Monad (parallel execution, ~300 ms blocks, per-slot isolation) with measured numbers.

## Project-specific context (Monicard)
- Contract addresses live in `deployments/testnet.json` and `deployments/mainnet.json`; read them, never hard-code.
- Demo flow: Card Battle vs the AI Agent (main mode: draw, place, attack, 2 KOs win), PvP over QR, `/arena` projector view with MonadScan links, swarm of Tap Blitz bots (`bash server/scripts/admin.sh swarm 10 4`). Tap Blitz is the second mode and the fallback. Authoritative spec: `docs/BATTLE-SPEC.md`, status: `docs/ADDENDUM-2026-10-24.md` N17.
- Pitch script: `marketing/pitch.md`. Ad video page: `marketing/ad/index.html` (`?rec` to record). Spec and decisions: `docs/ADDENDUM-2026-10-24.md`.
- Quick-win order that usually applies this late in the day: push the repo public, fill README placeholders, post on X tagging the three handles, record and post the demo and ad videos, verify contracts, deploy mainnet, point the custom domain, then rehearse the 3-minute pitch.

## Rules
- Be honest and conservative: do not inflate scores, and flag any item whose proof is missing.
- The check script is read-only. Never send transactions, change DNS, post to social media, or push to GitHub from this skill without the user's explicit instruction.
- If the user asks a question about the rubric that the slides do not answer (for example how views are counted), say it is not specified and suggest asking an organizer.
