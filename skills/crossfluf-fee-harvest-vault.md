---
name: crossfluf_fee_harvest_vault
version: 1.0.0
author: CrossFluf Protocol
description: >
  Passive yield management skill for the CrossFluf protocol. Automatically
  harvests accumulated Token-2022 transfer fees from all holder accounts back
  into the liquidity pool — increasing the fT share redemption value for all
  LP contributors — and provides vault deposit/withdraw actions so users can
  stake LP shares (fT) into the institutional vault (receiving vT) for
  compounded yield and access to agent controls.
chain: solana
tags: [yield, vault, liquidity, token-2022, fee-harvest, defi, solana, lp, bitget-wallet]
license: MIT
---

# CrossFluf Fee Harvest & Vault Skill

## Overview

This Skill handles everything that happens **outside** the flash loan cycle:

1. **Fee Harvest** — scans all CrossFluf memecoin Token-2022 ATAs for
   accumulated withheld transfer fees and sweeps them back into the
   liquidity pool reserve, automatically growing the T/fT redemption ratio
   so every fT holder earns passively — no manual claim needed.

2. **Vault Management** — deposits fT LP shares into the institutional vault
   to receive vT vault shares (unlocking agent controls and rebalancing bot
   yield), or burns vT to redeem fT plus accumulated yield.

3. **Pool Health** — real-time read-only snapshot of pool reserves, fT ratio,
   pending fees, vault TVL, and APY estimates, used by the `crossfluf_flashloan_arb`
   skill to size flash loans safely.

---

## Prerequisites

| Requirement | Detail |
|---|---|
| Bitget Wallet | Connected, Solana network selected |
| Solana RPC | `SOLANA_RPC` env var |
| fT balance | Required for `vault_deposit` action |
| vT balance | Required for `vault_withdraw` action |
| BGW credentials | Required for `pool_health` pricing data |
| Program IDs | `VAULT_PROGRAM_ID`, `FLUF_PROGRAM_ID` from `config/addresses.json` |

---

## Sub-Actions

### Sub-Action 1 — `harvest_fees`

Scans all Token-2022 ATAs for the CrossFluf memecoin mint, identifies
accounts with `withheld_amount > 0`, and sweeps them into the pool reserve
in batches of up to 20 accounts per transaction via
`vault::harvest_fees_to_pool`.

**Inputs:**

```json
{
  "batch_size": {
    "type": "number",
    "description": "Max token accounts swept per transaction. Hard limit: 20 (Solana tx size).",
    "default": 20,
    "maximum": 20,
    "required": false
  },
  "min_withheld_threshold": {
    "type": "number",
    "description": "Minimum total withheld T across all accounts before triggering harvest. Prevents dust transactions.",
    "default": 100,
    "required": false
  },
  "auto_mode": {
    "type": "boolean",
    "description": "If true, runs harvest on a repeating cron schedule. If false, executes once and returns.",
    "default": false,
    "required": false
  },
  "cron_interval_ms": {
    "type": "number",
    "description": "Harvest cron cadence in ms when auto_mode = true.",
    "default": 300000,
    "minimum": 60000,
    "required": false
  }
}
