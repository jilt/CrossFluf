# Solana Token-2022: KYC-Compliant Stablecoin Technical Reference

## Table of Contents
1. [Token-2022 Overview](#1-token-2022-overview)
2. [Key Extensions for KYC Stablecoin](#2-key-extensions-for-kyc-stablecoin)
3. [PYUSD Architecture](#3-pyusd-architecture)
4. [Implementation Guide](#4-implementation-guide)
5. [Code Examples](#5-code-examples)
6. [Account Structures](#6-account-structures)
7. [Important Limitations](#7-important-limitations)

---

## 1. TOKEN-2022 OVERVIEW

Token-2022 (also called "Token Extensions") is a superset of the original SPL Token program:

```
Program Address: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Full backward compatibility with SPL Token, plus 28+ modular extensions.

| Feature | SPL Token | Token-2022 |
|---|---|---|
| Program Address | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Extensions | None | 28+ optional extensions |
| Account Layout | Fixed (Mint: 82 bytes, Account: 165 bytes) | Variable (base + TLV extension data) |
| Metadata | Requires external Metaplex program | Native on-chain metadata via extension |
| Transfer Controls | Basic freeze/thaw only | Transfer hooks, fees, confidential transfers |
| Compliance Features | None built-in | Permanent delegate, default frozen state, transfer hooks |

### TLV (Type-Length-Value) Extension Storage

Extensions are stored after the base account data using TLV encoding:
- **Mint accounts**: First 82 bytes identical to SPL Token. Extensions begin at byte 82+.
- **Token accounts**: First 165 bytes identical to SPL Token. Extensions begin at byte 165+.

Each extension entry:
```
| Type (2 bytes) | Length (4 bytes LE) | Value (variable) |
```

**Critical rule**: Most extensions CANNOT be added after account initialization. You must declare all extensions at creation time.

### Relevant Extensions

**Mint Extensions:**
- TransferHook - custom logic on every transfer (KYC checks)
- PermanentDelegate - irrevocable authority over all accounts
- DefaultAccountState - accounts start frozen (KYC gate)
- MetadataPointer + TokenMetadata - on-chain metadata
- MintCloseAuthority - ability to decommission mint
- TransferFeeConfig - configurable transfer fees
- Pausable - pause all transfers

**Account Extensions:**
- TransferHookAccount - tracks transferring state
- ImmutableOwner - prevents owner changes
- CpiGuard - prevents CPI-based exploits

---

## 2. KEY EXTENSIONS FOR KYC STABLECOIN

### 2.1 Transfer Hook

Executes custom instruction logic on EVERY token transfer.

**Flow:**
```
User calls transfer_checked on Token-2022
  -> Token-2022 processes the transfer
  -> Token-2022 CPIs to the Transfer Hook program's Execute instruction
  -> Hook program runs custom logic (KYC check)
  -> If hook fails, entire transfer reverts atomically
```

**Security**: All accounts from the initial transfer become READ-ONLY when passed to the hook. Sender's signer privileges are DROPPED.

#### Transfer Hook Interface

Three instructions:
1. **Execute** (required) - invoked by Token-2022 on every transfer
2. **InitializeExtraAccountMetaList** - creates the account storing additional required accounts
3. **UpdateExtraAccountMetaList** - updates the additional accounts list

#### ExtraAccountMeta System

The hook needs accounts beyond standard transfer accounts. Stored in PDA:
```
seeds = ["extra-account-metas", mint_pubkey]
program = transfer_hook_program_id
```

Three ways to define extra accounts:

**1. Direct Account Address:**
```rust
ExtraAccountMeta::new_with_pubkey(&some_account.key(), false, false)?
```

**2. PDA Seeds (from Transfer Hook program):**
```rust
ExtraAccountMeta::new_with_seeds(
    &[Seed::Literal { bytes: b"kyc-registry".to_vec() }],
    false, false,
)?
```

**3. Seed from Account Data (critical for KYC - derives PDA from token account owner):**
```rust
ExtraAccountMeta::new_with_seeds(
    &[
        Seed::Literal { bytes: b"kyc-status".to_vec() },
        Seed::AccountData {
            account_index: 0,   // source token account
            data_index: 32,     // owner field offset in token account
            length: 32,         // pubkey length
        },
    ],
    false, false,
)?
```

#### Account Ordering in Transfer Hook

| Index | Account | Permissions |
|---|---|---|
| 0 | Source token account | read-only |
| 1 | Mint | read-only |
| 2 | Destination token account | read-only |
| 3 | Owner/Authority | read-only |
| 4 | ExtraAccountMetaList PDA | read-only |
| 5+ | Additional accounts from the list | as defined |

#### Complete Anchor Transfer Hook Program (KYC)

```rust
use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("YourTransferHookProgramId111111111111111111");

#[program]
pub mod kyc_transfer_hook {
    use super::*;

    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let account_metas = vec![
            // KYC registry PDA
            ExtraAccountMeta::new_with_seeds(
                &[Seed::Literal { bytes: b"kyc-registry".to_vec() }],
                false, false,
            )?,
            // Source KYC status PDA (derived from source token account owner)
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"kyc-status".to_vec() },
                    Seed::AccountData {
                        account_index: 0,   // source token account
                        data_index: 32,     // owner field offset
                        length: 32,
                    },
                ],
                false, false,
            )?,
            // Destination KYC status PDA (derived from dest token account owner)
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"kyc-status".to_vec() },
                    Seed::AccountData {
                        account_index: 2,   // destination token account
                        data_index: 32,
                        length: 32,
                    },
                ],
                false, false,
            )?,
        ];

        let account_size = ExtraAccountMetaList::size_of(account_metas.len())? as u64;
        let lamports = Rent::get()?.minimum_balance(account_size as usize);
        let mint = ctx.accounts.mint.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"extra-account-metas",
            mint.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ]];

        anchor_lang::system_program::create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
            ).with_signer(signer_seeds),
            lamports,
            account_size,
            ctx.program_id,
        )?;

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )?;

        Ok(())
    }

    // Called on every transfer
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        assert_is_transferring(&ctx)?;

        require!(
            ctx.accounts.source_kyc_status.is_verified,
            KycError::SourceNotVerified
        );
        require!(
            ctx.accounts.destination_kyc_status.is_verified,
            KycError::DestinationNotVerified
        );

        msg!("KYC verified. Transfer of {} approved.", amount);
        Ok(())
    }

    // Admin function to set KYC status
    pub fn set_kyc_status(
        ctx: Context<SetKycStatus>,
        is_verified: bool,
    ) -> Result<()> {
        ctx.accounts.kyc_status.is_verified = is_verified;
        ctx.accounts.kyc_status.verified_at = Clock::get()?.unix_timestamp;
        ctx.accounts.kyc_status.authority = ctx.accounts.authority.key();
        Ok(())
    }
}

