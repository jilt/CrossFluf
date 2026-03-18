/**
 * Rebalancing Bot for FLUF Vault
 *
 * Runs four concurrent loops:
 * 1. Rebalance Loop (30 min) - Equal-weight allocation across strategies
 * 2. Refresh Loop (10 min) - Update position values from protocols
 * 3. Fee Harvest Loop (30 min) - Collect accumulated fees
 * 4. Monitor Loop (1 min) - Log vault stats
 *
 * Usage:
 *   ts-node rebalance-bot.ts --vault <VAULT_PUBKEY> [--cluster devnet] [--wallet ~/.config/solana/id.json]
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// --- Configuration ---

const VAULT_PROGRAM_ID = new PublicKey(
  "HqA6kcJq4XUQMSycHiBMwW6MeUB7qQcpqbMDb9m69pe8"
);

const REBALANCE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes
const FEE_HARVEST_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MONITOR_INTERVAL_MS = 60 * 1000;        // 1 minute

// Minimum rebalance threshold (basis points of total value)
const REBALANCE_THRESHOLD_BPS = 50; // 0.5%

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

async function loadProgram(
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

interface StrategyInfo {
  pubkey: PublicKey;
  account: {
    vault: PublicKey;
    index: number;
    name: number[];
    protocol: number[];
    positionValue: anchor.BN;
    allocated: anchor.BN;
    isActive: boolean;
    lastUpdateTs: anchor.BN;
    bump: number;
  };
}

async function fetchStrategies(
  program: anchor.Program,
  vaultPubkey: PublicKey
): Promise<StrategyInfo[]> {
  const strategies = await program.account.strategy.all([
    {
      memcmp: {
        offset: 8, // after discriminator
        bytes: vaultPubkey.toBase58(),
      },
    },
  ]);
  return strategies
    .filter((s: any) => s.account.isActive)
    .sort((a: any, b: any) => a.account.index - b.account.index) as StrategyInfo[];
}

function strategyName(nameBytes: number[]): string {
  return Buffer.from(nameBytes).toString("utf-8").replace(/\0/g, "").trim();
}

// --- Rebalancing Logic ---

interface AllocationTarget {
  strategy: StrategyInfo;
  currentValue: number;
  targetValue: number;
  delta: number; // positive = need to allocate, negative = need to deallocate
}

function calculateEqualWeightTargets(
  strategies: StrategyInfo[],
  totalDeployed: number,
  idleBalance: number
): AllocationTarget[] {
  const totalValue = totalDeployed + idleBalance;
  const targetPerStrategy = Math.floor(totalValue / strategies.length);

  return strategies.map((s) => {
    const currentValue = s.account.positionValue.toNumber();
    return {
      strategy: s,
      currentValue,
      targetValue: targetPerStrategy,
      delta: targetPerStrategy - currentValue,
    };
  });
}

function shouldRebalance(
  targets: AllocationTarget[],
  totalValue: number
): boolean {
  const threshold = (totalValue * REBALANCE_THRESHOLD_BPS) / 10000;
  return targets.some((t) => Math.abs(t.delta) > threshold);
}

// --- Bot Loops ---

async function rebalanceLoop(
  program: anchor.Program,
  manager: Keypair,
  vaultPubkey: PublicKey
) {
  console.log("[REBALANCE] Starting rebalance check...");

  try {
    const vault = await program.account.vault.fetch(vaultPubkey);
    const strategies = await fetchStrategies(program, vaultPubkey);

    if (strategies.length === 0) {
      console.log("[REBALANCE] No active strategies. Skipping.");
      return;
    }

    const totalDeployed = strategies.reduce(
      (sum: number, s: StrategyInfo) => sum + s.account.positionValue.toNumber(),
      0
    );
    const idleBalance = (vault as any).idleAssets.toNumber();
    const totalValue = totalDeployed + idleBalance;

    const targets = calculateEqualWeightTargets(
      strategies,
      totalDeployed,
      idleBalance
    );

    if (!shouldRebalance(targets, totalValue)) {
      console.log("[REBALANCE] Within threshold. No rebalance needed.");
      return;
    }

    console.log("[REBALANCE] Rebalancing...");
    for (const target of targets) {
      const name = strategyName(target.strategy.account.name);

      if (target.delta > 0 && idleBalance > 0) {
        // Need to allocate more to this strategy
        const allocAmount = Math.min(target.delta, idleBalance);
        console.log(
          `[REBALANCE] Allocating ${allocAmount} to strategy "${name}"`
        );

        try {
          await program.methods
            .allocate(new anchor.BN(allocAmount))
            .accounts({
              manager: manager.publicKey,
              vault: vaultPubkey,
              strategy: target.strategy.pubkey,
            })
            .rpc();
          console.log(`[REBALANCE] Allocated ${allocAmount} to "${name}"`);
        } catch (e: any) {
          console.error(
            `[REBALANCE] Failed to allocate to "${name}": ${e.message}`
          );
        }
      } else if (target.delta < 0) {
        // Need to deallocate from this strategy
        const deallocAmount = Math.min(
          Math.abs(target.delta),
          target.currentValue
        );
        console.log(
          `[REBALANCE] Deallocating ${deallocAmount} from strategy "${name}"`
        );

        try {
          await program.methods
            .deallocate(new anchor.BN(deallocAmount))
            .accounts({
              manager: manager.publicKey,
              vault: vaultPubkey,
              strategy: target.strategy.pubkey,
            })
            .rpc();
          console.log(
            `[REBALANCE] Deallocated ${deallocAmount} from "${name}"`
          );
        } catch (e: any) {
          console.error(
            `[REBALANCE] Failed to deallocate from "${name}": ${e.message}`
          );
        }
      }
    }

    console.log("[REBALANCE] Rebalance complete.");
  } catch (e: any) {
    console.error(`[REBALANCE] Error: ${e.message}`);
  }
}

async function refreshLoop(
  program: anchor.Program,
  manager: Keypair,
  vaultPubkey: PublicKey
) {
  console.log("[REFRESH] Updating strategy positions...");

  try {
    const strategies = await fetchStrategies(program, vaultPubkey);

    for (const strategy of strategies) {
      const name = strategyName(strategy.account.name);
      const currentValue = strategy.account.positionValue.toNumber();

      // Simulate yield: 5% APY pro-rated per refresh interval
      // In production, query actual protocol position values
      const annualRate = 0.05;
      const intervalSeconds = REFRESH_INTERVAL_MS / 1000;
      const yieldAmount = Math.floor(
        currentValue * annualRate * (intervalSeconds / 31_536_000)
      );

      if (yieldAmount > 0) {
        const newValue = currentValue + yieldAmount;
        console.log(
          `[REFRESH] Strategy "${name}": ${currentValue} -> ${newValue} (+${yieldAmount})`
        );

        try {
          await program.methods
            .reportYield(new anchor.BN(newValue))
            .accounts({
              manager: manager.publicKey,
              vault: vaultPubkey,
              strategy: strategy.pubkey,
            })
            .rpc();
        } catch (e: any) {
          console.error(
            `[REFRESH] Failed to report yield for "${name}": ${e.message}`
          );
        }
      }
    }

    console.log("[REFRESH] Position update complete.");
  } catch (e: any) {
    console.error(`[REFRESH] Error: ${e.message}`);
  }
}

async function feeHarvestLoop(
  program: anchor.Program,
  admin: Keypair,
  vaultPubkey: PublicKey
) {
  console.log("[FEES] Harvesting fees...");

  try {
    const vault: any = await program.account.vault.fetch(vaultPubkey);
    const lpMint = vault.lpMint;

    // Find admin's LP ATA
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const adminLpAccount = getAssociatedTokenAddressSync(
      lpMint,
      admin.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    const [lpMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint_auth"), vaultPubkey.toBuffer()],
      program.programId
    );

    await program.methods
      .harvestFees()
      .accounts({
        admin: admin.publicKey,
        vault: vaultPubkey,
        lpMint,
        lpMintAuthority,
        adminLpAccount,
        lpTokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("[FEES] Fee harvest complete.");
  } catch (e: any) {
    if (e.message?.includes("No fees to harvest")) {
      console.log("[FEES] No fees to harvest.");
    } else {
      console.error(`[FEES] Error: ${e.message}`);
    }
  }
}

async function monitorLoop(
  program: anchor.Program,
  vaultPubkey: PublicKey
) {
  try {
    const vault: any = await program.account.vault.fetch(vaultPubkey);
    const strategies = await fetchStrategies(program, vaultPubkey);

    const name = Buffer.from(vault.name)
      .toString("utf-8")
      .replace(/\0/g, "")
      .trim();
    const totalAssets = vault.totalAssets.toNumber();
    const idleAssets = vault.idleAssets.toNumber();
    const lpSupply = vault.lpSupply.toNumber();
    const assetPerLp =
      lpSupply > 0 ? (totalAssets / lpSupply).toFixed(6) : "N/A";

    console.log(`\n=== Vault "${name}" ===`);
    console.log(`  Total assets: ${totalAssets}`);
    console.log(`  Idle assets:  ${idleAssets}`);
    console.log(`  LP supply:    ${lpSupply}`);
    console.log(`  Asset/LP:     ${assetPerLp}`);
    console.log(`  Strategies:   ${strategies.length}`);

    for (const s of strategies) {
      const sName = strategyName(s.account.name);
      const protocol = strategyName(s.account.protocol);
      console.log(
        `    [${s.account.index}] ${sName} (${protocol}): ${s.account.positionValue.toNumber()}`
      );
    }

    console.log(`  Accumulated fees: ${vault.accumulatedFees.toNumber()}`);
    console.log("");
  } catch (e: any) {
    console.error(`[MONITOR] Error: ${e.message}`);
  }
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  let vaultStr = "";
  let cluster = "localnet";
  let walletPath = path.join(os.homedir(), ".config/solana/id.json");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && args[i + 1]) vaultStr = args[++i];
    if (args[i] === "--cluster" && args[i + 1]) cluster = args[++i];
    if (args[i] === "--wallet" && args[i + 1]) walletPath = args[++i];
  }

  if (!vaultStr) {
    console.error("Usage: ts-node rebalance-bot.ts --vault <VAULT_PUBKEY>");
    process.exit(1);
  }

  const vaultPubkey = new PublicKey(vaultStr);
  const connection = getConnection(cluster);
  const wallet = loadKeypair(walletPath);
  const program = await loadProgram(connection, wallet);

  console.log("=== FLUF Vault Rebalancing Bot ===");
  console.log(`Vault: ${vaultPubkey.toBase58()}`);
  console.log(`Cluster: ${cluster}`);
  console.log(`Manager: ${wallet.publicKey.toBase58()}`);
  console.log(`Rebalance interval: ${REBALANCE_INTERVAL_MS / 1000}s`);
  console.log(`Refresh interval: ${REFRESH_INTERVAL_MS / 1000}s`);
  console.log("");

  // Initial run
  await monitorLoop(program, vaultPubkey);

  // Start concurrent loops
  setInterval(() => rebalanceLoop(program, wallet, vaultPubkey), REBALANCE_INTERVAL_MS);
  setInterval(() => refreshLoop(program, wallet, vaultPubkey), REFRESH_INTERVAL_MS);
  setInterval(() => feeHarvestLoop(program, wallet, vaultPubkey), FEE_HARVEST_INTERVAL_MS);
  setInterval(() => monitorLoop(program, vaultPubkey), MONITOR_INTERVAL_MS);

  // Run first rebalance after 5 seconds
  setTimeout(() => rebalanceLoop(program, wallet, vaultPubkey), 5000);
  setTimeout(() => refreshLoop(program, wallet, vaultPubkey), 10000);

  console.log("Bot running. Press Ctrl+C to stop.\n");
}

main().catch(console.error);
