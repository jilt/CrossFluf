// SPDX-License-Identifier: BUSL-1.1
//
// Institutional Permissioned DeFi Vault
// - Accepts Token-2022 deposits (KYC-gated via transfer hook)
// - Issues LP tokens for share accounting
// - Multi-strategy allocation with rebalancing
// - Performance fees with high water mark
// - Anti-sandwich profit locking

use anchor_lang::prelude::*;
use anchor_spl::{
    token::{self, Mint as SplMint, Token, TokenAccount as SplTokenAccount},
    token_interface::{Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount},
};

declare_id!("HqA6kcJq4XUQMSycHiBMwW6MeUB7qQcpqbMDb9m69pe8");

/// Precision for asset-per-LP calculations (18 decimal places)
const PRECISION: u128 = 1_000_000_000_000_000_000;
/// Basis point denominator
const BPS_DENOMINATOR: u64 = 10_000;
/// Maximum strategies per vault
const MAX_STRATEGIES: u8 = 10;

#[program]
pub mod vault {
    use super::*;

    /// Initialize a new vault.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        name: String,
        config: VaultConfig,
    ) -> Result<()> {
        require!(name.len() <= 32, VaultError::NameTooLong);
        require!(
            config.performance_fee_bps <= 5000,
            VaultError::FeeTooHigh
        );
        require!(
            config.management_fee_bps <= 1000,
            VaultError::FeeTooHigh
        );

        let vault = &mut ctx.accounts.vault;
        let mut name_bytes = [0u8; 32];
        let name_slice = name.as_bytes();
        name_bytes[..name_slice.len()].copy_from_slice(name_slice);

        vault.name = name_bytes;
        vault.admin = ctx.accounts.admin.key();
        vault.manager = ctx.accounts.manager.key();
        vault.asset_mint = ctx.accounts.asset_mint.key();
        vault.lp_mint = ctx.accounts.lp_mint.key();
        vault.vault_asset_account = ctx.accounts.vault_asset_account.key();
        vault.total_assets = 0;
        vault.idle_assets = 0;
        vault.lp_supply = 0;
        vault.max_cap = config.max_cap;
        vault.performance_fee_bps = config.performance_fee_bps;
        vault.management_fee_bps = config.management_fee_bps;
        vault.deposit_fee_bps = config.deposit_fee_bps;
        vault.withdrawal_fee_bps = config.withdrawal_fee_bps;
        vault.locked_profit_degradation = config.locked_profit_degradation;
        vault.withdrawal_wait_period = config.withdrawal_wait_period;
        vault.high_water_mark = PRECISION; // 1:1 initial ratio
        vault.last_fee_harvest_ts = Clock::get()?.unix_timestamp;
        vault.locked_profit = 0;
        vault.locked_profit_ts = Clock::get()?.unix_timestamp;
        vault.num_strategies = 0;
        vault.accumulated_fees = 0;
        vault.is_active = true;
        vault.bump = ctx.bumps.vault;

        msg!("Vault '{}' initialized", name);
        msg!("Admin: {}", vault.admin);
        msg!("Manager: {}", vault.manager);
        msg!("Asset mint: {}", vault.asset_mint);
        Ok(())
    }

    /// Deposit assets into the vault. Mints LP tokens proportional to share.
    /// remaining_accounts: extra accounts needed for Token-2022 transfer hook.
    pub fn deposit<'info>(ctx: Context<'_, '_, 'info, 'info, Deposit<'info>>, amount: u64) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(vault.is_active, VaultError::VaultInactive);
        require!(amount > 0, VaultError::ZeroAmount);
        require!(
            vault.total_assets.checked_add(amount).unwrap() <= vault.max_cap,
            VaultError::MaxCapExceeded
        );

        // Calculate LP tokens to mint
        let lp_to_mint = if vault.lp_supply == 0 {
            // First deposit: 1:1 ratio
            amount
        } else {
            // Proportional: (amount * lp_supply) / total_assets
            let effective_assets = effective_total_assets(vault)?;
            (amount as u128)
                .checked_mul(vault.lp_supply as u128)
                .unwrap()
                .checked_div(effective_assets as u128)
                .unwrap() as u64
        };

        require!(lp_to_mint > 0, VaultError::ZeroLpTokens);

        // Apply deposit fee (taken from LP tokens)
        let fee_lp = if vault.deposit_fee_bps > 0 {
            (lp_to_mint as u128)
                .checked_mul(vault.deposit_fee_bps as u128)
                .unwrap()
                .checked_div(BPS_DENOMINATOR as u128)
                .unwrap() as u64
        } else {
            0
        };
        let lp_after_fee = lp_to_mint.checked_sub(fee_lp).unwrap();

        // Transfer assets from user to vault via Token-2022 with transfer hook support
        spl_token_2022::onchain::invoke_transfer_checked(
            &ctx.accounts.asset_token_program.key(),
            ctx.accounts.user_asset_account.to_account_info(),
            ctx.accounts.asset_mint.to_account_info(),
            ctx.accounts.vault_asset_account.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.remaining_accounts,
            amount,
            ctx.accounts.asset_mint.decimals,
            &[], // no PDA signing needed (user is signer)
        )?;

        // Mint LP tokens to user
        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"lp_mint_auth",
            vault_key.as_ref(),
            &[ctx.bumps.lp_mint_authority],
        ];
        let signer = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.lp_token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.user_lp_account.to_account_info(),
                    authority: ctx.accounts.lp_mint_authority.to_account_info(),
                },
                signer,
            ),
            lp_after_fee,
        )?;

        // Update vault state
        let vault = &mut ctx.accounts.vault;
        vault.total_assets = vault.total_assets.checked_add(amount).unwrap();
        vault.idle_assets = vault.idle_assets.checked_add(amount).unwrap();
        vault.lp_supply = vault.lp_supply.checked_add(lp_after_fee).unwrap();
        vault.accumulated_fees = vault.accumulated_fees.checked_add(fee_lp).unwrap();

        msg!("Deposited {} assets, minted {} LP tokens", amount, lp_after_fee);
        Ok(())
    }

    /// Withdraw assets from the vault. Burns LP tokens and returns assets.
    /// remaining_accounts: extra accounts needed for Token-2022 transfer hook.
    pub fn instant_withdraw<'info>(ctx: Context<'_, '_, 'info, 'info, InstantWithdraw<'info>>, lp_amount: u64) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(
            vault.withdrawal_wait_period == 0,
            VaultError::InstantWithdrawNotAllowed
        );
        require!(lp_amount > 0, VaultError::ZeroAmount);

        // Calculate assets to return
        let effective_assets = effective_total_assets(vault)?;
        let assets_to_return = (lp_amount as u128)
            .checked_mul(effective_assets as u128)
            .unwrap()
            .checked_div(vault.lp_supply as u128)
            .unwrap() as u64;

        // Apply withdrawal fee
        let fee = if vault.withdrawal_fee_bps > 0 {
            (assets_to_return as u128)
                .checked_mul(vault.withdrawal_fee_bps as u128)
                .unwrap()
                .checked_div(BPS_DENOMINATOR as u128)
                .unwrap() as u64
        } else {
            0
        };
        let assets_after_fee = assets_to_return.checked_sub(fee).unwrap();

        require!(
            assets_after_fee <= vault.idle_assets,
            VaultError::InsufficientIdle
        );

        // Burn LP tokens
        token::burn(
            CpiContext::new(
                ctx.accounts.lp_token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    from: ctx.accounts.user_lp_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            lp_amount,
        )?;

        // Transfer assets from vault to user via CPI (Token-2022)
        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"vault_asset_auth",
            vault_key.as_ref(),
            &[ctx.bumps.vault_asset_authority],
        ];
        let signer = &[&seeds[..]];

        // Transfer via Token-2022 with transfer hook support
        spl_token_2022::onchain::invoke_transfer_checked(
            &ctx.accounts.asset_token_program.key(),
            ctx.accounts.vault_asset_account.to_account_info(),
            ctx.accounts.asset_mint.to_account_info(),
            ctx.accounts.user_asset_account.to_account_info(),
            ctx.accounts.vault_asset_authority.to_account_info(),
            ctx.remaining_accounts,
            assets_after_fee,
            ctx.accounts.asset_mint.decimals,
            signer,
        )?;

        // Update vault state
        let vault = &mut ctx.accounts.vault;
        vault.total_assets = vault.total_assets.checked_sub(assets_to_return).unwrap();
        vault.idle_assets = vault.idle_assets.checked_sub(assets_after_fee).unwrap();
        vault.lp_supply = vault.lp_supply.checked_sub(lp_amount).unwrap();

        msg!("Withdrew {} assets for {} LP tokens", assets_after_fee, lp_amount);
        Ok(())
    }

    /// Add a new strategy to the vault. Admin only.
    pub fn add_strategy(
        ctx: Context<AddStrategy>,
        name: String,
        protocol: String,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.admin.key() == vault.admin,
            VaultError::Unauthorized
        );
        require!(vault.num_strategies < MAX_STRATEGIES, VaultError::MaxStrategies);

        let mut name_bytes = [0u8; 32];
        let name_slice = name.as_bytes();
        let len = name_slice.len().min(32);
        name_bytes[..len].copy_from_slice(&name_slice[..len]);

        let mut protocol_bytes = [0u8; 32];
        let protocol_slice = protocol.as_bytes();
        let plen = protocol_slice.len().min(32);
        protocol_bytes[..plen].copy_from_slice(&protocol_slice[..plen]);

        let strategy = &mut ctx.accounts.strategy;
        strategy.vault = vault.key();
        strategy.index = vault.num_strategies;
        strategy.name = name_bytes;
        strategy.protocol = protocol_bytes;
        strategy.position_value = 0;
        strategy.allocated = 0;
        strategy.is_active = true;
        strategy.last_update_ts = Clock::get()?.unix_timestamp;
        strategy.bump = ctx.bumps.strategy;

        vault.num_strategies = vault.num_strategies.checked_add(1).unwrap();

        msg!("Strategy '{}' added (index {})", name, strategy.index);
        Ok(())
    }

    /// Allocate idle funds to a strategy. Manager only.
    pub fn allocate(ctx: Context<Allocate>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.manager.key() == vault.manager,
            VaultError::Unauthorized
        );
        require!(amount > 0, VaultError::ZeroAmount);
        require!(amount <= vault.idle_assets, VaultError::InsufficientIdle);

        let strategy = &mut ctx.accounts.strategy;
        require!(strategy.is_active, VaultError::StrategyInactive);

        vault.idle_assets = vault.idle_assets.checked_sub(amount).unwrap();
        strategy.position_value = strategy.position_value.checked_add(amount).unwrap();
        strategy.allocated = strategy.allocated.checked_add(amount).unwrap();
        strategy.last_update_ts = Clock::get()?.unix_timestamp;

        msg!(
            "Allocated {} to strategy {} (total: {})",
            amount,
            strategy.index,
            strategy.position_value
        );
        Ok(())
    }

    /// Deallocate funds from a strategy back to idle. Manager only.
    pub fn deallocate(ctx: Context<Allocate>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.manager.key() == vault.manager,
            VaultError::Unauthorized
        );
        require!(amount > 0, VaultError::ZeroAmount);

        let strategy = &mut ctx.accounts.strategy;
        require!(
            amount <= strategy.position_value,
            VaultError::InsufficientStrategyBalance
        );

        strategy.position_value = strategy.position_value.checked_sub(amount).unwrap();
        strategy.last_update_ts = Clock::get()?.unix_timestamp;
        vault.idle_assets = vault.idle_assets.checked_add(amount).unwrap();

        msg!(
            "Deallocated {} from strategy {} (remaining: {})",
            amount,
            strategy.index,
            strategy.position_value
        );
        Ok(())
    }

    /// Report yield for a strategy. Updates position value.
    /// Called by the rebalancing bot or manager.
    pub fn report_yield(
        ctx: Context<ReportYield>,
        new_position_value: u64,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.manager.key() == vault.manager,
            VaultError::Unauthorized
        );

        let strategy = &mut ctx.accounts.strategy;
        let old_value = strategy.position_value;
        strategy.position_value = new_position_value;
        strategy.last_update_ts = Clock::get()?.unix_timestamp;

        // Update total assets based on the value change
        if new_position_value > old_value {
            let profit = new_position_value - old_value;
            vault.total_assets = vault.total_assets.checked_add(profit).unwrap();

            // Lock profits for anti-sandwich
            vault.locked_profit = vault.locked_profit.checked_add(profit).unwrap();
            vault.locked_profit_ts = Clock::get()?.unix_timestamp;

            msg!(
                "Strategy {} yield: +{} (total value: {})",
                strategy.index,
                profit,
                new_position_value
            );
        } else if new_position_value < old_value {
            let loss = old_value - new_position_value;
            vault.total_assets = vault.total_assets.saturating_sub(loss);

            msg!(
                "Strategy {} loss: -{} (total value: {})",
                strategy.index,
                loss,
                new_position_value
            );
        }

        Ok(())
    }

    /// Harvest performance and management fees. Mints LP tokens to admin.
    pub fn harvest_fees(ctx: Context<HarvestFees>) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(
            ctx.accounts.admin.key() == vault.admin,
            VaultError::Unauthorized
        );

        let now = Clock::get()?.unix_timestamp;
        let elapsed = (now - vault.last_fee_harvest_ts) as u64;
        let effective_assets = effective_total_assets(vault)?;

        // Management fee: annual fee on total assets, pro-rated
        let management_fee = if vault.management_fee_bps > 0 && elapsed > 0 {
            let annual_fee = (effective_assets as u128)
                .checked_mul(vault.management_fee_bps as u128)
                .unwrap()
                .checked_div(BPS_DENOMINATOR as u128)
                .unwrap();
            // Pro-rate: (annual_fee * elapsed) / seconds_per_year
            (annual_fee * elapsed as u128 / 31_536_000) as u64
        } else {
            0
        };

        // Performance fee: fee on profits above high water mark
        let current_ratio = if vault.lp_supply > 0 {
            (effective_assets as u128)
                .checked_mul(PRECISION)
                .unwrap()
                .checked_div(vault.lp_supply as u128)
                .unwrap()
        } else {
            PRECISION
        };

        let performance_fee = if current_ratio > vault.high_water_mark
            && vault.performance_fee_bps > 0
        {
            let excess = current_ratio - vault.high_water_mark;
            let profit_value = (excess * vault.lp_supply as u128) / PRECISION;
            (profit_value * vault.performance_fee_bps as u128 / BPS_DENOMINATOR as u128) as u64
        } else {
            0
        };

        let total_fee_assets = management_fee.checked_add(performance_fee).unwrap();
        if total_fee_assets == 0 {
            msg!("No fees to harvest");
            return Ok(());
        }

        // Mint LP tokens worth the fee amount to admin
        let fee_lp = if vault.lp_supply > 0 && effective_assets > 0 {
            (total_fee_assets as u128)
                .checked_mul(vault.lp_supply as u128)
                .unwrap()
                .checked_div(effective_assets as u128)
                .unwrap() as u64
        } else {
            total_fee_assets
        };

        if fee_lp > 0 {
            let vault_key = ctx.accounts.vault.key();
            let seeds = &[
                b"lp_mint_auth",
                vault_key.as_ref(),
                &[ctx.bumps.lp_mint_authority],
            ];
            let signer = &[&seeds[..]];

            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.lp_token_program.to_account_info(),
                    token::MintTo {
                        mint: ctx.accounts.lp_mint.to_account_info(),
                        to: ctx.accounts.admin_lp_account.to_account_info(),
                        authority: ctx.accounts.lp_mint_authority.to_account_info(),
                    },
                    signer,
                ),
                fee_lp,
            )?;
        }

        // Update vault state
        let vault = &mut ctx.accounts.vault;
        vault.lp_supply = vault.lp_supply.checked_add(fee_lp).unwrap();
        vault.last_fee_harvest_ts = now;
        vault.accumulated_fees = vault.accumulated_fees.checked_add(total_fee_assets).unwrap();

        // Update high water mark
        if current_ratio > vault.high_water_mark {
            vault.high_water_mark = current_ratio;
        }

        msg!(
            "Harvested fees: management={}, performance={}, minted {} LP",
            management_fee,
            performance_fee,
            fee_lp
        );
        Ok(())
    }

    /// Deactivate a strategy. Admin only. Strategy must have zero position.
    pub fn remove_strategy(ctx: Context<RemoveStrategy>) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(
            ctx.accounts.admin.key() == vault.admin,
            VaultError::Unauthorized
        );

        let strategy = &mut ctx.accounts.strategy;
        require!(
            strategy.position_value == 0,
            VaultError::StrategyNotEmpty
        );
        strategy.is_active = false;

        msg!("Strategy {} deactivated", strategy.index);
        Ok(())
    }

    /// Update vault configuration. Admin only.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_config: VaultConfig,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.admin.key() == vault.admin,
            VaultError::Unauthorized
        );
        require!(
            new_config.performance_fee_bps <= 5000,
            VaultError::FeeTooHigh
        );

        vault.max_cap = new_config.max_cap;
        vault.performance_fee_bps = new_config.performance_fee_bps;
        vault.management_fee_bps = new_config.management_fee_bps;
        vault.deposit_fee_bps = new_config.deposit_fee_bps;
        vault.withdrawal_fee_bps = new_config.withdrawal_fee_bps;
        vault.locked_profit_degradation = new_config.locked_profit_degradation;
        vault.withdrawal_wait_period = new_config.withdrawal_wait_period;

        msg!("Vault config updated");
        Ok(())
    }

    /// Pause/unpause the vault. Admin only.
    pub fn set_active(ctx: Context<UpdateConfig>, is_active: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.admin.key() == vault.admin,
            VaultError::Unauthorized
        );
        vault.is_active = is_active;
        msg!("Vault active: {}", is_active);
        Ok(())
    }
}

