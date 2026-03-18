// SPDX-License-Identifier: BUSL-1.1
use anchor_lang::{
    prelude::*,
    system_program::{create_account, CreateAccount},
};
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_token_2022::extension::BaseStateWithExtensions;
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

declare_id!("55NYv5kunygtJdiMuFVPzjXnUXEt24h4DHMXJW7wCUSM");

/// Number of extra accounts the transfer hook requires:
/// 1. KYC Registry (global config)
/// 2. Source wallet KYC status PDA
/// 3. Destination wallet KYC status PDA
const EXTRA_ACCOUNT_COUNT: usize = 3;

#[program]
pub mod kyc_hook {
    use super::*;

    /// Initialize the KYC registry - one-time setup per stablecoin mint.
    /// Sets the admin authority who can verify/revoke KYC status.
    pub fn initialize_registry(
        ctx: Context<InitializeRegistry>,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.mint = ctx.accounts.mint.key();
        registry.total_verified = 0;
        registry.bump = ctx.bumps.registry;
        msg!("KYC Registry initialized for mint: {}", registry.mint);
        Ok(())
    }

    /// Initialize the ExtraAccountMetaList for the transfer hook.
    /// This tells Token-2022 which additional accounts the hook needs on every transfer.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let extra_account_metas = vec![
            // Extra account #1: KYC Registry PDA (global config)
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"kyc-registry".to_vec() },
                    Seed::AccountKey { index: 1 }, // mint key at index 1
                ],
                false, // is_signer
                false, // is_writable
            )?,
            // Extra account #2: Source wallet KYC status PDA
            // Derived from: ["kyc-status", source_token_account.owner]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"kyc-status".to_vec() },
                    Seed::AccountData {
                        account_index: 0, // source token account (index 0)
                        data_index: 32,   // owner field offset in token account
                        length: 32,       // pubkey length
                    },
                ],
                false,
                false,
            )?,
            // Extra account #3: Destination wallet KYC status PDA
            // Derived from: ["kyc-status", dest_token_account.owner]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"kyc-status".to_vec() },
                    Seed::AccountData {
                        account_index: 2, // destination token account (index 2)
                        data_index: 32,   // owner field offset
                        length: 32,
                    },
                ],
                false,
                false,
            )?,
        ];

        // Calculate space and create the ExtraAccountMetaList account
        let account_size = ExtraAccountMetaList::size_of(extra_account_metas.len())? as u64;
        let lamports = Rent::get()?.minimum_balance(account_size as usize);
        let mint_key = ctx.accounts.mint.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"extra-account-metas",
            mint_key.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ]];

        create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
            )
            .with_signer(signer_seeds),
            lamports,
            account_size,
            ctx.program_id,
        )?;

        // Write the extra account metas into the account
        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &extra_account_metas,
        )?;

        msg!("ExtraAccountMetaList initialized for mint: {}", mint_key);
        Ok(())
    }

    /// The transfer hook - called by Token-2022 on EVERY transfer.
    /// Verifies both sender and receiver are KYC-verified.
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        // Verify this is actually being called during a Token-2022 transfer
        check_is_transferring(&ctx.accounts.source_token)?;

        // Check source wallet KYC
        let source_kyc = &ctx.accounts.source_kyc_status;
        require!(
            source_kyc.is_verified,
            KycError::SourceNotVerified
        );

        // Check KYC expiration for source
        if source_kyc.expires_at > 0 {
            let clock = Clock::get()?;
            require!(
                clock.unix_timestamp < source_kyc.expires_at,
                KycError::SourceKycExpired
            );
        }

        // Check destination wallet KYC
        let dest_kyc = &ctx.accounts.destination_kyc_status;
        require!(
            dest_kyc.is_verified,
            KycError::DestinationNotVerified
        );

        // Check KYC expiration for destination
        if dest_kyc.expires_at > 0 {
            let clock = Clock::get()?;
            require!(
                clock.unix_timestamp < dest_kyc.expires_at,
                KycError::DestinationKycExpired
            );
        }

        msg!(
            "KYC verified: transfer of {} tokens approved",
            amount
        );
        Ok(())
    }

    /// Set KYC verification status for a wallet. Only callable by registry authority.
    pub fn set_kyc_status(
        ctx: Context<SetKycStatus>,
        is_verified: bool,
        expires_at: i64, // -1 for never expires, otherwise unix timestamp
    ) -> Result<()> {
        // Verify caller is the registry authority
        require!(
            ctx.accounts.authority.key() == ctx.accounts.registry.authority,
            KycError::UnauthorizedAuthority
        );

        let kyc_status = &mut ctx.accounts.kyc_status;
        let was_verified = kyc_status.is_verified;
        kyc_status.is_verified = is_verified;
        kyc_status.wallet = ctx.accounts.user.key();
        kyc_status.verified_at = Clock::get()?.unix_timestamp;
        kyc_status.expires_at = expires_at;
        kyc_status.verified_by = ctx.accounts.authority.key();
        kyc_status.bump = ctx.bumps.kyc_status;

        // Update registry counter
        let registry = &mut ctx.accounts.registry;
        if is_verified && !was_verified {
            registry.total_verified = registry.total_verified.saturating_add(1);
        } else if !is_verified && was_verified {
            registry.total_verified = registry.total_verified.saturating_sub(1);
        }

        msg!(
            "KYC status for {} set to: verified={}, expires_at={}",
            kyc_status.wallet,
            is_verified,
            expires_at
        );
        Ok(())
    }

    /// Transfer registry authority to a new admin.
    pub fn transfer_authority(
        ctx: Context<TransferAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.registry.authority,
            KycError::UnauthorizedAuthority
        );
        ctx.accounts.registry.authority = new_authority;
        msg!("Registry authority transferred to: {}", new_authority);
        Ok(())
    }

    /// Fallback handler for the SPL Transfer Hook Execute interface.
    /// Token-2022 calls this via CPI on every transfer.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)?;

        match instruction {
            TransferHookInstruction::Execute { amount } => {
                // Account layout from Token-2022:
                // 0: source token account, 1: mint, 2: dest token account,
                // 3: owner, 4: ExtraAccountMetaList, 5: kyc_registry,
                // 6: source_kyc_status, 7: dest_kyc_status
                if accounts.len() < 8 {
                    return Err(ProgramError::NotEnoughAccountKeys.into());
                }

                // Verify transferring flag
                {
                    let source_data = accounts[0].try_borrow_data()?;
                    let source = spl_token_2022::extension::PodStateWithExtensions::<
                        spl_token_2022::pod::PodAccount,
                    >::unpack(&source_data)?;
                    let hook_ext = source.get_extension::<
                        spl_token_2022::extension::transfer_hook::TransferHookAccount,
                    >()?;
                    if !bool::from(hook_ext.transferring) {
                        return err!(KycError::NotTransferring);
                    }
                }

                // Check source KYC (index 6): skip 8-byte discriminator, byte 0 = is_verified
                let source_kyc = accounts[6].try_borrow_data()?;
                if source_kyc.len() < 9 || source_kyc[8] != 1 {
                    return err!(KycError::SourceNotVerified);
                }

                // Check dest KYC (index 7)
                let dest_kyc = accounts[7].try_borrow_data()?;
                if dest_kyc.len() < 9 || dest_kyc[8] != 1 {
                    return err!(KycError::DestinationNotVerified);
                }

                msg!("KYC verified: transfer of {} tokens approved", amount);
                Ok(())
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}

// --- Helper Functions ---

fn check_is_transferring(source_token: &InterfaceAccount<TokenAccount>) -> Result<()> {
    let source_token_info = source_token.to_account_info();
    let account_data = source_token_info.try_borrow_data()?;
    let account = spl_token_2022::extension::PodStateWithExtensions::<
        spl_token_2022::pod::PodAccount,
    >::unpack(&account_data)?;
    let extension = account
        .get_extension::<spl_token_2022::extension::transfer_hook::TransferHookAccount>()?;
    if !bool::from(extension.transferring) {
        return err!(KycError::NotTransferring);
    }
    Ok(())
}

// --- Account Structs ---

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + KycRegistry::INIT_SPACE,
        seeds = [b"kyc-registry", mint.key().as_ref()],
        bump,
    )]
    pub registry: Account<'info, KycRegistry>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Validated by seeds constraint. Created in this instruction.
    #[account(
        mut,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferHook<'info> {
    // Index 0: Source token account (read-only, from Token-2022)
    #[account(
        token::mint = mint,
        token::token_program = anchor_spl::token_2022::ID,
    )]
    pub source_token: InterfaceAccount<'info, TokenAccount>,

    // Index 1: Mint
    pub mint: InterfaceAccount<'info, Mint>,

    // Index 2: Destination token account (read-only, from Token-2022)
    #[account(
        token::mint = mint,
        token::token_program = anchor_spl::token_2022::ID,
    )]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,

    // Index 3: Owner/Authority (read-only, signer privileges dropped by Token-2022)
    /// CHECK: Passed by Token-2022, owner of source token account
    pub owner: UncheckedAccount<'info>,

    // Index 4: ExtraAccountMetaList PDA
    /// CHECK: Validated by seeds
    #[account(
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    // --- Extra accounts defined in ExtraAccountMetaList ---

    // Index 5: KYC Registry
    #[account(
        seeds = [b"kyc-registry", mint.key().as_ref()],
        bump = kyc_registry.bump,
    )]
    pub kyc_registry: Account<'info, KycRegistry>,

    // Index 6: Source wallet KYC status
    #[account(
        seeds = [b"kyc-status", source_token.owner.as_ref()],
        bump = source_kyc_status.bump,
    )]
    pub source_kyc_status: Account<'info, KycStatus>,

    // Index 7: Destination wallet KYC status
    #[account(
        seeds = [b"kyc-status", destination_token.owner.as_ref()],
        bump = destination_kyc_status.bump,
    )]
    pub destination_kyc_status: Account<'info, KycStatus>,
}