fn assert_is_transferring(ctx: &Context<TransferHook>) -> Result<()> {
    let source_token_info = ctx.accounts.source_token.to_account_info();
    let mut account_data_ref = source_token_info.try_borrow_mut_data()?;
    let mut account = spl_token_2022::extension::PodStateWithExtensionsMut::<
        spl_token_2022::pod::PodAccount
    >::unpack(*account_data_ref)?;
    let account_extension = account
        .get_extension_mut::<spl_token_2022::extension::transfer_hook::TransferHookAccount>()?;
    if !bool::from(account_extension.transferring) {
        return err!(KycError::IsNotCurrentlyTransferring);
    }
    Ok(())
}

// Anchor fallback for Transfer Hook interface discriminator
pub fn fallback<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    data: &[u8],
) -> Result<()> {
    let instruction = spl_transfer_hook_interface::instruction::TransferHookInstruction::unpack(data)?;
    match instruction {
        spl_transfer_hook_interface::instruction::TransferHookInstruction::Execute { amount } => {
            let amount_bytes = amount.to_le_bytes();
            __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
        }
        _ => return Err(ProgramError::InvalidInstructionData.into()),
    }
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: ExtraAccountMetaList PDA
    #[account(mut, seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: AccountInfo<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint, token::authority = owner)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Owner of source token account
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList PDA
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: KYC Registry PDA
    #[account(seeds = [b"kyc-registry"], bump)]
    pub kyc_registry: UncheckedAccount<'info>,
    #[account(seeds = [b"kyc-status", source_token.owner.as_ref()], bump)]
    pub source_kyc_status: Account<'info, KycStatus>,
    #[account(seeds = [b"kyc-status", destination_token.owner.as_ref()], bump)]
    pub destination_kyc_status: Account<'info, KycStatus>,
}

