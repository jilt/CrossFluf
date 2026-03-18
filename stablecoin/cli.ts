/**
 * Stablecoin CLI - Token-2022 KYC-Compliant Stablecoin Management
 *
 * Commands:
 *   create-mint       Create a new Token-2022 stablecoin mint with KYC extensions
 *   init-hook         Initialize the transfer hook's ExtraAccountMetaList
 *   init-registry     Initialize the KYC registry for the mint
 *   verify-kyc        Set KYC status for a wallet
 *   revoke-kyc        Revoke KYC status for a wallet
 *   thaw-account      Unfreeze a token account after KYC verification
 *   freeze-account    Freeze a token account
 *   mint-tokens       Mint stablecoin tokens to a verified account
 *   burn-tokens       Burn stablecoin tokens
 *   transfer          Transfer tokens (demonstrates hook enforcement)
 *   info              Display mint and registry info
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
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
  createBurnInstruction,
  createTransferCheckedWithTransferHookInstruction,
  thawAccount,
  freezeAccount,
  getMint,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// --- Configuration ---

const KYC_HOOK_PROGRAM_ID = new PublicKey(
  "55NYv5kunygtJdiMuFVPzjXnUXEt24h4DHMXJW7wCUSM"
);

const STABLECOIN_NAME = "FLUF Stablecoin";
const STABLECOIN_SYMBOL = "fUSD";
const STABLECOIN_URI = "https://fluf.finance/fusd-metadata.json";
const STABLECOIN_DECIMALS = 6;

// --- Helpers ---

function loadKeypair(filePath: string): Keypair {
  const resolved = filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;
  const secretKey = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

function getConnection(cluster: string): Connection {
  const urls: Record<string, string> = {
    localnet: "http://127.0.0.1:8899",
    devnet: "https://api.devnet.solana.com",
    testnet: "https://api.testnet.solana.com",
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
  };
  return new Connection(urls[cluster] || cluster, "confirmed");
}

function findKycRegistryPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("kyc-registry"), mint.toBuffer()],
    KYC_HOOK_PROGRAM_ID
  );
}

function findKycStatusPda(user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("kyc-status"), user.toBuffer()],
    KYC_HOOK_PROGRAM_ID
  );
}

function findExtraAccountMetaListPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    KYC_HOOK_PROGRAM_ID
  );
}

async function loadProgram(
  connection: Connection,
  wallet: Keypair
): Promise<anchor.Program> {
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );
  const idlPath = path.join(
    __dirname,
    "../target/idl/kyc_hook.json"
  );
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  return new anchor.Program(idl, provider);
}

// --- Commands ---

async function createMint(
  connection: Connection,
  payer: Keypair,
  mintKeypairPath?: string
): Promise<PublicKey> {
  console.log("Creating Token-2022 KYC Stablecoin Mint...\n");

  const mintKeypair = mintKeypairPath
    ? loadKeypair(mintKeypairPath)
    : Keypair.generate();

  // Save mint keypair for future use
  const mintKeypairFile = path.join(__dirname, "mint-keypair.json");
  fs.writeFileSync(
    mintKeypairFile,
    JSON.stringify(Array.from(mintKeypair.secretKey))
  );
  console.log(`Mint keypair saved to: ${mintKeypairFile}`);

  const extensions = [
    ExtensionType.DefaultAccountState,
    ExtensionType.PermanentDelegate,
    ExtensionType.TransferHook,
    ExtensionType.MetadataPointer,
    ExtensionType.MintCloseAuthority,
  ];

  const metadata = {
    mint: mintKeypair.publicKey,
    name: STABLECOIN_NAME,
    symbol: STABLECOIN_SYMBOL,
    uri: STABLECOIN_URI,
    additionalMetadata: [
      ["issuer", "FLUF Protocol"],
      ["compliance", "KYC/AML"],
      ["standard", "Token-2022"],
    ] as [string, string][],
  };

  const mintLen = getMintLen(extensions);
  const metadataLen = pack(metadata).length;
  const lamports = await connection.getMinimumBalanceForRentExemption(
    mintLen + metadataLen + 4 // TYPE_SIZE + LENGTH_SIZE
  );

  console.log("Extensions:");
  console.log("  - DefaultAccountState (Frozen)");
  console.log("  - PermanentDelegate");
  console.log("  - TransferHook -> KYC Hook Program");
  console.log("  - MetadataPointer (self-referencing)");
  console.log("  - MintCloseAuthority");
  console.log(`\nMint address: ${mintKeypair.publicKey.toBase58()}`);
  console.log(`Authority: ${payer.publicKey.toBase58()}`);
  console.log(`Hook program: ${KYC_HOOK_PROGRAM_ID.toBase58()}\n`);

  const tx = new Transaction().add(
    // 1. Create account
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // 2. Default frozen state
    createInitializeDefaultAccountStateInstruction(
      mintKeypair.publicKey,
      AccountState.Frozen,
      TOKEN_2022_PROGRAM_ID
    ),
    // 3. Permanent delegate (payer is the compliance authority)
    createInitializePermanentDelegateInstruction(
      mintKeypair.publicKey,
      payer.publicKey,
      TOKEN_2022_PROGRAM_ID
    ),
    // 4. Transfer hook -> KYC program
    createInitializeTransferHookInstruction(
      mintKeypair.publicKey,
      payer.publicKey,
      KYC_HOOK_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID
    ),
    // 5. Metadata pointer (self-referencing)
    createInitializeMetadataPointerInstruction(
      mintKeypair.publicKey,
      payer.publicKey,
      mintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID
    ),
    // 6. Mint close authority
    createInitializeMintCloseAuthorityInstruction(
      mintKeypair.publicKey,
      payer.publicKey,
      TOKEN_2022_PROGRAM_ID
    ),
    // 7. Initialize mint
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      STABLECOIN_DECIMALS,
      payer.publicKey, // mint authority
      payer.publicKey, // freeze authority (REQUIRED for DefaultAccountState)
      TOKEN_2022_PROGRAM_ID
    ),
    // 8. Initialize metadata
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      mint: mintKeypair.publicKey,
      metadata: mintKeypair.publicKey,
      mintAuthority: payer.publicKey,
      name: STABLECOIN_NAME,
      symbol: STABLECOIN_SYMBOL,
      uri: STABLECOIN_URI,
      updateAuthority: payer.publicKey,
    })
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [
    payer,
    mintKeypair,
  ]);
  console.log(`Mint created! Tx: ${sig}`);
  console.log(`\nMint address: ${mintKeypair.publicKey.toBase58()}`);
  return mintKeypair.publicKey;
}

async function initHook(
  connection: Connection,
  payer: Keypair,
  mintPubkey: PublicKey
) {
  console.log("Initializing Transfer Hook ExtraAccountMetaList...\n");

  const program = await loadProgram(connection, payer);
  const [extraAccountMetaList] = findExtraAccountMetaListPda(mintPubkey);

  console.log(`Mint: ${mintPubkey.toBase58()}`);
  console.log(`ExtraAccountMetaList PDA: ${extraAccountMetaList.toBase58()}\n`);

  const tx = await program.methods
    .initializeExtraAccountMetaList()
    .accounts({
      payer: payer.publicKey,
      extraAccountMetaList,
      mint: mintPubkey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`ExtraAccountMetaList initialized! Tx: ${tx}`);
}

async function initRegistry(
  connection: Connection,
  payer: Keypair,
  mintPubkey: PublicKey
) {
  console.log("Initializing KYC Registry...\n");

  const program = await loadProgram(connection, payer);
  const [registry] = findKycRegistryPda(mintPubkey);

  console.log(`Mint: ${mintPubkey.toBase58()}`);
  console.log(`Registry PDA: ${registry.toBase58()}`);
  console.log(`Authority: ${payer.publicKey.toBase58()}\n`);

  const tx = await program.methods
    .initializeRegistry()
    .accounts({
      authority: payer.publicKey,
      registry,
      mint: mintPubkey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`KYC Registry initialized! Tx: ${tx}`);
}

async function verifyKyc(
  connection: Connection,
  authority: Keypair,
  mintPubkey: PublicKey,
  userPubkey: PublicKey,
  expiresAt: number = -1
) {
  console.log(`Setting KYC verified for: ${userPubkey.toBase58()}\n`);

  const program = await loadProgram(connection, authority);
  const [registry] = findKycRegistryPda(mintPubkey);
  const [kycStatus] = findKycStatusPda(userPubkey);

  console.log(`Registry: ${registry.toBase58()}`);
  console.log(`KYC Status PDA: ${kycStatus.toBase58()}\n`);

  const tx = await program.methods
    .setKycStatus(true, new anchor.BN(expiresAt))
    .accounts({
      authority: authority.publicKey,
      registry,
      kycStatus,
      user: userPubkey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`KYC verified! Tx: ${tx}`);

  // Also thaw the user's token account if it exists
  const ata = getAssociatedTokenAddressSync(
    mintPubkey,
    userPubkey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  try {
    const accountInfo = await connection.getAccountInfo(ata);
    if (accountInfo) {
      console.log(`\nThawing token account: ${ata.toBase58()}`);
      await thawAccount(
        connection,
        authority,
        ata,
        mintPubkey,
        authority,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      console.log("Token account thawed!");
    }
  } catch (e) {
    console.log(
      "Note: Token account not found or already thawed. Create it first with mint-tokens."
    );
  }
}

async function revokeKyc(
  connection: Connection,
  authority: Keypair,
  mintPubkey: PublicKey,
  userPubkey: PublicKey
) {
  console.log(`Revoking KYC for: ${userPubkey.toBase58()}\n`);

  const program = await loadProgram(connection, authority);
  const [registry] = findKycRegistryPda(mintPubkey);
  const [kycStatus] = findKycStatusPda(userPubkey);

  const tx = await program.methods
    .setKycStatus(false, new anchor.BN(-1))
    .accounts({
      authority: authority.publicKey,
      registry,
      kycStatus,
      user: userPubkey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`KYC revoked! Tx: ${tx}`);

  // Also freeze the user's token account
  const ata = getAssociatedTokenAddressSync(
    mintPubkey,
    userPubkey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  try {
    await freezeAccount(
      connection,
      authority,
      ata,
      mintPubkey,
      authority,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    console.log("Token account frozen!");
  } catch (e) {
    console.log("Note: Could not freeze token account.");
  }
}

async function mintTokens(
  connection: Connection,
  authority: Keypair,
  mintPubkey: PublicKey,
  recipientPubkey: PublicKey,
  amount: number
) {
  const amountRaw = BigInt(amount * 10 ** STABLECOIN_DECIMALS);
  console.log(
    `Minting ${amount} ${STABLECOIN_SYMBOL} to ${recipientPubkey.toBase58()}\n`
  );

  const ata = getAssociatedTokenAddressSync(
    mintPubkey,
    recipientPubkey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction();

  // Create ATA if it doesn't exist
  const accountInfo = await connection.getAccountInfo(ata);
  if (!accountInfo) {
    console.log(`Creating ATA: ${ata.toBase58()}`);
    tx.add(
      createAssociatedTokenAccountInstruction(
        authority.publicKey,
        ata,
        recipientPubkey,
        mintPubkey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Mint tokens
  tx.add(
    createMintToInstruction(
      mintPubkey,
      ata,
      authority.publicKey,
      amountRaw,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
  console.log(`Minted ${amount} ${STABLECOIN_SYMBOL}! Tx: ${sig}`);
  console.log(`ATA: ${ata.toBase58()}`);
}

async function burnTokens(
  connection: Connection,
  owner: Keypair,
  mintPubkey: PublicKey,
  amount: number
) {
  const amountRaw = BigInt(amount * 10 ** STABLECOIN_DECIMALS);
  console.log(`Burning ${amount} ${STABLECOIN_SYMBOL}\n`);

  const ata = getAssociatedTokenAddressSync(
    mintPubkey,
    owner.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction().add(
    createBurnInstruction(
      ata,
      mintPubkey,
      owner.publicKey,
      amountRaw,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
  console.log(`Burned ${amount} ${STABLECOIN_SYMBOL}! Tx: ${sig}`);
}

async function transferTokens(
  connection: Connection,
  sender: Keypair,
  mintPubkey: PublicKey,
  recipientPubkey: PublicKey,
  amount: number
) {
  const amountRaw = BigInt(amount * 10 ** STABLECOIN_DECIMALS);
  console.log(
    `Transferring ${amount} ${STABLECOIN_SYMBOL} to ${recipientPubkey.toBase58()}\n`
  );
  console.log("Transfer hook will verify KYC for both parties...\n");

  const sourceAta = getAssociatedTokenAddressSync(
    mintPubkey,
    sender.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const destAta = getAssociatedTokenAddressSync(
    mintPubkey,
    recipientPubkey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction();

  // Create destination ATA if needed
  const destAccountInfo = await connection.getAccountInfo(destAta);
  if (!destAccountInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        sender.publicKey,
        destAta,
        recipientPubkey,
        mintPubkey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Transfer with hook - automatically resolves ExtraAccountMeta accounts
  const transferIx = await createTransferCheckedWithTransferHookInstruction(
    connection,
    sourceAta,
    mintPubkey,
    destAta,
    sender.publicKey,
    amountRaw,
    STABLECOIN_DECIMALS,
    [],
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );
  tx.add(transferIx);

  const sig = await sendAndConfirmTransaction(connection, tx, [sender]);
  console.log(`Transfer successful! KYC verified by hook. Tx: ${sig}`);
}

async function showInfo(connection: Connection, mintPubkey: PublicKey) {
  console.log(`=== ${STABLECOIN_NAME} (${STABLECOIN_SYMBOL}) ===\n`);
  console.log(`Mint: ${mintPubkey.toBase58()}`);

  try {
    const mintInfo = await getMint(
      connection,
      mintPubkey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    console.log(`Supply: ${Number(mintInfo.supply) / 10 ** STABLECOIN_DECIMALS} ${STABLECOIN_SYMBOL}`);
    console.log(`Decimals: ${mintInfo.decimals}`);
    console.log(`Mint authority: ${mintInfo.mintAuthority?.toBase58() || "None"}`);
    console.log(`Freeze authority: ${mintInfo.freezeAuthority?.toBase58() || "None"}`);
    console.log(`Is initialized: ${mintInfo.isInitialized}`);
  } catch (e) {
    console.log("Mint not found on-chain. Deploy first.");
  }

  const [registry] = findKycRegistryPda(mintPubkey);
  console.log(`\nKYC Registry PDA: ${registry.toBase58()}`);

  const [extraMetas] = findExtraAccountMetaListPda(mintPubkey);
  console.log(`ExtraAccountMetaList PDA: ${extraMetas.toBase58()}`);
  console.log(`Hook Program: ${KYC_HOOK_PROGRAM_ID.toBase58()}`);
}

// --- CLI ---

const defaultWallet =
  process.env.ANCHOR_WALLET ||
  path.join(os.homedir(), ".config/solana/id.json");
const defaultCluster = process.env.ANCHOR_PROVIDER_URL || "localnet";

yargs(hideBin(process.argv))
  .option("cluster", {
    alias: "c",
    type: "string",
    default: defaultCluster,
    describe: "Solana cluster (localnet, devnet, testnet, mainnet-beta, or URL)",
  })
  .option("wallet", {
    alias: "w",
    type: "string",
    default: defaultWallet,
    describe: "Path to wallet keypair JSON",
  })
  .command(
    "create-mint",
    "Create a new Token-2022 stablecoin mint with KYC extensions",
    (y) =>
      y.option("mint-keypair", {
        type: "string",
        describe: "Path to existing mint keypair (optional)",
      }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      const payer = loadKeypair(argv.wallet);
      await createMint(conn, payer, argv.mintKeypair as string | undefined);
    }
  )
  .command(
    "init-hook <mint>",
    "Initialize the transfer hook ExtraAccountMetaList",
    (y) => y.positional("mint", { type: "string", demandOption: true }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      const payer = loadKeypair(argv.wallet);
      await initHook(conn, payer, new PublicKey(argv.mint!));
    }
  )
  .command(
    "init-registry <mint>",
    "Initialize the KYC registry for a mint",
    (y) => y.positional("mint", { type: "string", demandOption: true }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      const payer = loadKeypair(argv.wallet);
      await initRegistry(conn, payer, new PublicKey(argv.mint!));
    }
  )
  .command(
    "verify-kyc <mint> <user>",
    "Verify KYC status for a wallet (also thaws token account)",
    (y) =>
      y
        .positional("mint", { type: "string", demandOption: true })
        .positional("user", { type: "string", demandOption: true })
        .option("expires-at", {
          type: "number",
          default: -1,
          describe: "KYC expiration unix timestamp (-1 = never)",
        }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      const authority = loadKeypair(argv.wallet);
      await verifyKyc(
        conn,
        authority,
        new PublicKey(argv.mint!),
        new PublicKey(argv.user!),
        argv.expiresAt
      );
    }
  )
  .command(
    "revoke-kyc <mint> <user>",
    "Revoke KYC status for a wallet (also freezes token account)",
    (y) =>
      y
        .positional("mint", { type: "string", demandOption: true })
        .positional("user", { type: "string", demandOption: true }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      const authority = loadKeypair(argv.wallet);
      await revokeKyc(
        conn,
        authority,
        new PublicKey(argv.mint!),
        new PublicKey(argv.user!)
      );
    }
  )
  .command(
    "mint-tokens <mint> <recipient> <amount>",
    "Mint stablecoin tokens to an account",
    (y) =>
      y
        .positional("mint", { type: "string", demandOption: true })
        .positional("recipient", { type: "string", demandOption: true })
        .positional("amount", { type: "number", demandOption: true }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      const authority = loadKeypair(argv.wallet);
      await mintTokens(
        conn,
        authority,
        new PublicKey(argv.mint!),
        new PublicKey(argv.recipient!),
        argv.amount!
      );
    }
  )
  .command(
    "burn-tokens <mint> <amount>",
    "Burn stablecoin tokens from your account",
    (y) =>
      y
        .positional("mint", { type: "string", demandOption: true })
        .positional("amount", { type: "number", demandOption: true }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      const owner = loadKeypair(argv.wallet);
      await burnTokens(
        conn,
        owner,
        new PublicKey(argv.mint!),
        argv.amount!
      );
    }
  )
  .command(
    "transfer <mint> <recipient> <amount>",
    "Transfer tokens (hook enforces KYC)",
    (y) =>
      y
        .positional("mint", { type: "string", demandOption: true })
        .positional("recipient", { type: "string", demandOption: true })
        .positional("amount", { type: "number", demandOption: true }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      const sender = loadKeypair(argv.wallet);
      await transferTokens(
        conn,
        sender,
        new PublicKey(argv.mint!),
        new PublicKey(argv.recipient!),
        argv.amount!
      );
    }
  )
  .command(
    "info <mint>",
    "Display mint and registry info",
    (y) => y.positional("mint", { type: "string", demandOption: true }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      await showInfo(conn, new PublicKey(argv.mint!));
    }
  )
  .demandCommand(1, "Please specify a command")
  .help()
  .parse();
