---
name: atum-discovery
description: Find current Store listings and Apps.
version: 1.0.0
author: Atum contributors
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [atum, store, apps, discovery]
    category: productivity
---

# Atum Discovery Skill

Find skills, hireable agents, pets and Apps from current public listings.
This skill recommends capabilities; it does not acquire them or grant access.

## When to Use

Use when the person needs an Atum capability, a skill, a specialist agent or an
app. Keep using normal tools when they already solve the task.

## Prerequisites

An Atum host exposing `atum_store` and/or `atum_apps`. Store discovery is
available on the Matrix-backed Mac app and cloud execution path, not the
retired legacy commerce path. No additional account credentials are needed.

## How to Run

Use the native tools below. Do not substitute web searches for Atum's catalog
or construct catalog HTTP calls with owner credentials.

## Quick Reference

| Need | Tool call |
|---|---|
| Find a skill or agent | `atum_store(operation="search", query="…")` |
| Inspect a candidate | `atum_store(operation="inspect", item_id="…")` |
| Find an App | `atum_apps(operation="list", query="…")` |
| Open an App | `atum_apps(operation="open", app_id="…")` |

## Procedure

1. Search the live Store with `atum_store(operation="search", query="…")`.
   Optionally narrow `kind` to `skill`, `agent`, or `pet`. Search Apps with
   `atum_apps(operation="list", query="…")`; Apps are a separate catalog.
2. Inspect a candidate using `atum_store(operation="inspect", item_id="…")`
   with its exact returned identifier. Compare its description and requirements
   to the person's need. A listing is not evidence that a skill is installed,
   an agent is online, or device access is authorized.
3. Recommend a small relevant set, citing returned `listingLink` values in
   Markdown. Include the current offer, billing interval, renewal terms and
   ownership when relevant. Prices are micro-Protons: divide by 1,000,000 for
   Protons. Do not invent a free offer when an offer is absent, or claim a
   currently available capability from stale conversation text.
4. The person opens a listing and uses the existing consent/checkout flow to
   buy, hire, install or connect. Discovery never approves charges or grants
   credentials. `atum_apps(operation="open", app_id="…")` can navigate an
   available app on Mac; in cloud it returns a destination, not a UI receipt.

## Pitfalls

Empty results mean no matches in this catalog. An error means availability is
unknown: explain the distinction and do not substitute made-up listings.
Filters are applied locally to public listing metadata. Never send private app
content or Google-derived material to a catalog search service. Read skills
through Hermes's normal skill loader rather than copying catalogs into SOUL.

An operator's explicit toolset selection remains authoritative; do not bypass a
disabled tool. A cloud destination is not confirmation that a Mac UI opened.

## Verification

Use exact current identifiers and `listingLink` values from tool results.
Confirm that requirements, ownership, current price and renewal terms match the
selected listing. Acquisition, credential grants and charges require the
existing owner's consent workflow; never claim any of those from discovery.