#[derive(Accounts)]
pub struct SetKycStatus<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + KycStatus::INIT_SPACE,
        seeds = [b"kyc-status", user.key().as_ref()],
        bump,
    )]
    pub kyc_status: Account<'info, KycStatus>,
    /// CHECK: The user whose KYC status is being set
    pub user: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct KycStatus {
    pub is_verified: bool,
    pub verified_at: i64,
    pub authority: Pubkey,
}

#[error_code]
pub enum KycError {
    #[msg("Source account is not KYC verified")]
    SourceNotVerified,
    #[msg("Destination account is not KYC verified")]
    DestinationNotVerified,
    #[msg("Not being called during a transfer")]
    IsNotCurrentlyTransferring,
}
```

**Cargo.toml dependencies:**
```toml
[dependencies]
anchor-lang = "0.31.1"
anchor-spl = { version = "0.31.1", features = ["token_2022", "token_2022_extensions"] }
spl-transfer-hook-interface = "0.10.0"
spl-tlv-account-resolution = "0.10.0"
spl-token-2022 = { version = "7.0.0", features = ["no-entrypoint"] }
```

#### Client-Side Transfer with Hook

```typescript
import {
    createTransferCheckedWithTransferHookInstruction,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

// Automatically resolves all extra accounts from ExtraAccountMetaList
const transferInstruction =
    await createTransferCheckedWithTransferHookInstruction(
        connection,
        sourceTokenAccount,
        mint.publicKey,
        destinationTokenAccount,
        wallet.publicKey,
        amountBigInt,
        decimals,
        [],                      // additional signers
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
    );
```

---

### 2.2 Permanent Delegate

Assigns UNLIMITED, IRREVOCABLE delegate authority over ALL token accounts for a mint.

- Can **transfer** any amount from any account
- Can **burn** any amount from any account
- Token owners CANNOT remove this
- Only current delegate can transfer the role

**Use cases:** Fund seizure, wrong-address recovery, fraud clawback, OFAC enforcement.

**PYUSD:** Paxos holds permanent delegate for regulatory compliance.

```rust
let initialize_permanent_delegate_ix = spl_token_2022::instruction::initialize_permanent_delegate(
    &TOKEN_2022_PROGRAM_ID,
    &mint.pubkey(),
    &delegate.pubkey(),
)?;
// Order: create account -> init permanent delegate -> init mint
```

```typescript
import { createInitializePermanentDelegateInstruction } from "@solana/spl-token";

createInitializePermanentDelegateInstruction(
    mint.publicKey,
    delegate.publicKey,
    TOKEN_2022_PROGRAM_ID,
);
```

---

### 2.3 Default Account State (Frozen by Default)

Every new token account starts FROZEN. Natural KYC gate:

```
1. User creates token account -> FROZEN
2. User completes KYC off-chain
3. Freeze authority calls thawAccount -> UNFROZEN
4. User can now transact
```

**MUST set a freeze authority** when using DefaultAccountState::Frozen.

```rust
let init_default_state_ix = initialize_default_account_state(
    &TOKEN_2022_PROGRAM_ID,
    &mint.pubkey(),
    &AccountState::Frozen,
)?;
// Must come BEFORE initialize_mint
```

```typescript
// Thaw after KYC
import { thawAccount, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

await thawAccount(
    connection, payer, tokenAccount,
    mint.publicKey, freezeAuthority,
    undefined, undefined, TOKEN_2022_PROGRAM_ID,
);
```

---

### 2.4 Mint Close Authority

Allows closing the mint account and reclaiming rent. Requirements: supply must be zero.

```rust
let init_close_authority_ix = initialize_mint_close_authority(
    &TOKEN_2022_PROGRAM_ID,
    &mint.pubkey(),
    Some(&close_authority.pubkey()),
)?;
```

---

### 2.5 Metadata / MetadataPointer

Two extensions work together:
- **MetadataPointer**: Points to where metadata lives (usually the mint itself)
- **TokenMetadata**: Stores name, symbol, uri, and arbitrary key-value pairs

```rust
use spl_token_metadata_interface::instruction::{initialize as initialize_token_metadata};

let init_metadata_ix = initialize_token_metadata(
    &TOKEN_2022_PROGRAM_ID,
    &mint.pubkey(),           // metadata account (= mint)
    &authority.pubkey(),      // update authority
    &mint.pubkey(),           // mint
    &mint_authority.pubkey(), // mint authority
    "KYC Stablecoin".to_string(),
    "KYCS".to_string(),
    "https://example.com/metadata.json".to_string(),
);
```

---

## 3. PYUSD ARCHITECTURE

PayPal USD issued by Paxos Trust Company. Over $300M minted on Solana.

**Mint Address (Mainnet):** `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo`
**Mint Address (Devnet):** `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM`

| Extension | Configuration | Purpose |
|---|---|---|
| Confidential Transfers | Initialized (not yet enabled) | Merchant privacy |
| Transfer Hook | Initialized with **null program ID** | Reserved for future compliance |
| Permanent Delegate | Active, held by Paxos | Fund seizure, OFAC enforcement |
| Metadata + MetadataPointer | Active, self-referencing | Name/symbol/image on-chain |
| Mint Close Authority | Initialized | Future-proofing |
| Transfer Fees | Initialized at **0%** | Fail-safe, can activate later |

### Key Architectural Decisions

1. **Extensions as fail-safes**: PYUSD initializes extensions (transfer hook with null, fees at 0%) as forward-looking provisions activatable without a new mint
2. **No custom smart contracts needed**: All compliance via Token-2022 built-in extensions
3. **Integration simplicity**: Standard `@solana/spl-token` library functions work

### Other Stablecoins Using Similar Architecture
- **GYEN** and **ZUSD** by GMO Trust: Transfer hooks, metadata, permanent delegate

---

## 4. IMPLEMENTATION GUIDE

### Step 1: Extension Set

```rust
let extensions = vec![
    ExtensionType::DefaultAccountState,    // Frozen by default
    ExtensionType::PermanentDelegate,      // Compliance authority
    ExtensionType::TransferHook,           // KYC verification
    ExtensionType::MetadataPointer,        // On-chain metadata
    ExtensionType::MintCloseAuthority,     // Future-proofing
];
```

### Step 2: Create Mint (instruction order is CRITICAL)

```
1. SystemProgram::CreateAccount
2. InitializeDefaultAccountState (Frozen)
3. InitializePermanentDelegate
4. InitializeTransferHook
5. InitializeMetadataPointer (point to self)
6. InitializeMintCloseAuthority
7. InitializeMint (finalize with authorities)
8. InitializeTokenMetadata (name, symbol, uri)
```

**Complete Rust:**
```rust
let mint_space = ExtensionType::try_calculate_account_len::<Mint>(&[
    ExtensionType::DefaultAccountState,
    ExtensionType::PermanentDelegate,
    ExtensionType::TransferHook,
    ExtensionType::MetadataPointer,
    ExtensionType::MintCloseAuthority,
])?;

let metadata_space = token_metadata.tlv_size_of()?;
let total_space = mint_space + metadata_space;
let rent = client.get_minimum_balance_for_rent_exemption(total_space).await?;

let instructions = vec![
    create_account(&payer.pubkey(), &mint_keypair.pubkey(), rent, mint_space as u64, &TOKEN_2022_PROGRAM_ID),
    initialize_default_account_state(&TOKEN_2022_PROGRAM_ID, &mint_keypair.pubkey(), &AccountState::Frozen)?,
    initialize_permanent_delegate(&TOKEN_2022_PROGRAM_ID, &mint_keypair.pubkey(), &compliance_authority.pubkey())?,
    transfer_hook::instruction::initialize(&TOKEN_2022_PROGRAM_ID, &mint_keypair.pubkey(), Some(hook_authority.pubkey()), Some(transfer_hook_program_id))?,
    metadata_pointer::instruction::initialize(&TOKEN_2022_PROGRAM_ID, &mint_keypair.pubkey(), Some(metadata_authority.pubkey()), Some(mint_keypair.pubkey()))?,
    initialize_mint_close_authority(&TOKEN_2022_PROGRAM_ID, &mint_keypair.pubkey(), Some(&close_authority.pubkey()))?,
    initialize_mint(&TOKEN_2022_PROGRAM_ID, &mint_keypair.pubkey(), &mint_authority.pubkey(), Some(&freeze_authority.pubkey()), 6)?,
    initialize_token_metadata(&TOKEN_2022_PROGRAM_ID, &mint_keypair.pubkey(), &metadata_authority.pubkey(), &mint_keypair.pubkey(), &mint_authority.pubkey(), "KYC Stablecoin".into(), "KYCS".into(), "https://example.com/metadata.json".into()),
];
```

**Complete TypeScript:**
```typescript
import {
    createInitializeMintInstruction,
    createInitializeDefaultAccountStateInstruction,
    createInitializePermanentDelegateInstruction,
    createInitializeTransferHookInstruction,
    createInitializeMetadataPointerInstruction,
    createInitializeMintCloseAuthorityInstruction,
    ExtensionType, getMintLen, AccountState, TOKEN_2022_PROGRAM_ID,
    TYPE_SIZE, LENGTH_SIZE,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";

const extensions = [
    ExtensionType.DefaultAccountState,
    ExtensionType.PermanentDelegate,
    ExtensionType.TransferHook,
    ExtensionType.MetadataPointer,
    ExtensionType.MintCloseAuthority,
];

const metadata = {
    mint: mint.publicKey,
    name: "KYC Stablecoin",
    symbol: "KYCS",
    uri: "https://example.com/metadata.json",
    additionalMetadata: [],
};

const mintLen = getMintLen(extensions);
const metadataLen = pack(metadata).length;
const lamports = await connection.getMinimumBalanceForRentExemption(
    mintLen + metadataLen + TYPE_SIZE + LENGTH_SIZE
);

const tx = new Transaction().add(
    SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeDefaultAccountStateInstruction(mint.publicKey, AccountState.Frozen, TOKEN_2022_PROGRAM_ID),
    createInitializePermanentDelegateInstruction(mint.publicKey, complianceAuthority.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeTransferHookInstruction(mint.publicKey, hookAuthority.publicKey, transferHookProgramId, TOKEN_2022_PROGRAM_ID),
    createInitializeMetadataPointerInstruction(mint.publicKey, metadataAuthority.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintCloseAuthorityInstruction(mint.publicKey, closeAuthority.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, 6, mintAuthority.publicKey, freezeAuthority.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        mint: mint.publicKey,
        metadata: mint.publicKey,
        mintAuthority: mintAuthority.publicKey,
        name: "KYC Stablecoin",
        symbol: "KYCS",
        uri: "https://example.com/metadata.json",
        updateAuthority: metadataAuthority.publicKey,
    }),
);
```

### Step 3: Deploy Transfer Hook Program

See the complete Anchor program in Section 2.1. Deploy it, then use its program ID when initializing TransferHook extension.

### Step 4: Initialize ExtraAccountMetaList

After deploying both mint and hook program, call `initialize_extra_account_meta_list` on the hook program.

### Step 5: KYC Registry Design

```
KYC Status PDA per user:
  seeds = ["kyc-status", user_pubkey]
  program = transfer_hook_program

KYC Registry (global config):
  seeds = ["kyc-registry"]
  program = transfer_hook_program
```

### Step 6: Operational Procedures

**Onboarding:**
```
1. User creates ATA -> starts FROZEN
2. User submits KYC documents off-chain
3. KYC system verifies -> calls set_kyc_status(user, true)
4. KYC system calls thawAccount(user_ata, mint, freeze_authority)
5. User can now transact
```

**Revoking KYC:**
```
1. Compliance calls set_kyc_status(user, false)
2. Compliance calls freezeAccount(user_ata)
3. (Optional) Permanent delegate transfers tokens out
```

**Seizing funds:**
```
1. Permanent delegate calls transfer_checked with delegate authority
2. Tokens moved to seizure account -- no user signature required
```

---

## 5. CODE EXAMPLES

### Token Account Layout (for AccountData seeds)

```rust
// Token Account layout (first 165 bytes):
// Bytes 0-31:   mint (Pubkey)
// Bytes 32-63:  owner (Pubkey)  <-- referenced by Seed::AccountData
// Bytes 64-71:  amount (u64)
// Bytes 72-75:  delegate option (4 bytes)
// Bytes 76-107: delegate (Pubkey)
// Bytes 108:    state (1 byte)
```

### Reading Extension Data On-Chain

```rust
use spl_token_2022::extension::{StateWithExtensions, BaseStateWithExtensions};

let mint_data = ctx.accounts.mint.to_account_info();
let mint_state = StateWithExtensions::<Mint>::unpack(&mint_data.try_borrow_data()?)?;

if let Ok(transfer_hook) = mint_state.get_extension::<TransferHook>() {
    msg!("Transfer hook program: {:?}", transfer_hook.program_id);
}

if let Ok(perm_delegate) = mint_state.get_extension::<PermanentDelegate>() {
    msg!("Permanent delegate: {:?}", perm_delegate.delegate);
}
```

---

## 6. ACCOUNT STRUCTURES

### Mint Account Layout (with compliance extensions)

```
Bytes 0-81:     Base Mint Data
  [0-31]        mint_authority (Option<Pubkey>)
  [32-39]       supply (u64)
  [40]          decimals (u8)
  [41]          is_initialized (bool)
  [42-73]       freeze_authority (Option<Pubkey>)

Bytes 82+:      Account Type discriminator + padding

Bytes 86+:      TLV Extension Data
  DefaultAccountState:    Type(2) | Len(4) | state(1)
  PermanentDelegate:      Type(2) | Len(4) | delegate(32)
  TransferHook:           Type(2) | Len(4) | authority(32) | program_id(32)
  MetadataPointer:        Type(2) | Len(4) | authority(32) | metadata_address(32)
  MintCloseAuthority:     Type(2) | Len(4) | close_authority(32)
  TokenMetadata:          Type(2) | Len(4) | variable fields...
```

### PDAs Required

| PDA | Seeds | Program | Purpose |
|---|---|---|---|
| ExtraAccountMetaList | `["extra-account-metas", mint]` | Transfer Hook | Extra accounts for hook |
| KYC Registry | `["kyc-registry"]` | Transfer Hook | Global config |
| KYC Status (per user) | `["kyc-status", user_pubkey]` | Transfer Hook | Individual KYC status |
| ATA | `[owner, TOKEN_2022_PROGRAM_ID, mint]` | Associated Token Program | User's token account |

---

## 7. IMPORTANT LIMITATIONS

### Extension Incompatibilities

| Extension A | Extension B | Reason |
|---|---|---|
| NonTransferable | TransferHook | Cannot hook non-transferable tokens |
| ConfidentialTransfer | TransferHook | CPI + encryption incompatible |
| ConfidentialTransfer | PermanentDelegate | Delegate can't access encrypted balances |

**Our extensions (DefaultAccountState + PermanentDelegate + TransferHook + MetadataPointer + MintCloseAuthority) are ALL COMPATIBLE.**

### CPI Depth Limit (4 levels)

```
Level 0: User's transaction
Level 1: Your program calls transfer_checked on Token-2022
Level 2: Token-2022 CPIs to Transfer Hook program
Level 3: Hook program can CPI to another program
Level 4: Maximum
```

### Re-entrancy Prevention

Token-2022 prohibits re-entrancy: CANNOT call Token-2022 to move tokens while it's waiting for hook to finish.

### Transfer Hook Constraints

1. All accounts are READ-ONLY in the hook
2. Sender's signer privileges are DROPPED
3. Validate mint account in hook logic (mint spoofing risk)
4. Complex hooks may exceed 200k CU default (increase to 1.4M with `SetComputeUnitLimit`)

### Permanent Delegate Risks

1. Single point of compromise -> can drain every account
2. DeFi protocols may refuse integration (can drain vaults)
3. Irrevocable - can only transfer to new key, never remove

### Extensions Cannot Be Added Post-Initialization

Plan your extension set BEFORE deployment. Cannot add later.

### Security Audits of Token-2022

- Halborn (2022, 2024), Zellic (2022), Trail of Bits (2023), NCC Group (2023), OtterSec (2023), Certora (2024)

---

## Sources

- [Token Extensions Getting Started](https://solana.com/developers/guides/token-extensions/getting-started)
- [Transfer Hook Guide](https://solana.com/developers/guides/token-extensions/transfer-hook)
- [Permanent Delegate](https://solana.com/docs/tokens/extensions/permanent-delegate)
- [Default Account State](https://solana.com/developers/guides/token-extensions/default-account-state)
- [PYUSD Deep Dive](https://developer.paypal.com/community/blog/pyusd-solana-token-extensions/)
- [PYUSD on Solana](https://solana.com/news/pyusd-paypal-solana-developer)
- [Transfer Hooks Anchor Guide](https://chainstack.com/solana-transfer-hooks-anchor-token-2022/)
- [Token-2022 Security Pitfalls](https://neodyme.io/en/blog/token-2022/)
- [Anchor Token Extensions Docs](https://www.anchor-lang.com/docs/tokens/extensions)
