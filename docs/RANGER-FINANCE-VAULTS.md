# Ranger Finance (Voltr) Vault System: Technical Reference

## Table of Contents
1. [Overview](#1-overview)
2. [Vault Architecture](#2-vault-architecture)
3. [Rebalancing Mechanics](#3-rebalancing-mechanics)
4. [Strategy System](#4-strategy-system)
5. [Fee System & Accounting](#5-fee-system--accounting)
6. [Deposit/Withdrawal Mechanics](#6-depositwithdrawal-mechanics)
7. [Integration Points](#7-integration-points)
8. [SDK & API](#8-sdk--api)
9. [Open Source Code](#9-open-source-code)
10. [How to Build a Similar Vault](#10-how-to-build-a-similar-vault)

---

## 1. OVERVIEW

Ranger Earn (acquired from **Voltr** protocol, November 2025) is a permissionless framework for structured yield strategies on Solana. Non-custodial, fully on-chain.

### Key Properties
- Smart contracts in **Rust** on Solana
- Audited by **Sec3 X-RAY**, **FYEO**, **Certora** (all passed)
- TypeScript SDK: `@voltr/vault-sdk`
- REST API: `https://api.voltr.xyz` (public, no key required)
- Upgrade authority via multisig: `7p4d84NuXbuDhaAq9H3Yp3vpBSDLQWousp1a4jBVoBgU`

---

## 2. VAULT ARCHITECTURE

### 2.1 Two-Program Model

**Vault Program (`voltr-vault`)** - User-facing: deposits, withdrawals, LP minting/burning, share accounting. Initiates CPI to adaptors.

**Adaptor Programs** - Middleware bridging vaults and external DeFi protocols. CPI translation layer with three core instructions: `initialize`, `deposit`, `withdraw`. Each adaptor returns position values as `u64`.

### 2.2 Deployed Program Addresses (Mainnet)

| Program | Address |
|---------|---------|
| Vault | `vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8` |
| Lending Adaptor | `aVoLTRCRt3NnnchvLYH6rMYehJHwM5m45RmLBZq7PGz` |
| Drift Adaptor | `EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP` |
| Raydium Adaptor | `A5a3Xo2JaKbXNShSHHP4Fe1LxcxNuCZs97gy3FJMSzkM` |
| Kamino Adaptor | `to6Eti9CsC5FGkAtqiPphvKD2hiQiLsS8zWiDBqBPKR` |
| Jupiter Adaptor | `EW35URAx3LiM13fFK3QxAXfGemHso9HWPixrv7YDY4AM` |
| Trustful Adaptor | `3pnpK9nrs1R65eMV1wqCXkDkhSgN18xb1G5pgYPwoZjJ` |

### 2.3 PDA Layout

| PDA | Seeds |
|-----|-------|
| `protocol` | `["protocol"]` |
| `vault_asset_idle_auth` | `["vault_asset_idle_auth", vault_key]` |
| `vault_lp_mint_auth` | `["vault_lp_mint_auth", vault_key]` |
| `vault_lp_mint` | via `findVaultLpMint()` |
| `vault_strategy_auth` | via `findVaultStrategyAuth()` |
| `strategy` | `[SEEDS.STRATEGY, counterPartyTa.toBuffer()]` |
| `request_withdraw_vault_receipt` | `["request_withdraw_vault_receipt", vault_key, user_key]` |

### 2.4 Vault Account Structure

```
Vault Account {
    // Identity
    name: [u8; 32]
    description: [u8; 64]

    // Asset Configuration
    mint: Pubkey              // Asset token mint (e.g., USDC)
    idleAuth: Pubkey          // PDA controlling idle reserves
    totalValue: u64           // Total vault assets (idle + deployed)

    // Operational Config
    maxCap: u64               // Maximum deposit capacity
    startAtTs: i64            // Activation timestamp (0 = immediate)
    lockedProfitDegradationDuration: u64  // Seconds for profit unlock (e.g., 86400 = 24h)
    withdrawalWaitingPeriod: u64          // Seconds before withdrawal execution

    // Fee Structure (basis points, 1 bp = 0.01%)
    managerPerformanceFee: u16   // e.g., 1000 = 10%
    adminPerformanceFee: u16     // e.g., 500 = 5%
    managerManagementFee: u16    // e.g., 50 = 0.5%
    adminManagementFee: u16      // e.g., 25 = 0.25%
    redemptionFee: u16           // e.g., 10 = 0.1%
    issuanceFee: u16             // e.g., 10 = 0.1%

    // Fee Accumulation
    accumulatedLpAdminFees: u64
    accumulatedLpManagerFees: u64
    accumulatedLpProtocolFees: u64

    // Performance Tracking
    highestAssetPerLpDecimalBits: u64   // High water mark
    lastUpdatedTs: i64

    // Authority
    admin: Pubkey             // Structural control
    manager: Pubkey           // Fund allocation control
}
```

### 2.5 Data Flow

```
1. User deposits  -> Vault accumulates idle assets, mints LP tokens
2. Manager        -> Vault invokes adaptor via CPI
3. Adaptor routes -> Target protocol receives instructions via CPI
4. Protocol       -> Assets deployed, receipt tokens issued
5. Reporting      -> Adaptor returns position value (u64) to vault
6. Withdrawal     -> Reverse: adaptor withdraws, vault burns LP, returns assets
```

---

## 3. REBALANCING MECHANICS

### 3.1 Manager-Driven Allocation

Vault managers (human or bot) distribute capital across multiple strategies. Funds exist in two states:
- **Idle**: In vault's idle account, earning nothing
- **Deployed**: Allocated to strategies via adaptors, earning yield

Manager moves capital using `depositStrategy` and `withdrawStrategy` instructions.

### 3.2 Rebalance Bot Architecture

Official template: `github.com/voltrxyz/rebalance-bot-template`

Four concurrent loops:

**1. Rebalance Loop (every 30 min):**
- Compute equal-weight target allocation across strategies
- Calculate locked amounts (illiquid funds)
- Distribute remaining funds equally
- Trigger on new deposits via ATA subscription
- Set target idle balance to zero

**2. Refresh Loop (every 10 min):**
- Update on-chain receipt values
- Keep position accounting current

**3. Harvest Fee Loop (every 30 min):**
- Collect protocol, admin, and manager fees

**4. Claim Reward Loops:**
- Gather farm rewards from Kamino/Drift strategies
- Convert reward tokens to base asset via Jupiter swaps

### 3.3 rgUSD Dynamic Lending Optimization (Most Advanced)

- Simulates price impact **every 30 seconds**
- Rebalances when simulated returns exceed thresholds
- Natural rebalancing cycle **every 10 minutes** as fallback
- Routes across Jupiter Lend, Drift, and Kamino
- Achieved **8.56% 7-day APY** vs 3.51%-5.52% on single-platform

### 3.4 Allocation Strategy Patterns

**APY Maximizer:**
- Real-time rate monitoring across protocols
- Dynamic reallocation with minimum time locks
- Prevents excessive trading

**Risk-Weighted:**
- Protocol risk scoring: TVL, audit status, exploits, maturity
- Allocation caps and diversification requirements

**Yield Optimization:**
- Real-time rate monitoring
- Price impact simulation
- Dynamic routing

### 3.5 Yield Calculation

True APY includes:
- Base lending rates from each protocol
- Reward token values (claimed and swapped)
- Gas costs for rebalancing (~$0.01 SOL per rebalance with 4h cycles)
- Slippage costs on swaps

### 3.6 Safety Mechanisms

- `lockedProfitDegradationDuration`: Anti-sandwich attack (typically 24h)
- `withdrawalWaitingPeriod`: Delay before withdrawal execution
- Minimum time locks between reallocations
- Rebalancing only when score delta > threshold (e.g., 50 bps APY improvement)

---

## 4. STRATEGY SYSTEM

### 4.1 Adaptor-Strategy Architecture

**Adaptors** = on-chain programs for a protocol category (e.g., Kamino adaptor)
**Strategies** = specific deployment targets within an adaptor (e.g., USDC on Kamino market X)

A vault can have multiple strategies across multiple adaptors.

### 4.2 Three Required Adaptor Instructions

**`initialize`**: Creates protocol-specific accounts when strategy launches.

**`deposit`**: Executes after vault transfers tokens to `vault_strategy_asset_ata`.
- Returns `Result<u64>` (current position value -- critical for P&L)

**`withdraw`**: Converts underlying amounts to protocol units, executes withdrawal.
- Returns `Result<u64>` (remaining position value)
- Vault sweeps tokens from `vault_strategy_asset_ata` back to idle

### 4.3 Position Value Calculation

**Receipt-token based:**
```
position_value = (receipt_token_balance * total_liquidity) / total_receipt_supply
```

**Shares-based:**
```
position_value = (user_shares * total_AUM) / total_shares
```

Both must use `u128` intermediate calculations to prevent overflow.

### 4.4 Strategy Setup (TypeScript)

```typescript
// Step 1: Add adaptor to vault (admin, one-time per adaptor type)
const addAdaptorIx = await client.createAddAdaptorIx({
    vault,
    admin: adminKp.publicKey,
    payer: adminKp.publicKey,
    adaptorProgram: adaptorProgramId,
});

// Step 2: Initialize strategy (per deployment target)
const initStrategyIx = await client.createInitializeStrategyIx(
    { instructionDiscriminator: Buffer.from([/* 8-byte discriminator */]) },
    {
        payer: adminKp.publicKey,
        manager: managerKp.publicKey,
        vault,
        strategy,
        adaptorProgram,
        remainingAccounts: [/* protocol-specific accounts */],
    }
);
```

---

## 5. FEE SYSTEM & ACCOUNTING

### 5.1 Fee Types

| Fee | Description | Typical Range |
|-----|-------------|---------------|
| Management | Annual fee on AUM | 0.25%-2% |
| Performance | Fee on profits above HWM | 5%-20% |
| Issuance | Deducted from LP on deposit | 0-0.1% |
| Redemption | Deducted from assets on withdrawal | 0-0.1% |

### 5.2 High Water Mark (HWM)

Performance fees only apply above vault's peak asset-per-share ratio:
```
eligible_profit = max(0, (current_ratio - hwm_ratio) * total_shares)
fee_amount = (eligible_profit * fee_rate_bps) / 10000
```

### 5.3 Anti-Sandwich Profit Locking

New profits locked and decay over `lockedProfitDegradationDuration`:
```
locked_profit = ((duration - elapsed) / duration) * previous_locked_profit
```

---

## 6. DEPOSIT/WITHDRAWAL MECHANICS

### 6.1 Deposit

CPI discriminator: `[126, 224, 21, 255, 228, 53, 117, 33]`

13 required accounts: `user_transfer_authority` (signer), `protocol`, `vault`, `vault_asset_mint`, `vault_lp_mint`, `vault_asset_idle_auth`, `vault_lp_mint_auth`, `user_asset_ata`, `vault_asset_idle_ata`, `user_lp_ata`, `asset_token_program`, `lp_token_program`, `system_program`

LP value: `asset_per_lp = total_vault_assets / total_lp_supply`

### 6.2 Two-Step Withdrawal

**Step 1 - Request**: LP tokens transferred to escrow receipt PDA.
- Receipt PDA: `["request_withdraw_vault_receipt", vault_key, user_key]`
- One active request per user per vault

**Step 2 - Withdraw**: Burns escrowed LP, returns assets after waiting period.
- Fails with `WithdrawalNotYetAvailable` if period hasn't elapsed

### 6.3 Instant Withdrawal (zero-wait vaults only)

Single atomic transaction: burns LP, returns assets.
- Fails with `InstantWithdrawNotAllowed` if `withdrawal_waiting_period != 0`

---

## 7. INTEGRATION POINTS

### 7.1 Available Adaptors

| Adaptor | Protocols | Scripts Repo |
|---------|-----------|-------------|
| Generic Lending | Save Lending | `voltrxyz/lend-scripts` |
| Kamino | Kamino Vaults, Lending | `voltrxyz/kamino-scripts` |
| Drift | Drift Vaults, Lend, Perps | `voltrxyz/drift-scripts` |
| Raydium | Raydium CLMM Pools | `voltrxyz/client-raydium-clmm-scripts` |
| Jupiter | SPL Swaps, Jupiter Lend | `voltrxyz/spot-scripts` |
| Trustful | Centralized Exchanges | `voltrxyz/trustful-scripts` |

### 7.2 Protocol-Specific Capabilities

- **Drift**: Lending, vaults, perpetual futures (delta-neutral strategies)
- **Kamino**: Multi-reserve vaults, lending, reward claiming
- **Jupiter**: Spot swaps (reward conversion) and lending
- **Raydium**: Concentrated liquidity (CLMM) positions

### 7.3 Creating Custom Adaptors (Permissionless)

Required:
- Three instructions: `initialize`, `deposit`, `withdraw`
- Position value reporting via `u64` return
- PDA/ATA verification
- Checked math (`checked_mul`, `checked_div`) with `u128` intermediates
- Reload accounts after CPI calls
- Handle zero-supply edge cases

---

## 8. SDK & API

### 8.1 TypeScript SDK

```bash
npm install @voltr/vault-sdk
```

```typescript
import { VoltrClient } from "@voltr/vault-sdk";
const client = new VoltrClient(connection);
```

**Key Methods:**

| Category | Methods |
|----------|---------|
| Vault Init | `createInitializeVaultIx()` |
| Deposits | `createDepositVaultIx()` |
| Withdrawals | `createRequestWithdrawVaultIx()`, `createWithdrawVaultIx()` |
| Strategy | `createAddAdaptorIx()`, `createInitializeStrategyIx()` |
| Allocation | `createDepositStrategyIx()`, `createWithdrawStrategyIx()` |
| Fees | `createHarvestFeeIx()` |
| Queries | `getVault()`, `getCurrentAssetPerLpForVault()`, `getPositionAndTotalValuesForVault()` |
| PDA | `findVaultLpMint()`, `findVaultAssetIdleAuth()`, `findVaultAddresses()` |

SDK docs: https://voltrxyz.github.io/vault-sdk/

### 8.2 REST API

Base: `https://api.voltr.xyz` | Swagger: `https://api.voltr.xyz/docs`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/vaults` | All vaults with TVL, APY |
| GET | `/vault/{pubkey}` | Detailed vault info |
| GET | `/vault/{pubkey}/share-price?ts=` | Historical share price |
| POST | `/vault/{pubkey}/deposit` | Build deposit transaction |
| POST | `/vault/{pubkey}/request-withdrawal` | Build request-withdraw tx |
| POST | `/vault/{pubkey}/withdraw` | Build withdraw tx |

POST endpoints return unsigned, serialized versioned transactions as base58.

### 8.3 Rust CPI Integration

```bash
# In Cargo.toml
voltr-vault-cpi = { git = "https://github.com/voltrxyz/vault-cpi" }
```

---

## 9. OPEN SOURCE CODE

### Voltr Organization (`github.com/voltrxyz`)

| Repo | Purpose | Language |
|------|---------|----------|
| `vault-sdk` | TypeScript SDK | TS |
| `vault-cpi` | Rust CPI integration | Rust |
| `rebalance-bot-template` | Rebalancing automation | TS |
| `basic-ui` | Next.js 15 vault frontend | TS |
| `lend-scripts` | Generic lending scripts | TS |
| `kamino-scripts` | Kamino integration | TS |
| `drift-scripts` | Drift integration | TS |
| `spot-scripts` | Jupiter swap/lend | TS |
| `client-raydium-clmm-scripts` | Raydium CLMM | TS |
| `trustful-scripts` | CEX bridge | TS |

### Ranger Finance (`github.com/ranger-finance`)

Notable: `sor-ts-demo` (SOR SDK), `ranger-agent-kit` (AI agent lib), forks of Drift, Mango, Raydium, Phoenix

---

## 10. HOW TO BUILD A SIMILAR VAULT

### 10.1 Vault Creation

```typescript
import { VoltrClient, VaultConfig, VaultParams } from "@voltr/vault-sdk";
import { BN } from "@coral-xyz/anchor";

const vaultConfig: VaultConfig = {
    maxCap: new BN("18446744073709551615"),  // u64 max = uncapped
    startAtTs: new BN(0),                    // immediate
    lockedProfitDegradationDuration: new BN(86400),  // 24h anti-sandwich
    managerPerformanceFee: 1000,             // 10%
    adminPerformanceFee: 500,                // 5%
    managerManagementFee: 50,                // 0.5%
    adminManagementFee: 25,                  // 0.25%
    redemptionFee: 10,                       // 0.1%
    issuanceFee: 10,                         // 0.1%
    withdrawalWaitingPeriod: new BN(0),      // instant withdrawals
};

const vaultKp = Keypair.generate();
const createIx = await client.createInitializeVaultIx(
    { config: vaultConfig, name: "My Vault", description: "Multi-protocol yield" },
    {
        vault: vaultKp.publicKey,
        vaultAssetMint: USDC_MINT,
        admin: adminKp.publicKey,
        manager: managerKp.publicKey,
        payer: adminKp.publicKey,
    }
);
```

### 10.2 Multi-Protocol Architecture

```
                    ┌──────────────┐
                    │   Vault      │
                    │ (idle funds) │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────▼────┐  ┌───▼────┐  ┌───▼────┐
         │ Adaptor │  │Adaptor │  │Adaptor │
         │ (Drift) │  │(Kamino)│  │(Jupiter│
         └────┬────┘  └───┬────┘  └───┬────┘
              │            │            │
         ┌────▼────┐  ┌───▼────┐  ┌───▼────┐
         │  Drift  │  │ Kamino │  │Jupiter │
         │Protocol │  │Protocol│  │ Lend   │
         └─────────┘  └────────┘  └────────┘
```

### 10.3 Rebalancing Logic

```typescript
// Equal-weight rebalancing (from bot template)
async function rebalance(vault, strategies) {
    const totalValue = await getTotalVaultValue(vault);
    const targetPerStrategy = totalValue / strategies.length;

    for (const strategy of strategies) {
        const currentValue = await getStrategyPositionValue(strategy);
        const lockedAmount = getLockedAmount(strategy);

        if (currentValue > targetPerStrategy) {
            await withdrawFromStrategy(strategy, currentValue - targetPerStrategy);
        } else if (currentValue < targetPerStrategy) {
            await depositToStrategy(strategy, targetPerStrategy - currentValue);
        }
    }
}

// Run on interval + trigger on new deposits
setInterval(rebalance, 30 * 60 * 1000);  // 30 min
subscribeToDeposits(vault, () => rebalance(vault, strategies));
```

### 10.4 Advanced Scoring (rgUSD-style)

```rust
// Opportunity scoring
Score = (Expected_Return * Liquidity_Factor * Safety_Factor)
      - (Gas_Cost + Slippage + Risk_Penalty)

// Safety factors
MarginFi/Kamino: 0.95
Drift: 0.90
Unvetted: 0.50

// Trigger threshold
trigger_rebalance = score_delta > 50 bps APY improvement
```

### 10.5 Risk Assessment Framework

```rust
#[account]
pub struct SignalAggregator {
    pub authority: Pubkey,
    pub last_update: i64,
    pub lending_signals: Vec<LendingSignal>,   // utilization, APY, collateral factors
    pub funding_signals: Vec<FundingSignal>,    // hourly rates, open interest
    pub pool_signals: Vec<PoolSignal>,          // TVL, volume, fee APY, IL risk
}
```

**Circuit Breakers:**
- Portfolio drawdown > 15% -> halt
- Signal staleness > 5 min -> halt
- Protocol exposure limits violated -> halt

### 10.6 Key Design Patterns

1. **Admin vs Manager separation**: Admin = structural, Manager = fund allocation
2. **Adaptor pattern**: Standard interface wrapping protocol complexity
3. **LP token accounting**: Share-based ownership with HWM for performance fees
4. **Profit locking**: Anti-sandwich degradation over configurable duration
5. **Atomic rebalancing**: Solana CPI for single-tx multi-protocol ops
6. **Checked arithmetic**: `u128` intermediates and `checked_*` everywhere
7. **Position value reporting**: Adaptors return `u64` for vault P&L tracking

---

## Existing Vault Strategies

| Vault | Type | Description |
|-------|------|-------------|
| Stablecoin Multi Lend | Lending | Multi-protocol stablecoin lending |
| DriftPack Arbitrage | Arbitrage | Drift-based arbitrage |
| HyperPack Arbitrage | Arbitrage | Cross-protocol arbitrage |
| JLP HyperLoop | Yield | JLP-based yield |
| rgUSD | Stablecoin | Dynamic lending optimization (8.56% 7d APY) |

---

## References

- Ranger Earn Docs: https://docs.ranger.finance
- API Swagger: https://api.voltr.xyz/docs
- Vault SDK: https://github.com/voltrxyz/vault-sdk
- Vault CPI (Rust): https://github.com/voltrxyz/vault-cpi
- Rebalance Bot: https://github.com/voltrxyz/rebalance-bot-template
- Basic UI: https://github.com/voltrxyz/basic-ui
- SDK Reference: https://voltrxyz.github.io/vault-sdk/
