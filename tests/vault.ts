import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  AccountState,
  createInitializeMintInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintCloseAuthorityInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMintToInstruction,
  createMint,
  thawAccount,
  getAccount,
  getMint,
  createThawAccountInstruction,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import { assert } from "chai";

describe("Vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const vaultProgram = anchor.workspace.Vault as Program;
  const kycProgram = anchor.workspace.KycHook as Program;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const DECIMALS = 6;
  const VAULT_NAME = "TestVault";

  // Keypairs
  const fUsdMintKeypair = Keypair.generate();
  const manager = Keypair.generate();
  const depositor = Keypair.generate();

  // PDAs
  let vaultPda: PublicKey;
  let vaultBump: number;
  let lpMintAuthority: PublicKey;
  let vaultAssetAuth: PublicKey;
  let lpMint: PublicKey;
  let lpMintKeypair: Keypair;
  let vaultAssetAccount: PublicKey;

  function findVaultPda(admin: PublicKey, name: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), admin.toBuffer(), Buffer.from(name)],
      vaultProgram.programId
    );
  }

  function findLpMintAuth(vault: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint_auth"), vault.toBuffer()],
      vaultProgram.programId
    );
  }

  function findVaultAssetAuth(vault: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault_asset_auth"), vault.toBuffer()],
      vaultProgram.programId
    );
  }

  function findStrategyPda(
    vault: PublicKey,
    index: number
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("strategy"), vault.toBuffer(), Buffer.from([index])],
      vaultProgram.programId
    );
  }

  function findKycRegistryPda(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("kyc-registry"), mint.toBuffer()],
      kycProgram.programId
    );
  }

  function findKycStatusPda(user: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("kyc-status"), user.toBuffer()],
      kycProgram.programId
    );
  }

  function findExtraAccountMetaListPda(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint.toBuffer()],
      kycProgram.programId
    );
  }

  before(async () => {
    // Airdrop SOL
    for (const kp of [manager, depositor]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Compute PDAs
    [vaultPda, vaultBump] = findVaultPda(payer.publicKey, VAULT_NAME);
    [lpMintAuthority] = findLpMintAuth(vaultPda);
    [vaultAssetAuth] = findVaultAssetAuth(vaultPda);
  });

  // ──────────────────────────────────────────────────
  // Step 1: Create Token-2022 fUSD mint with KYC hook
  // ──────────────────────────────────────────────────
  it("Creates fUSD Token-2022 mint with KYC extensions", async () => {
    const extensions = [
      ExtensionType.PermanentDelegate,
      ExtensionType.TransferHook,
      ExtensionType.MetadataPointer,
      ExtensionType.MintCloseAuthority,
    ];

    const metadata = {
      mint: fUsdMintKeypair.publicKey,
      name: "FLUF Stablecoin",
      symbol: "fUSD",
      uri: "https://fluf.finance/fusd.json",
      additionalMetadata: [] as [string, string][],
    };

    const mintLen = getMintLen(extensions);
    const metadataLen = pack(metadata).length;
    const lamports =
      await provider.connection.getMinimumBalanceForRentExemption(
        mintLen + metadataLen + 4
      );

    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: fUsdMintKeypair.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializePermanentDelegateInstruction(
        fUsdMintKeypair.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeTransferHookInstruction(
        fUsdMintKeypair.publicKey,
        payer.publicKey,
        kycProgram.programId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMetadataPointerInstruction(
        fUsdMintKeypair.publicKey,
        payer.publicKey,
        fUsdMintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintCloseAuthorityInstruction(
        fUsdMintKeypair.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        fUsdMintKeypair.publicKey,
        DECIMALS,
        payer.publicKey,
        null, // no freeze authority needed without DefaultAccountState
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        mint: fUsdMintKeypair.publicKey,
        metadata: fUsdMintKeypair.publicKey,
        mintAuthority: payer.publicKey,
        name: "FLUF Stablecoin",
        symbol: "fUSD",
        uri: "https://fluf.finance/fusd.json",
        updateAuthority: payer.publicKey,
      })
    );

    await provider.sendAndConfirm(tx, [fUsdMintKeypair]);
    console.log(`    fUSD mint: ${fUsdMintKeypair.publicKey.toBase58()}`);
  });

  // ──────────────────────────────────────────────────
  // Step 2: Initialize KYC infrastructure
  // ──────────────────────────────────────────────────
  it("Initializes KYC registry and ExtraAccountMetaList", async () => {
    const [registry] = findKycRegistryPda(fUsdMintKeypair.publicKey);
    const [extraMetas] = findExtraAccountMetaListPda(fUsdMintKeypair.publicKey);

    await kycProgram.methods
      .initializeRegistry()
      .accounts({
        authority: payer.publicKey,
        registry,
        mint: fUsdMintKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await kycProgram.methods
      .initializeExtraAccountMetaList()
      .accounts({
        payer: payer.publicKey,
        extraAccountMetaList: extraMetas,
        mint: fUsdMintKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("    KYC registry + ExtraAccountMetaList initialized");
  });

  // ──────────────────────────────────────────────────
  // Step 3: KYC-verify the vault PDA and the depositor
  // ──────────────────────────────────────────────────
  it("KYC-verifies the vault asset authority PDA and the depositor", async () => {
    const [registry] = findKycRegistryPda(fUsdMintKeypair.publicKey);

    // Verify vault asset auth PDA
    const [vaultKycStatus] = findKycStatusPda(vaultAssetAuth);
    await kycProgram.methods
      .setKycStatus(true, new BN(-1))
      .accounts({
        authority: payer.publicKey,
        registry,
        kycStatus: vaultKycStatus,
        user: vaultAssetAuth,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("    Vault PDA KYC verified");

    // Verify depositor
    const [depositorKycStatus] = findKycStatusPda(depositor.publicKey);
    await kycProgram.methods
      .setKycStatus(true, new BN(-1))
      .accounts({
        authority: payer.publicKey,
        registry,
        kycStatus: depositorKycStatus,
        user: depositor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("    Depositor KYC verified");

    // Also verify payer (mint authority)
    const [payerKycStatus] = findKycStatusPda(payer.publicKey);
    await kycProgram.methods
      .setKycStatus(true, new BN(-1))
      .accounts({
        authority: payer.publicKey,
        registry,
        kycStatus: payerKycStatus,
        user: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("    Payer KYC verified");
  });

  // ──────────────────────────────────────────────────
  // Step 4: Create vault
  // ──────────────────────────────────────────────────
  it("Creates LP mint and initializes vault", async () => {
    // Create LP mint with authority = PDA
    lpMintKeypair = Keypair.generate();
    lpMint = await createMint(
      provider.connection,
      payer,
      lpMintAuthority,
      null,
      6,
      lpMintKeypair,
      undefined,
      TOKEN_PROGRAM_ID
    );
    console.log(`    LP Mint: ${lpMint.toBase58()}`);

    // Create vault asset account (Token-2022 ATA owned by PDA)
    vaultAssetAccount = getAssociatedTokenAddressSync(
      fUsdMintKeypair.publicKey,
      vaultAssetAuth,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        vaultAssetAccount,
        vaultAssetAuth,
        fUsdMintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createAtaTx);

    // Initialize vault
    const config = {
      maxCap: new BN("18446744073709551615"),
      performanceFeeBps: 1000,
      managementFeeBps: 50,
      depositFeeBps: 0,
      withdrawalFeeBps: 0,
      lockedProfitDegradation: new BN(86400),
      withdrawalWaitPeriod: new BN(0),
    };

    await vaultProgram.methods
      .initializeVault(VAULT_NAME, config)
      .accounts({
        admin: payer.publicKey,
        manager: manager.publicKey,
        vault: vaultPda,
        assetMint: fUsdMintKeypair.publicKey,
        lpMint,
        lpMintAuthority,
        vaultAssetAccount,
        vaultAssetAuthority: vaultAssetAuth,
        assetTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultAccount = await vaultProgram.account.vault.fetch(vaultPda);
    assert.equal(
      (vaultAccount as any).admin.toBase58(),
      payer.publicKey.toBase58()
    );
    assert.equal(
      (vaultAccount as any).manager.toBase58(),
      manager.publicKey.toBase58()
    );
    assert.equal((vaultAccount as any).totalAssets.toNumber(), 0);
    console.log(`    Vault initialized: ${vaultPda.toBase58()}`);
  });

  // ──────────────────────────────────────────────────
  // Step 5: Mint fUSD to depositor and create LP account
  // ──────────────────────────────────────────────────
  it("Mints fUSD to depositor and creates LP token account", async () => {
    // Create depositor's fUSD ATA
    const depositorFusd = getAssociatedTokenAddressSync(
      fUsdMintKeypair.publicKey,
      depositor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    // Create ATA
    const mintAmount = 10_000 * 10 ** DECIMALS;
    try {
      const createAtaTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          depositorFusd,
          depositor.publicKey,
          fUsdMintKeypair.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      const ataSig = await sendAndConfirmTransaction(provider.connection, createAtaTx, [payer]);
      console.log(`    ATA created: ${ataSig.slice(0, 20)}...`);
    } catch (e: any) {
      console.log(`    ATA creation error: ${e.message?.slice(0, 200)}`);
      if (e.logs) console.log("    Logs:", e.logs.slice(0, 5));
      throw e;
    }

    // Mint tokens
    try {
      const mintTx = new Transaction().add(
        createMintToInstruction(
          fUsdMintKeypair.publicKey,
          depositorFusd,
          payer.publicKey,
          BigInt(mintAmount),
          [],
          TOKEN_2022_PROGRAM_ID
        )
      );
      const mintSig = await sendAndConfirmTransaction(provider.connection, mintTx, [payer]);
      console.log(`    Mint tx: ${mintSig.slice(0, 20)}...`);
    } catch (e: any) {
      console.log(`    Mint error: ${e.message?.slice(0, 200)}`);
      if (e.logs) console.log("    Logs:", e.logs.slice(0, 5));
      throw e;
    }

    // Read raw balance
    const rawAccount = await provider.connection.getAccountInfo(depositorFusd);
    console.log(`    Account owner: ${rawAccount?.owner.toBase58()}`);
    console.log(`    Account size: ${rawAccount?.data.length}`);

    const balance = await provider.connection.getTokenAccountBalance(depositorFusd);
    console.log(`    Token balance: ${balance.value.amount}`);
    assert.equal(Number(balance.value.amount), mintAmount);

    // Create depositor's LP token ATA (regular SPL Token)
    const depositorLp = getAssociatedTokenAddressSync(
      lpMint,
      depositor.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const createLpAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        depositorLp,
        depositor.publicKey,
        lpMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createLpAtaTx);

    console.log("    Depositor funded with 10,000 fUSD + LP account created");
  });

  // ──────────────────────────────────────────────────
  // Step 6: Deposit fUSD into vault
  // ──────────────────────────────────────────────────
  it("Deposits 5000 fUSD into vault and receives LP tokens", async () => {
    const depositAmount = 5000 * 10 ** DECIMALS;

    const depositorFusd = getAssociatedTokenAddressSync(
      fUsdMintKeypair.publicKey,
      depositor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const depositorLp = getAssociatedTokenAddressSync(
      lpMint,
      depositor.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Build remaining accounts for the transfer hook
    const [extraMetas] = findExtraAccountMetaListPda(fUsdMintKeypair.publicKey);
    const [kycRegistry] = findKycRegistryPda(fUsdMintKeypair.publicKey);
    const [sourceKyc] = findKycStatusPda(depositor.publicKey);
    const [destKyc] = findKycStatusPda(vaultAssetAuth);

    const remainingAccounts = [
      // Extra account meta list (must be first)
      { pubkey: extraMetas, isSigner: false, isWritable: false },
      // Extra accounts from the list (in order defined)
      { pubkey: kycRegistry, isSigner: false, isWritable: false },
      { pubkey: sourceKyc, isSigner: false, isWritable: false },
      { pubkey: destKyc, isSigner: false, isWritable: false },
      // Hook program must be LAST
      { pubkey: kycProgram.programId, isSigner: false, isWritable: false },
    ];

    await vaultProgram.methods
      .deposit(new BN(depositAmount))
      .accounts({
        user: depositor.publicKey,
        vault: vaultPda,
        userAssetAccount: depositorFusd,
        vaultAssetAccount,
        assetMint: fUsdMintKeypair.publicKey,
        lpMint,
        lpMintAuthority,
        userLpAccount: depositorLp,
        assetTokenProgram: TOKEN_2022_PROGRAM_ID,
        lpTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .signers([depositor])
      .rpc();

    // Verify vault state
    const vaultAccount: any = await vaultProgram.account.vault.fetch(vaultPda);
    assert.equal(vaultAccount.totalAssets.toNumber(), depositAmount);
    assert.equal(vaultAccount.idleAssets.toNumber(), depositAmount);
    assert.equal(vaultAccount.lpSupply.toNumber(), depositAmount); // 1:1 first deposit

    // Verify LP tokens (use getTokenAccountBalance for reliability)
    const lpBalance = await provider.connection.getTokenAccountBalance(depositorLp);
    assert.equal(Number(lpBalance.value.amount), depositAmount);

    console.log(
      `    Deposited 5000 fUSD, received ${Number(lpBalance.value.amount) / 10 ** DECIMALS} LP tokens`
    );
  });

  // ──────────────────────────────────────────────────
  // Step 7: Add strategies
  // ──────────────────────────────────────────────────
  it("Adds two yield strategies", async () => {
    const [strategy0] = findStrategyPda(vaultPda, 0);
    await vaultProgram.methods
      .addStrategy("Drift Lending", "Drift")
      .accounts({
        admin: payer.publicKey,
        vault: vaultPda,
        strategy: strategy0,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const [strategy1] = findStrategyPda(vaultPda, 1);
    await vaultProgram.methods
      .addStrategy("Kamino USDC", "Kamino")
      .accounts({
        admin: payer.publicKey,
        vault: vaultPda,
        strategy: strategy1,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vault: any = await vaultProgram.account.vault.fetch(vaultPda);
    assert.equal(vault.numStrategies, 2);
    console.log("    Added strategies: Drift Lending, Kamino USDC");
  });

  // ──────────────────────────────────────────────────
  // Step 8: Allocate funds to strategies
  // ──────────────────────────────────────────────────
  it("Manager allocates funds across strategies", async () => {
    const allocAmount = 2500 * 10 ** DECIMALS;
    const [strategy0] = findStrategyPda(vaultPda, 0);
    const [strategy1] = findStrategyPda(vaultPda, 1);

    // Allocate 2500 to Drift
    await vaultProgram.methods
      .allocate(new BN(allocAmount))
      .accounts({
        manager: manager.publicKey,
        vault: vaultPda,
        strategy: strategy0,
      })
      .signers([manager])
      .rpc();

    // Allocate 2500 to Kamino
    await vaultProgram.methods
      .allocate(new BN(allocAmount))
      .accounts({
        manager: manager.publicKey,
        vault: vaultPda,
        strategy: strategy1,
      })
      .signers([manager])
      .rpc();

    const vault: any = await vaultProgram.account.vault.fetch(vaultPda);
    assert.equal(vault.idleAssets.toNumber(), 0);

    const s0: any = await vaultProgram.account.strategy.fetch(strategy0);
    assert.equal(s0.positionValue.toNumber(), allocAmount);

    const s1: any = await vaultProgram.account.strategy.fetch(strategy1);
    assert.equal(s1.positionValue.toNumber(), allocAmount);

    console.log("    Allocated 2500 fUSD to each strategy (0 idle)");
  });

  // ──────────────────────────────────────────────────
  // Step 9: Report yield
  // ──────────────────────────────────────────────────
  it("Reports yield on Drift strategy (5% gain)", async () => {
    const [strategy0] = findStrategyPda(vaultPda, 0);
    const currentValue = 2500 * 10 ** DECIMALS;
    const yieldGain = Math.floor(currentValue * 0.05);
    const newValue = currentValue + yieldGain;

    await vaultProgram.methods
      .reportYield(new BN(newValue))
      .accounts({
        manager: manager.publicKey,
        vault: vaultPda,
        strategy: strategy0,
      })
      .signers([manager])
      .rpc();

    const vault: any = await vaultProgram.account.vault.fetch(vaultPda);
    assert.equal(
      vault.totalAssets.toNumber(),
      5000 * 10 ** DECIMALS + yieldGain
    );

    const s0: any = await vaultProgram.account.strategy.fetch(strategy0);
    assert.equal(s0.positionValue.toNumber(), newValue);

    console.log(`    Drift yield reported: +${yieldGain / 10 ** DECIMALS} fUSD`);
    console.log(
      `    Total vault assets: ${vault.totalAssets.toNumber() / 10 ** DECIMALS} fUSD`
    );
  });

  // ──────────────────────────────────────────────────
  // Step 10: Deallocate and withdraw
  // ──────────────────────────────────────────────────
  it("Deallocates from strategies and depositor withdraws", async () => {
    const [strategy0] = findStrategyPda(vaultPda, 0);
    const [strategy1] = findStrategyPda(vaultPda, 1);

    // Deallocate everything from both strategies back to idle
    const s0: any = await vaultProgram.account.strategy.fetch(strategy0);
    const s1: any = await vaultProgram.account.strategy.fetch(strategy1);

    await vaultProgram.methods
      .deallocate(new BN(s0.positionValue))
      .accounts({
        manager: manager.publicKey,
        vault: vaultPda,
        strategy: strategy0,
      })
      .signers([manager])
      .rpc();

    await vaultProgram.methods
      .deallocate(new BN(s1.positionValue))
      .accounts({
        manager: manager.publicKey,
        vault: vaultPda,
        strategy: strategy1,
      })
      .signers([manager])
      .rpc();

    const vaultBefore: any = await vaultProgram.account.vault.fetch(vaultPda);
    console.log(
      `    Deallocated all. Idle: ${vaultBefore.idleAssets.toNumber() / 10 ** DECIMALS} fUSD`
    );

    // Now withdraw all LP tokens
    const depositorLp = getAssociatedTokenAddressSync(
      lpMint,
      depositor.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const depositorFusd = getAssociatedTokenAddressSync(
      fUsdMintKeypair.publicKey,
      depositor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Withdraw a partial amount (the original deposit, not including phantom yield)
    // In production, yield would be real tokens from protocol returns.
    // Here we withdraw the original 5000 fUSD worth of LP tokens.
    const lpBalance = await provider.connection.getTokenAccountBalance(depositorLp);
    const lpAmount = Number(lpBalance.value.amount);

    // Withdraw only what's actually backed by real tokens in the vault
    // Use a partial LP amount that corresponds to 5000 fUSD (original deposit)
    const vaultState: any = await vaultProgram.account.vault.fetch(vaultPda);
    const actualTokens = 5000 * 10 ** DECIMALS; // we know vault only has 5000 real fUSD
    const lpForActualTokens = Math.floor(
      (actualTokens * vaultState.lpSupply.toNumber()) /
        vaultState.totalAssets.toNumber()
    );

    // Build remaining accounts for the transfer hook (vault -> depositor)
    const [extraMetas] = findExtraAccountMetaListPda(fUsdMintKeypair.publicKey);
    const [kycRegistry] = findKycRegistryPda(fUsdMintKeypair.publicKey);
    const [sourceKyc] = findKycStatusPda(vaultAssetAuth); // vault is source
    const [destKyc] = findKycStatusPda(depositor.publicKey); // depositor is dest

    const remainingAccounts = [
      { pubkey: extraMetas, isSigner: false, isWritable: false },
      { pubkey: kycRegistry, isSigner: false, isWritable: false },
      { pubkey: sourceKyc, isSigner: false, isWritable: false },
      { pubkey: destKyc, isSigner: false, isWritable: false },
      // Hook program must be LAST
      { pubkey: kycProgram.programId, isSigner: false, isWritable: false },
    ];

    await vaultProgram.methods
      .instantWithdraw(new BN(lpForActualTokens))
      .accounts({
        user: depositor.publicKey,
        vault: vaultPda,
        userAssetAccount: depositorFusd,
        vaultAssetAccount,
        vaultAssetAuthority: vaultAssetAuth,
        assetMint: fUsdMintKeypair.publicKey,
        lpMint,
        userLpAccount: depositorLp,
        assetTokenProgram: TOKEN_2022_PROGRAM_ID,
        lpTokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .signers([depositor])
      .rpc();

    // Verify
    const vaultAfter: any = await vaultProgram.account.vault.fetch(vaultPda);
    const fusdBalance = await provider.connection.getTokenAccountBalance(depositorFusd);
    const finalFusd = Number(fusdBalance.value.amount);

    console.log(
      `    Withdrew ${finalFusd / 10 ** DECIMALS} fUSD (deposited 5000, + yield)`
    );
    console.log(
      `    Vault remaining: ${vaultAfter.totalAssets.toNumber() / 10 ** DECIMALS} fUSD`
    );

    // Depositor should get back ~5000 fUSD (the original deposit)
    // Total is 5000 (original) + 5000 (remaining from initial 10k mint)
    assert.isAbove(finalFusd, 9000 * 10 ** DECIMALS);
  });
});