// --- Helpers ---

/// Calculate effective total assets accounting for locked profit degradation.
fn effective_total_assets(vault: &Vault) -> Result<u64> {
    if vault.locked_profit == 0 || vault.locked_profit_degradation == 0 {
        return Ok(vault.total_assets);
    }

    let now = Clock::get()?.unix_timestamp;
    let elapsed = (now - vault.locked_profit_ts) as u64;

    if elapsed >= vault.locked_profit_degradation {
        // All profit unlocked
        Ok(vault.total_assets)
    } else {
        // Partially locked
        let remaining_locked = (vault.locked_profit as u128)
            .checked_mul((vault.locked_profit_degradation - elapsed) as u128)
            .unwrap()
            .checked_div(vault.locked_profit_degradation as u128)
            .unwrap() as u64;
        Ok(vault.total_assets.saturating_sub(remaining_locked))
    }
}

// --- Account Structs ---

#[derive(Accounts)]
#[instruction(name: String)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Manager can be any pubkey
    pub manager: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", admin.key().as_ref(), name.as_bytes()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    /// The asset this vault accepts (e.g., fUSD Token-2022 mint)
    pub asset_mint: InterfaceAccount<'info, InterfaceMint>,

    /// LP token mint (regular SPL Token). Created externally, authority transferred to PDA.
    #[account(
        mut,
        constraint = lp_mint.mint_authority.unwrap() == lp_mint_authority.key() @ VaultError::InvalidLpMint,
        constraint = lp_mint.supply == 0 @ VaultError::InvalidLpMint,
    )]
    pub lp_mint: Account<'info, SplMint>,

    /// CHECK: PDA authority for LP mint
    #[account(seeds = [b"lp_mint_auth", vault.key().as_ref()], bump)]
    pub lp_mint_authority: UncheckedAccount<'info>,

    /// Vault's token account for the asset (Token-2022 ATA)
    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = vault_asset_authority,
        token::token_program = asset_token_program,
    )]
    pub vault_asset_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// CHECK: PDA authority for vault asset account
    #[account(seeds = [b"vault_asset_auth", vault.key().as_ref()], bump)]
    pub vault_asset_authority: UncheckedAccount<'info>,

    /// CHECK: Token program for the asset (Token-2022)
    pub asset_token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = vault.is_active @ VaultError::VaultInactive,
    )]
    pub vault: Account<'info, Vault>,

    /// User's asset token account (Token-2022)
    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = user,
        token::token_program = asset_token_program,
    )]
    pub user_asset_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// Vault's asset token account (Token-2022)
    #[account(
        mut,
        constraint = vault_asset_account.key() == vault.vault_asset_account @ VaultError::InvalidAccount,
    )]
    pub vault_asset_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    pub asset_mint: InterfaceAccount<'info, InterfaceMint>,

    /// LP mint (regular SPL Token)
    #[account(
        mut,
        constraint = lp_mint.key() == vault.lp_mint @ VaultError::InvalidLpMint,
    )]
    pub lp_mint: Account<'info, SplMint>,

    /// CHECK: LP mint authority PDA
    #[account(seeds = [b"lp_mint_auth", vault.key().as_ref()], bump)]
    pub lp_mint_authority: UncheckedAccount<'info>,

    /// User's LP token account
    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = user,
    )]
    pub user_lp_account: Account<'info, SplTokenAccount>,

    /// CHECK: Token program for asset (Token-2022)
    pub asset_token_program: UncheckedAccount<'info>,

    pub lp_token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InstantWithdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// User's asset token account (Token-2022)
    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = user,
        token::token_program = asset_token_program,
    )]
    pub user_asset_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// Vault's asset token account
    #[account(
        mut,
        constraint = vault_asset_account.key() == vault.vault_asset_account @ VaultError::InvalidAccount,
    )]
    pub vault_asset_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// CHECK: PDA authority for vault asset account
    #[account(seeds = [b"vault_asset_auth", vault.key().as_ref()], bump)]
    pub vault_asset_authority: UncheckedAccount<'info>,

    pub asset_mint: InterfaceAccount<'info, InterfaceMint>,

    #[account(
        mut,
        constraint = lp_mint.key() == vault.lp_mint @ VaultError::InvalidLpMint,
    )]
    pub lp_mint: Account<'info, SplMint>,

    /// User's LP token account
    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = user,
    )]
    pub user_lp_account: Account<'info, SplTokenAccount>,

    /// CHECK: Token program for asset (Token-2022)
    pub asset_token_program: UncheckedAccount<'info>,

    pub lp_token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AddStrategy<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = admin,
        space = 8 + Strategy::INIT_SPACE,
        seeds = [b"strategy", vault.key().as_ref(), &[vault.num_strategies]],
        bump,
    )]
    pub strategy: Account<'info, Strategy>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Allocate<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        constraint = strategy.vault == vault.key() @ VaultError::InvalidStrategy,
        constraint = strategy.is_active @ VaultError::StrategyInactive,
    )]
    pub strategy: Account<'info, Strategy>,
}

