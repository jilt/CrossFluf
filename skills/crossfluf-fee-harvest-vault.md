
***

## `skills/crossfluf-fee-harvest-vault.md`

```markdown
---
name: crossfluf_fee_harvest_vault
version: 1.0.0
author: CrossFluf Protocol
description: >
  Passive yield management skill for the CrossFluf protocol. Automatically
  harvests accumulated Token-2022 transfer fees from all holder accounts back
  into the liquidity pool (increasing fT share value), and provides vault
  deposit/withdraw actions so users can stake LP shares (fT) into the
  institutional vault (receiving vT) for compounded yield and access to
  agent controls.
chain: solana
tags: [yield, vault, liquidity, token-2022, fee-harvest, defi, solana, lp]
license: MIT
---

# CrossFluf Fee Harvest & Vault Skill

## Overview

This Skill handles the **passive income layer** of the CrossFluf protocol —
the two actions that happen outside of the flash loan cycle itself:

1. **Fee Harvest** — sweeps Token-2022 withheld transfer fees from all holder
   accounts back into the liquidity pool reserve, automatically increasing the
   T/fT redemption ratio for all LP shareholders.

2. **Vault Management** — deposits fT LP shares into the institutional vault
   (receiving vT), withdraws vT back to fT, and reports current vault APY
   composed of flash loan fee yield + rebalancing bot yield.

Users never need to manually claim yield — the harvester runs on a cron cadence
and distributes earnings by growing the pool reserve that backs all fT shares.

---

## Prerequisites

| Requirement | Detail |
|---|---|
| Bitget Wallet | Connected, Solana network selected |
| Solana RPC | `SOLANA_RPC` env var |
| fT balance | Required for vault deposit action |
| vT balance | Required for vault withdraw action |
| BGW Partner Code | Required for `crossfluff_pool_health` pricing data |
| Program IDs | `VAULT_PROGRAM_ID`, `FLUF_PROGRAM_ID` from `config/addresses.json` |

---

## Sub-Skills

This skill exposes three composable actions:

### Action 1 — `harvest_fees`

Scans all Token-2022 ATAs for the memecoin mint, identifies accounts with
withheld fees > 0, and sweeps them to the pool reserve in batches of 20
accounts per transaction.

**Inputs:**
```json
{
  "batch_size": {
    "type": "number",
    "description": "Max token accounts to sweep per transaction. Max 20 (Solana tx size limit).",
    "default": 20,
    "maximum": 20,
    "required": false
  },
  "min_withheld_threshold": {
    "type": "number",
    "description": "Minimum total withheld T tokens before triggering harvest (avoids dust txs).",
    "default": 100,
    "required": false
  },
  "auto_mode": {
    "type": "boolean",
    "description": "If true, agent runs harvest on a cron schedule (every 5 minutes). If false, one-shot.",
    "default": false,
    "required": false
  },
  "cron_interval_ms": {
    "type": "number",
    "description": "Harvest cron interval in ms when auto_mode = true.",
    "default": 300000,
    "minimum": 60000,
    "required": false
  }
}
