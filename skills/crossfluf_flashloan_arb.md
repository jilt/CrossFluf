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
---
name: crossfluf_flashloan_arb
version: 1.0.0
author: CrossFluf Protocol
description: >
  Autonomous flash loan arbitrage agent for the CrossFluf memecoin liquidity
  pool on Solana. Scans cross-DEX price spreads via Bitget Wallet Skill API,
  then executes atomic borrow → swap → repay cycles using the CrossFluf
  on-chain program. 0.5% of every repayment is automatically routed to LP
  contributors via Token-2022 TransferFeeConfig. Private keys never leave
  Bitget Wallet.
chain: solana
tags: [flashloan, arbitrage, defi, solana, token-2022, amm, memecoin, bitget-wallet]
license: MIT
---

# CrossFluf Flash Loan Arbitrage Skill

## Overview

This Skill gives any Bitget Wallet agent the ability to:

1. **Scan** for cross-DEX price spreads on the CrossFluf memecoin using
   Bitget Wallet's `getSwapPrice` API — read-only, no transaction created.
2. **Execute** an atomic flash loan cycle when a profitable spread is found:
   borrow T tokens from the CrossFluf liquidity pool, swap on the cheaper
   DEX, sell on the more expensive DEX, repay the pool — all in a single
   Solana transaction that reverts completely if repayment fails.

The two steps are exposed as composable sub-actions so agent runtimes
(OpenClaw, Manus, Claude) can call the scanner independently for price
monitoring without committing to a trade.

---

## Prerequisites

| Requirement | Detail |
|---|---|
| Bitget Wallet | Connected, Solana network selected |
| vT vault shares | Must hold ≥ 1 vT to activate agent controls on the web dashboard |
| BGW credentials | `BGW_PARTNER_CODE`, `BGW_APP_ID`, `BGW_API_SECRET` in env |
| Solana RPC | `SOLANA_RPC` env var |
| Program IDs | `FLUF_PROGRAM_ID` from `config/addresses.json` |

---

## Sub-Actions

### Sub-Action 1 — `scan`

Read-only price scan. Calls BGW `getSwapPrice` to detect spread between
two DEX routes for the CrossFluf memecoin. Safe to call at any frequency —
no transaction is ever submitted.

**Inputs:**

```json
{
  "wallet_address": {
    "type": "string",
    "description": "Caller's Solana wallet pubkey (passed to BGW fromAddress).",
    "required": true
  },
  "flash_amount": {
    "type": "string",
    "description": "Notional amount in T tokens used for price impact calculation.",
    "default": "100000",
    "required": false
  },
  "min_spread_bps": {
    "type": "number",
    "description": "Minimum gross spread in bps to return a positive opportunity. Must exceed 80 to profit after 50 bps Token-2022 fee and ~30 bps slippage.",
    "default": 80,
    "required": false
  },
  "from_chain": {
    "type": "string",
    "description": "Source chain for the buy leg.",
    "default": "sol",
    "enum": ["sol", "bnb", "eth", "arb"],
    "required": false
  },
  "to_chain": {
    "type": "string",
    "description": "Destination chain for the sell leg. Cross-chain arb supported up to $200k per order via BGW liqBridge.",
    "default": "sol",
    "enum": ["sol", "bnb", "eth", "arb"],
    "required": false
  }
}