#[derive(Accounts)]
pub struct ReportYield<'info> {
    pub manager: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        constraint = strategy.vault == vault.key() @ VaultError::InvalidStrategy,
    )]
    pub strategy: Account<'info, Strategy>,
}

#[derive(Accounts)]
pub struct HarvestFees<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        constraint = lp_mint.key() == vault.lp_mint @ VaultError::InvalidLpMint,
    )]
    pub lp_mint: Account<'info, SplMint>,

    /// CHECK: LP mint authority PDA
    #[account(seeds = [b"lp_mint_auth", vault.key().as_ref()], bump)]
    pub lp_mint_authority: UncheckedAccount<'info>,

    /// Admin's LP token account to receive fee LP tokens
    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = admin,
    )]
    pub admin_lp_account: Account<'info, SplTokenAccount>,

    pub lp_token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RemoveStrategy<'info> {
    pub admin: Signer<'info>,

    #[account(constraint = vault.admin == admin.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        constraint = strategy.vault == vault.key() @ VaultError::InvalidStrategy,
    )]
    pub strategy: Account<'info, Strategy>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, Vault>,
}

// --- State ---

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Vault name
    pub name: [u8; 32],
    /// Admin authority (structural control, fees, strategies)
    pub admin: Pubkey,
    /// Manager authority (fund allocation, rebalancing)
    pub manager: Pubkey,
    /// Asset mint (e.g., fUSD Token-2022)
    pub asset_mint: Pubkey,
    /// LP token mint
    pub lp_mint: Pubkey,
    /// Vault's token account for the asset
    pub vault_asset_account: Pubkey,
    /// Total assets (idle + all strategies)
    pub total_assets: u64,
    /// Assets sitting idle in vault
    pub idle_assets: u64,
    /// Total LP tokens outstanding
    pub lp_supply: u64,
    /// Maximum deposit cap
    pub max_cap: u64,
    /// Performance fee in basis points
    pub performance_fee_bps: u16,
    /// Annual management fee in basis points
    pub management_fee_bps: u16,
    /// Deposit fee in basis points
    pub deposit_fee_bps: u16,
    /// Withdrawal fee in basis points
    pub withdrawal_fee_bps: u16,
    /// Seconds for locked profit to fully unlock (anti-sandwich)
    pub locked_profit_degradation: u64,
    /// Seconds to wait before withdrawal execution
    pub withdrawal_wait_period: u64,
    /// High water mark for performance fees (asset_per_lp * PRECISION)
    pub high_water_mark: u128,
    /// Last fee harvest timestamp
    pub last_fee_harvest_ts: i64,
    /// Currently locked profit amount
    pub locked_profit: u64,
    /// Timestamp when profit was locked
    pub locked_profit_ts: i64,
    /// Number of strategies
    pub num_strategies: u8,
    /// Total accumulated fees (in asset units)
    pub accumulated_fees: u64,
    /// Whether the vault accepts deposits
    pub is_active: bool,
    /// PDA bump
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Strategy {
    /// The vault this strategy belongs to
    pub vault: Pubkey,
    /// Strategy index within the vault
    pub index: u8,
    /// Strategy name
    pub name: [u8; 32],
    /// Target protocol name
    pub protocol: [u8; 32],
    /// Current position value in this strategy
    pub position_value: u64,
    /// Total amount ever allocated
    pub allocated: u64,
    /// Whether this strategy is active
    pub is_active: bool,
    /// Last update timestamp
    pub last_update_ts: i64,
    /// PDA bump
    pub bump: u8,
}

