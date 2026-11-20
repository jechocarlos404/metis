---
name: metis-next-work
description: List the features in metis that are ready to start now (pending, with every dependency done), for the current product or across the portfolio, using the metis MCP server's ready_features and feature_why tools. Use when the user asks "what should I work on next", "what is ready", "what can I pick up in this repo", or wants a short list of unblocked work with the reason each feature exists.
---

# What is ready to work on

Metis tracks each product's features, their status, and the dependency edges
between them. A feature is ready when it is `pending` and everything it
depends on is `done`. Read-only: this skill never changes a status.

## Steps

1. **Pick the product.** If the session's metis brief (from the SessionStart
   hook) named this repo's product, use its slug. Otherwise call `products`
   and match the repo by exact slug or name; if nothing matches exactly, ask
   the user which product, or use the whole portfolio. Never guess from a
   near name.

2. **Call `ready_features`**, with `product` set to the slug, or with no
   arguments for the whole portfolio.

3. **Explain the top few.** For up to three ready features, call
   `feature_why` with the feature id to get the capabilities it realizes and
   the goals above them. That is the "why" for each.

4. **Report** a short list: feature name, product, the goal it serves, and one
   line on where to start in this repo if the capability names make that
   obvious. If nothing is ready, say so: that is an answer.

## Rules

- Do not mark anything started or done. Status changes happen on the metis
  desktop, by a human.
- If the metis tools are not available, say so and point at the plugin README.
