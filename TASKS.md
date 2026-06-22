# Plan: clean up README.md (#3)

Goal: "deslop" README.md — strip AI-tell flourishes (em-dash pile-ups, marketing
adjectives, self-congratulatory asides, redundant restatements) while keeping all
factual content, commands, and the config reference accurate. Verify each edit
against the actual source/CLI so nothing claimed stops being true.

- [x] Tighten the intro (title, tagline, one-paragraph pitch, quickstart block): cut marketing phrasing and redundancy, keep the four example commands accurate
- [x] Deslop the "Why" section: collapse the two paragraphs into plain prose, drop the "two halves compose" flourish or state it plainly
- [x] Clean the "Install" section: keep the steps, trim the "live symlink"/"no rebuild" embellishment and prerequisite phrasing
- [x] Clean the "Configure" intro + code example comments: remove slop in inline comments, keep config keys correct
- [x] Deslop the config reference table: make each "What it controls" cell terse and factual, verify field names/defaults against the source
- [x] Clean the "Issue tracking (opt-in)" subsection: cut hedging/flourish, keep the opt-in semantics and state-tracking facts accurate
- [x] Deslop the "Commands" sections (`setup`, `implement-issues`): trim restated explanations, keep flags and behavior correct
- [x] Clean "The Ralph loop" section: tighten the numbered steps and stop/complete/blocked descriptions, verify against ADR-0001
- [x] Deslop the "listen" section: trim narrative, keep the TUI mockup only if it earns its place, verify label-flow and defaults
- [x] Clean the "kill" and "Develop" sections: terse final pass, verify commands match package scripts
- [ ] Final read-through for consistency (heading style, voice, residual em-dashes) and confirm no factual claim was lost
