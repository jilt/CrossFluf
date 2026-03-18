import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  ExtensionType,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
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
  createTransferCheckedWithTransferHookInstruction,
  thawAccount,
  getMint,
  getAccount,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import { assert } from "chai";

describe("KYC Stablecoin", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KycHook as Program;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const mintKeypair = Keypair.generate();
  const userA = Keypair.generate(); // KYC verified user
  const userB = Keypair.generate(); // KYC verified user
  const userC = Keypair.generate(); // NOT KYC verified

  const DECIMALS = 6;

  function findKycRegistryPda(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("kyc-registry"), mint.toBuffer()],
      program.programId
    );
  }

  function findKycStatusPda(user: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("kyc-status"), user.toBuffer()],
      program.programId
    );
  }

  function findExtraAccountMetaListPda(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint.toBuffer()],
      program.programId
    );
  }

  before(async () => {
    // Airdrop SOL to test users
    for (const user of [userA, userB, userC]) {
      const sig = await provider.connection.requestAirdrop(
        user.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }
  });

  it("Creates Token-2022 mint with all compliance extensions", async () => {
    const extensions = [
      ExtensionType.DefaultAccountState,
      ExtensionType.PermanentDelegate,
      ExtensionType.TransferHook,
      ExtensionType.MetadataPointer,
      ExtensionType.MintCloseAuthority,
    ];

    const metadata = {
      mint: mintKeypair.publicKey,
      name: "FLUF Stablecoin",
      symbol: "fUSD",
      uri: "https://fluf.finance/fusd-metadata.json",
      additionalMetadata: [] as [string, string][],
    };

    const mintLen = getMintLen(extensions);
    const metadataLen = pack(metadata).length;
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(
      mintLen + metadataLen + 4
    );

    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeDefaultAccountStateInstruction(
        mintKeypair.publicKey,
        AccountState.Frozen,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializePermanentDelegateInstruction(
        mintKeypair.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeTransferHookInstruction(
        mintKeypair.publicKey,
        payer.publicKey,
        program.programId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMetadataPointerInstruction(
        mintKeypair.publicKey,
        payer.publicKey,
        mintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintCloseAuthorityInstruction(
        mintKeypair.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mintKeypair.publicKey,
        DECIMALS,
        payer.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        mint: mintKeypair.publicKey,
        metadata: mintKeypair.publicKey,
        mintAuthority: payer.publicKey,
        name: "FLUF Stablecoin",
        symbol: "fUSD",
        uri: "https://fluf.finance/fusd-metadata.json",
        updateAuthority: payer.publicKey,
      })
    );

    await provider.sendAndConfirm(tx, [mintKeypair]);

    const mintInfo = await getMint(
      provider.connection,
      mintKeypair.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    assert.isTrue(mintInfo.isInitialized);
    assert.equal(mintInfo.decimals, DECIMALS);
    assert.equal(
      mintInfo.mintAuthority?.toBase58(),
      payer.publicKey.toBase58()
    );
    console.log(`    Mint created: ${mintKeypair.publicKey.toBase58()}`);
  });

  it("Initializes KYC Registry", async () => {
    const [registry] = findKycRegistryPda(mintKeypair.publicKey);

    await program.methods
      .initializeRegistry()
      .accounts({
        authority: payer.publicKey,
        registry,
        mint: mintKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const registryAccount = await program.account.kycRegistry.fetch(registry);
    assert.equal(
      registryAccount.authority.toBase58(),
      payer.publicKey.toBase58()
    );
    assert.equal(
      registryAccount.mint.toBase58(),
      mintKeypair.publicKey.toBase58()
    );
    assert.equal(registryAccount.totalVerified.toNumber(), 0);
    console.log(`    Registry initialized: ${registry.toBase58()}`);
  });

  it("Initializes ExtraAccountMetaList for transfer hook", async () => {
    const [extraAccountMetaList] = findExtraAccountMetaListPda(
      mintKeypair.publicKey
    );

    await program.methods
      .initializeExtraAccountMetaList()
      .accounts({
        payer: payer.publicKey,
        extraAccountMetaList,
        mint: mintKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const account = await provider.connection.getAccountInfo(
      extraAccountMetaList
    );
    assert.isNotNull(account);
    console.log(
      `    ExtraAccountMetaList initialized: ${extraAccountMetaList.toBase58()}`
    );
  });

  it("Verifies KYC for user A", async () => {
    const [registry] = findKycRegistryPda(mintKeypair.publicKey);
    const [kycStatus] = findKycStatusPda(userA.publicKey);

    await program.methods
      .setKycStatus(true, new anchor.BN(-1))
      .accounts({
        authority: payer.publicKey,
        registry,
        kycStatus,
        user: userA.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const status = await program.account.kycStatus.fetch(kycStatus);
    assert.isTrue(status.isVerified);
    assert.equal(status.wallet.toBase58(), userA.publicKey.toBase58());

    const registryAccount = await program.account.kycRegistry.fetch(registry);
    assert.equal(registryAccount.totalVerified.toNumber(), 1);
    console.log(`    User A KYC verified: ${userA.publicKey.toBase58()}`);
  });

  it("Verifies KYC for user B", async () => {
    const [registry] = findKycRegistryPda(mintKeypair.publicKey);
    const [kycStatus] = findKycStatusPda(userB.publicKey);

    await program.methods
      .setKycStatus(true, new anchor.BN(-1))
      .accounts({
        authority: payer.publicKey,
        registry,
        kycStatus,
        user: userB.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const status = await program.account.kycStatus.fetch(kycStatus);
    assert.isTrue(status.isVerified);
    console.log(`    User B KYC verified: ${userB.publicKey.toBase58()}`);
  });

  it("Creates token accounts and mints tokens to user A", async () => {
    const ataA = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      userA.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Create ATA (will be frozen by default)
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ataA,
        userA.publicKey,
        mintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createAtaTx);

    // Account should be frozen by default
    let accountInfo = await getAccount(
      provider.connection,
      ataA,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    assert.isTrue(accountInfo.isFrozen);
    console.log("    ATA created (frozen by default)");

    // Thaw account (user A is KYC verified)
    await thawAccount(
      provider.connection,
      payer,
      ataA,
      mintKeypair.publicKey,
      payer,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Verify thawed
    accountInfo = await getAccount(
      provider.connection,
      ataA,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    assert.isFalse(accountInfo.isFrozen);
    console.log("    ATA thawed after KYC verification");

    // Mint 1000 fUSD to user A
    const mintTx = new Transaction().add(
      createMintToInstruction(
        mintKeypair.publicKey,
        ataA,
        payer.publicKey,
        BigInt(1000 * 10 ** DECIMALS),
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(mintTx);

    accountInfo = await getAccount(
      provider.connection,
      ataA,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal(Number(accountInfo.amount), 1000 * 10 ** DECIMALS);
    console.log("    Minted 1000 fUSD to user A");
  });

  it("Creates and thaws token account for user B", async () => {
    const ataB = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      userB.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ataB,
        userB.publicKey,
        mintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createAtaTx);

    await thawAccount(
      provider.connection,
      payer,
      ataB,
      mintKeypair.publicKey,
      payer,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    console.log("    User B ATA created and thawed");
  });

  it("Transfers tokens from KYC user A to KYC user B (hook allows)", async () => {
    const ataA = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      userA.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const ataB = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      userB.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const amount = BigInt(100 * 10 ** DECIMALS); // 100 fUSD

    const transferIx =
      await createTransferCheckedWithTransferHookInstruction(
        provider.connection,
        ataA,
        mintKeypair.publicKey,
        ataB,
        userA.publicKey,
        amount,
        DECIMALS,
        [],
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      );

    const tx = new Transaction().add(transferIx);
    await provider.sendAndConfirm(tx, [userA]);

    const accountB = await getAccount(
      provider.connection,
      ataB,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal(Number(accountB.amount), 100 * 10 ** DECIMALS);
    console.log("    Transferred 100 fUSD from A to B (KYC hook passed)");
  });

  it("Fails transfer to non-KYC user C (hook rejects)", async () => {
    // Create and thaw ATA for user C (they have no KYC status)
    const ataA = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      userA.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const ataC = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      userC.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Create ATA for user C
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ataC,
        userC.publicKey,
        mintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createAtaTx);

    // Thaw so we can attempt transfer (to test hook, not freeze)
    await thawAccount(
      provider.connection,
      payer,
      ataC,
      mintKeypair.publicKey,
      payer,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    try {
      const transferIx =
        await createTransferCheckedWithTransferHookInstruction(
          provider.connection,
          ataA,
          mintKeypair.publicKey,
          ataC,
          userA.publicKey,
          BigInt(10 * 10 ** DECIMALS),
          DECIMALS,
          [],
          "confirmed",
          TOKEN_2022_PROGRAM_ID
        );

      const tx = new Transaction().add(transferIx);
      await provider.sendAndConfirm(tx, [userA]);
      assert.fail("Transfer should have failed - user C has no KYC");
    } catch (e: any) {
      console.log(
        "    Transfer to non-KYC user C correctly rejected by hook"
      );
    }
  });

  it("Revokes KYC for user B and transfer fails", async () => {
    const [registry] = findKycRegistryPda(mintKeypair.publicKey);
    const [kycStatusB] = findKycStatusPda(userB.publicKey);

    // Revoke user B's KYC
    await program.methods
      .setKycStatus(false, new anchor.BN(-1))
      .accounts({
        authority: payer.publicKey,
        registry,
        kycStatus: kycStatusB,
        user: userB.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const status = await program.account.kycStatus.fetch(kycStatusB);
    assert.isFalse(status.isVerified);
    console.log("    User B KYC revoked");

    // Try to transfer from A to B (should fail)
    const ataA = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      userA.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const ataB = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      userB.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    try {
      const transferIx =
        await createTransferCheckedWithTransferHookInstruction(
          provider.connection,
          ataA,
          mintKeypair.publicKey,
          ataB,
          userA.publicKey,
          BigInt(10 * 10 ** DECIMALS),
          DECIMALS,
          [],
          "confirmed",
          TOKEN_2022_PROGRAM_ID
        );

      const tx = new Transaction().add(transferIx);
      await provider.sendAndConfirm(tx, [userA]);
      assert.fail("Transfer should have failed - user B KYC was revoked");
    } catch (e: any) {
      console.log(
        "    Transfer to revoked-KYC user B correctly rejected by hook"
      );
    }
  });
});
