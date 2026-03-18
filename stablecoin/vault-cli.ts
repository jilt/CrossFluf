/**
 * Vault CLI - Institutional Permissioned DeFi Vault Management
 *
 * Commands:
 *   create-vault       Create a new vault for fUSD deposits
 *   add-strategy       Add a yield strategy to the vault
 *   deposit            Deposit fUSD into the vault (gets LP tokens)
 *   withdraw           Withdraw fUSD from the vault (burns LP tokens)
 *   allocate           Allocate idle funds to a strategy
 *   deallocate         Deallocate funds from a strategy
 *   report-yield       Update strategy position value (simulate yield)
 *   harvest-fees       Collect accumulated fees
 *   info               Display vault status
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  setAuthority,
  AuthorityType,
  getMint,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// --- Configuration ---

const VAULT_PROGRAM_ID = new PublicKey(
  "HqA6kcJq4XUQMSycHiBMwW6MeUB7qQcpqbMDb9m69pe8"
);

const KYC_HOOK_PROGRAM_ID = new PublicKey(
  "55NYv5kunygtJdiMuFVPzjXnUXEt24h4DHMXJW7wCUSM"
);

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

async function loadVaultProgram(
  connection: Connection,
  wallet: Keypair
): Promise<anchor.Program> {
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );
  const idlPath = path.join(__dirname, "../target/idl/vault.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  return new anchor.Program(idl, provider);
}

function findVaultPda(
  admin: PublicKey,
  name: string
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), admin.toBuffer(), Buffer.from(name)],
    VAULT_PROGRAM_ID
  );
}

function findLpMintAuthority(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint_auth"), vault.toBuffer()],
    VAULT_PROGRAM_ID
  );
}

function findVaultAssetAuthority(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_asset_auth"), vault.toBuffer()],
    VAULT_PROGRAM_ID
  );
}

function findStrategyPda(
  vault: PublicKey,
  index: number
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("strategy"), vault.toBuffer(), Buffer.from([index])],
    VAULT_PROGRAM_ID
  );
}

// --- Commands ---

async function createVault(
  connection: Connection,
  admin: Keypair,
  assetMint: PublicKey,
  name: string,
  managerPubkey?: PublicKey
) {
  console.log(`Creating vault "${name}"...\n`);
  const manager = managerPubkey || admin.publicKey;

  const program = await loadVaultProgram(connection, admin);
  const [vaultPda] = findVaultPda(admin.publicKey, name);
  const [lpMintAuthority] = findLpMintAuthority(vaultPda);
  const [vaultAssetAuth] = findVaultAssetAuthority(vaultPda);

  console.log(`Vault PDA: ${vaultPda.toBase58()}`);
  console.log(`LP Mint Authority PDA: ${lpMintAuthority.toBase58()}`);
  console.log(`Asset Authority PDA: ${vaultAssetAuth.toBase58()}`);

  // 1. Create LP token mint with authority set to the PDA
  console.log("\nCreating LP token mint...");
  const lpMintKeypair = Keypair.generate();
  const lpMint = await createMint(
    connection,
    admin,
    lpMintAuthority,  // mint authority = PDA
    null,              // no freeze authority
    6,                 // decimals
    lpMintKeypair,
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log(`LP Mint: ${lpMint.toBase58()}`);

  // 2. Create vault's asset token account (Token-2022 ATA)
  console.log("Creating vault asset account...");
  const vaultAssetAccount = getAssociatedTokenAddressSync(
    assetMint,
    vaultAssetAuth,
    true, // allowOwnerOffCurve (PDA)
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const createAtaTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      admin.publicKey,
      vaultAssetAccount,
      vaultAssetAuth,
      assetMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );
  await sendAndConfirmTransaction(connection, createAtaTx, [admin]);
  console.log(`Vault Asset Account: ${vaultAssetAccount.toBase58()}`);

  // 3. Initialize vault
  console.log("\nInitializing vault...");
  const config = {
    maxCap: new anchor.BN("18446744073709551615"), // u64 max
    performanceFeeBps: 1000,  // 10%
    managementFeeBps: 50,     // 0.5% annual
    depositFeeBps: 10,        // 0.1%
    withdrawalFeeBps: 10,     // 0.1%
    lockedProfitDegradation: new anchor.BN(86400), // 24h
    withdrawalWaitPeriod: new anchor.BN(0),         // instant
  };

  const tx = await program.methods
    .initializeVault(name, config)
    .accounts({
      admin: admin.publicKey,
      manager,
      vault: vaultPda,
      assetMint,
      lpMint,
      lpMintAuthority,
      vaultAssetAccount,
      vaultAssetAuthority: vaultAssetAuth,
      assetTokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`\nVault created! Tx: ${tx}`);
  console.log(`\nVault address: ${vaultPda.toBase58()}`);
  console.log(`LP Mint: ${lpMint.toBase58()}`);
  console.log(`Asset Account: ${vaultAssetAccount.toBase58()}`);

  // Save vault info
  const vaultInfo = {
    vault: vaultPda.toBase58(),
    lpMint: lpMint.toBase58(),
    assetMint: assetMint.toBase58(),
    vaultAssetAccount: vaultAssetAccount.toBase58(),
    vaultAssetAuth: vaultAssetAuth.toBase58(),
    lpMintAuthority: lpMintAuthority.toBase58(),
    admin: admin.publicKey.toBase58(),
    manager: manager.toBase58(),
    name,
  };
  const infoPath = path.join(__dirname, "vault-info.json");
  fs.writeFileSync(infoPath, JSON.stringify(vaultInfo, null, 2));
  console.log(`\nVault info saved to: ${infoPath}`);
}

async function addStrategy(
  connection: Connection,
  admin: Keypair,
  vaultPubkey: PublicKey,
  name: string,
  protocol: string
) {
  console.log(`Adding strategy "${name}" (${protocol})...\n`);

  const program = await loadVaultProgram(connection, admin);
  const vault: any = await program.account.vault.fetch(vaultPubkey);
  const [strategyPda] = findStrategyPda(vaultPubkey, vault.numStrategies);

  console.log(`Strategy PDA: ${strategyPda.toBase58()}`);
  console.log(`Index: ${vault.numStrategies}`);

  const tx = await program.methods
    .addStrategy(name, protocol)
    .accounts({
      admin: admin.publicKey,
      vault: vaultPubkey,
      strategy: strategyPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`\nStrategy added! Tx: ${tx}`);
}

async function showInfo(
  connection: Connection,
  wallet: Keypair,
  vaultPubkey: PublicKey
) {
  const program = await loadVaultProgram(connection, wallet);
  const vault: any = await program.account.vault.fetch(vaultPubkey);

  const name = Buffer.from(vault.name)
    .toString("utf-8")
    .replace(/\0/g, "")
    .trim();

  console.log(`\n=== Vault: "${name}" ===`);
  console.log(`Address:        ${vaultPubkey.toBase58()}`);
  console.log(`Admin:          ${vault.admin.toBase58()}`);
  console.log(`Manager:        ${vault.manager.toBase58()}`);
  console.log(`Asset Mint:     ${vault.assetMint.toBase58()}`);
  console.log(`LP Mint:        ${vault.lpMint.toBase58()}`);
  console.log(`Active:         ${vault.isActive}`);
  console.log("");
  console.log(`Total Assets:   ${vault.totalAssets.toNumber()}`);
  console.log(`Idle Assets:    ${vault.idleAssets.toNumber()}`);
  console.log(`LP Supply:      ${vault.lpSupply.toNumber()}`);

  const lpSupply = vault.lpSupply.toNumber();
  const totalAssets = vault.totalAssets.toNumber();
  const assetPerLp =
    lpSupply > 0 ? (totalAssets / lpSupply).toFixed(6) : "N/A";
  console.log(`Asset/LP:       ${assetPerLp}`);

  console.log("");
  console.log(`Perf Fee:       ${vault.performanceFeeBps / 100}%`);
  console.log(`Mgmt Fee:       ${vault.managementFeeBps / 100}%`);
  console.log(`Deposit Fee:    ${vault.depositFeeBps / 100}%`);
  console.log(`Withdrawal Fee: ${vault.withdrawalFeeBps / 100}%`);
  console.log(`Lock Duration:  ${vault.lockedProfitDegradation.toNumber()}s`);
  console.log(`Wait Period:    ${vault.withdrawalWaitPeriod.toNumber()}s`);
  console.log(`Accrued Fees:   ${vault.accumulatedFees.toNumber()}`);
  console.log(`Strategies:     ${vault.numStrategies}`);

  // Fetch strategies
  const strategies = await program.account.strategy.all([
    { memcmp: { offset: 8, bytes: vaultPubkey.toBase58() } },
  ]);

  for (const s of strategies) {
    const sAccount = s.account as any;
    const sName = Buffer.from(sAccount.name)
      .toString("utf-8")
      .replace(/\0/g, "")
      .trim();
    const sProto = Buffer.from(sAccount.protocol)
      .toString("utf-8")
      .replace(/\0/g, "")
      .trim();
    const active = sAccount.isActive ? "ACTIVE" : "INACTIVE";
    console.log(
      `  [${sAccount.index}] ${sName} (${sProto}) - Value: ${sAccount.positionValue.toNumber()} [${active}]`
    );
  }
  console.log("");
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
    describe: "Solana cluster",
  })
  .option("wallet", {
    alias: "w",
    type: "string",
    default: defaultWallet,
    describe: "Path to wallet keypair JSON",
  })
  .command(
    "create-vault <asset-mint> <name>",
    "Create a new vault",
    (y) =>
      y
        .positional("asset-mint", { type: "string", demandOption: true })
        .positional("name", { type: "string", demandOption: true })
        .option("manager", { type: "string", describe: "Manager pubkey" }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      const admin = loadKeypair(argv.wallet);
      const manager = argv.manager
        ? new PublicKey(argv.manager)
        : undefined;
      await createVault(
        conn,
        admin,
        new PublicKey(argv.assetMint!),
        argv.name!,
        manager
      );
    }
  )
  .command(
    "add-strategy <vault> <name> <protocol>",
    "Add a yield strategy to the vault",
    (y) =>
      y
        .positional("vault", { type: "string", demandOption: true })
        .positional("name", { type: "string", demandOption: true })
        .positional("protocol", { type: "string", demandOption: true }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      const admin = loadKeypair(argv.wallet);
      await addStrategy(
        conn,
        admin,
        new PublicKey(argv.vault!),
        argv.name!,
        argv.protocol!
      );
    }
  )
  .command(
    "info <vault>",
    "Display vault status",
    (y) => y.positional("vault", { type: "string", demandOption: true }),
    async (argv) => {
      const conn = getConnection(argv.cluster);
      const wallet = loadKeypair(argv.wallet);
      await showInfo(conn, wallet, new PublicKey(argv.vault!));
    }
  )
  .demandCommand(1, "Please specify a command")
  .help()
  .parse();
