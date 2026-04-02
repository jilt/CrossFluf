---
name: crossfluf_flashloan_arb
version: 1.0.0
author: CrossFluf Protocol
description: >
  Autonomous flash loan arbitrage agent for the CrossFluff memecoin liquidity
  pool on Solana. Scans cross-DEX price spreads via Bitget Wallet Skill API,
  executes atomic borrow → swap → repay cycles using the fluf Anchor program,
  and routes 0.5 % of every repayment to LP contributors via Token-2022
  TransferFeeConfig — all without exposing private keys.
chain: solana
tags: [flashloan, arbitrage, defi, solana, token-2022, amm, memecoin]
license: MIT
---

# CrossFluf Flash Loan Arbitrage Skill

## Overview

This Skill lets any Bitget Wallet agent detect and execute flash loan arbitrage
opportunities across Solana DEXs (Raydium, Orca, Jupiter) using the CrossFluf
liquidity pool as the capital source. Every trade is:

- **Atomic** — borrow, swap, and repay happen in a single Solana transaction.
  If repayment fails, the entire transaction reverts.
- **Gasless-eligible** — uses BGW `no_gas` feature for orders above $5 USD,
  deducting gas from the traded token rather than requiring SOL.
- **Self-sustaining** — 50 bps of every repayment is automatically withheld by
  the Token-2022 mint and flows back to liquidity providers.

---

## Prerequisites

| Requirement | Detail |
|---|---|
| Bitget Wallet | Connected, Solana network selected |
| vT balance | Must hold at least 1 vT (vault share) to activate agent controls |
| BGW Partner Code | Set `BGW_PARTNER_CODE` + `BGW_APP_ID` + `BGW_API_SECRET` in env |
| Solana RPC | `SOLANA_RPC` env var pointing to a reliable endpoint |
| Program IDs | `FLUF_PROGRAM_ID` from `config/addresses.json` |

---

## Skill Inputs

```json
{
  "flash_amount": {
    "type": "string",
    "description": "Amount of T tokens to borrow per cycle (e.g. '100000'). No decimals — program applies 6-decimal shift.",
    "default": "100000",
    "required": true
  },
  "min_spread_bps": {
    "type": "number",
    "description": "Minimum spread in basis points to trigger execution. Must be > 80 to profit after 50 bps Token-2022 fee and 30 bps slippage.",
    "default": 80,
    "minimum": 10,
    "required": true
  },
  "poll_interval_ms": {
    "type": "number",
    "description": "How often to poll BGW for price data, in milliseconds.",
    "default": 2500,
    "minimum": 1000,
    "required": false
  },
  "no_gas": {
    "type": "boolean",
    "description": "Enable BGW no_gas feature to pay transaction fees in the traded token instead of SOL.",
    "default": true,
    "required": false
  },
  "from_chain": {
    "type": "string",
    "description": "Source chain for the swap leg. Use 'sol' for Solana-only arb.",
    "default": "sol",
    "enum": ["sol", "bnb", "eth", "arb"],
    "required": false
  },
  "to_chain": {
    "type": "string",
    "description": "Destination chain for the swap leg. Cross-chain arb supported up to $200k per order via BGW liqBridge.",
    "default": "sol",
    "enum": ["sol", "bnb", "eth", "arb"],
    "required": false
  }
}