#[derive(Accounts)]
pub struct SetKycStatus<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"kyc-registry", registry.mint.as_ref()],
        bump = registry.bump,
    )]
    pub registry: Account<'info, KycRegistry>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + KycStatus::INIT_SPACE,
        seeds = [b"kyc-status", user.key().as_ref()],
        bump,
    )]
    pub kyc_status: Account<'info, KycStatus>,

    /// CHECK: The wallet whose KYC status is being set
    pub user: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"kyc-registry", registry.mint.as_ref()],
        bump = registry.bump,
    )]
    pub registry: Account<'info, KycRegistry>,
}

// --- State ---

#[account]
#[derive(InitSpace)]
pub struct KycRegistry {
    /// Authority who can set/revoke KYC status
    pub authority: Pubkey,
    /// The stablecoin mint this registry controls
    pub mint: Pubkey,
    /// Total number of verified wallets
    pub total_verified: u64,
    /// PDA bump
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct KycStatus {
    /// Whether this wallet is KYC verified
    pub is_verified: bool,
    /// The wallet address
    pub wallet: Pubkey,
    /// When KYC was verified (unix timestamp)
    pub verified_at: i64,
    /// When KYC expires (-1 = never, otherwise unix timestamp)
    pub expires_at: i64,
    /// Authority who verified this wallet
    pub verified_by: Pubkey,
    /// PDA bump
    pub bump: u8,
}

// --- Errors ---

#[error_code]
pub enum KycError {
    #[msg("Source wallet is not KYC verified")]
    SourceNotVerified,
    #[msg("Destination wallet is not KYC verified")]
    DestinationNotVerified,
    #[msg("Source wallet KYC has expired")]
    SourceKycExpired,
    #[msg("Destination wallet KYC has expired")]
    DestinationKycExpired,
    #[msg("Caller is not the KYC registry authority")]
    UnauthorizedAuthority,
    #[msg("Not being called during a Token-2022 transfer")]
    NotTransferring,
}
