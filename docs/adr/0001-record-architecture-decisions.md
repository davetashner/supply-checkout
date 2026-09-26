# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-09-25

## Context

The app is moving from a single HTML file with no server to a multi-tenant product with billing, several AWS regions and mobile apps. Many of those choices are hard to undo, and the reasons behind them will be forgotten unless written down.

## Decision

Record every significant architecture decision as a numbered Markdown file in `docs/adr/`. A decision is significant if it is hard to reverse, costs money, affects security or privacy, or changes how customers use the product.

## Consequences

- New contributors, and future us, can see why the system looks the way it does.
- Each ADR that needs work has matching beads in the backlog. Beads link back to the ADR number in their description.