// --- Config ---

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct VaultConfig {
    pub max_cap: u64,
    pub performance_fee_bps: u16,
    pub management_fee_bps: u16,
    pub deposit_fee_bps: u16,
    pub withdrawal_fee_bps: u16,
    /// Seconds for locked profit degradation (e.g., 86400 = 24h)
    pub locked_profit_degradation: u64,
    /// Seconds to wait before withdrawal (0 = instant)
    pub withdrawal_wait_period: u64,
}

// --- Errors ---

#[error_code]
pub enum VaultError {
    #[msg("Vault name exceeds 32 characters")]
    NameTooLong,
    #[msg("Fee exceeds maximum allowed")]
    FeeTooHigh,
    #[msg("Vault is not active")]
    VaultInactive,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deposit would exceed vault max cap")]
    MaxCapExceeded,
    #[msg("Calculated LP tokens is zero")]
    ZeroLpTokens,
    #[msg("Insufficient idle assets for withdrawal")]
    InsufficientIdle,
    #[msg("Instant withdrawal not allowed (vault has waiting period)")]
    InstantWithdrawNotAllowed,
    #[msg("Caller is not authorized")]
    Unauthorized,
    #[msg("Maximum number of strategies reached")]
    MaxStrategies,
    #[msg("Strategy is not active")]
    StrategyInactive,
    #[msg("Invalid account")]
    InvalidAccount,
    #[msg("Invalid LP mint")]
    InvalidLpMint,
    #[msg("Invalid strategy")]
    InvalidStrategy,
    #[msg("Strategy must have zero position to remove")]
    StrategyNotEmpty,
    #[msg("Insufficient strategy balance")]
    InsufficientStrategyBalance,
}
