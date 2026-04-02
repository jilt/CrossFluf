# CrossFluf — Liquidity Unlocking Freedom on Solana

**DeFi promised you freedom. Most protocols delivered a cage.**

You lock capital in pools, watch it sit idle between trades, and collect fees only when someone remembers to come claim them. CrossFluf is built on a different premise: your liquidity should work *every single block*, and every time it does, you should earn — automatically, atomically, with no middleman and no claim button.

🔗 **[github.com/jilt/CrossFluf](https://github.com/jilt/CrossFluf/tree/main)**

***

## The Idea Is Simple

CrossFluf is a Token-2022 flash loan liquidity pool on Solana, paired with an institutional vault and an autonomous AI arbitrage agent powered by Bitget Wallet Skills. You deposit your memecoin into the pool. The pool lends it out in flash loans every time an arbitrage opportunity exists across Raydium, Orca, and Jupiter. Every repayment automatically withholds 0.5% via Solana's native Token-2022 fee extension — no smart contract logic, no trust assumption, enforced at the protocol level — and that fee flows back to you as a liquidity provider. Your LP share tokens (fT) quietly appreciate in value. You do nothing.

If you want to go deeper, you stake your fT shares into the CrossFluf vault, receive vault shares (vT), and unlock the rebalancing bot that actively stabilizes the memecoin price using the yield your pool is generating. The vault is self-sustaining. The loop is closed.

***

## Two Agent Skills. One Closed Loop.

For the Bitget Wallet track of the Agent economy Hackathon on Solana we are submitting two Skills that compose into a fully autonomous yield machine:

### Skill 1 — `crossfluf_flashloan_arb`

This is the engine. An AI agent that scans cross-DEX spreads for the CrossFluf memecoin every 2.5 seconds using Bitget Wallet's `getSwapPrice` API, then — when a profitable gap opens — fires a single atomic Solana transaction: borrow from the pool, swap on the cheap DEX, sell on the expensive one, repay the pool. The entire cycle lives or dies in one slot. If repayment fails, the transaction reverts and the pool never loses a token. If it succeeds, 0.5% of the repayment stays behind, forever, for LP holders.

The agent never holds private keys. Bitget Wallet signs every transaction. Gas is paid in the traded token via BGW's no-gas feature — the agent never stalls waiting for SOL. It just runs.

### Skill 2 — `crossfluf_fee_harvest_vault`

This is the compounder. Every five minutes, the agent sweeps all withheld Token-2022 fees from holder accounts back into the pool reserve — growing the T-per-fT redemption ratio silently in the background. When you eventually burn your fT, you receive more T than you put in. The difference is every flash loan that ran while you held.

The vault layer stacks on top: deposit fT, receive vT, earn rebalancing bot yield on top of pool yield. Want to leave? Burn vT, get fT back, plus everything that compounded since you entered. No lockup. No penalty. No permission needed.

***

## Why This Matters

Every other flash loan protocol treats arbitrage as an external activity — someone else's job, someone else's profit. CrossFluf makes the liquidity pool itself the beneficiary of every arb cycle it enables. The pool funds the trade. The pool earns the fee. The pool grows. LPs hold the pool.

The memecoin is not decoration. Its Token-2022 `TransferFeeConfig` extension means the fee is enforced on *every* transfer — not just flash loans. Every swap, every send, every DEX trade routes 0.5% back to the pool. The more the memecoin trades, the more the pool earns. The more the pool earns, the more it can lend. The more it lends, the more the arb agent profits. The more the agent profits, the more it stabilizes the price through the vault rebalancing bot.

This is a flywheel, not a feature.

***

## Built for the Bitget Wallet Ecosystem

CrossFluf is native to Bitget Wallet. The web dashboard connects exclusively via Bitget Wallet adapter. Agent controls are gated behind vT vault share ownership — only people with skin in the game can run the agent. The Skills are composable with any BGW-compatible runtime: OpenClaw, Manus, or a custom agent. The arbitrage feed is public and live on the dashboard, so anyone can watch the machine work in real time.

The hackathon track asks for a Solana meme coin AI trading agent ranked by live trading profitability. CrossFluf delivers that — and then routes the profits to the people who made it possible: the liquidity providers who trusted the pool with their tokens.

***

## The Stack

Solana · Anchor · Token-2022 · `spl-token-2022` native CPI · Bitget Wallet Skill API · `@solana/wallet-adapter-bitget` · Next.js · Raydium · Orca · Jupiter · BWB/T liquidity pair (BWB Wormhole: `6FVyLVhQs…wK`)

***

**Liquidity isn't something you lock up and pray over.**
**It's something you set free — and let it come back richer.**

🔗 [github.com/jilt/CrossFluf](https://github.com/jilt/CrossFluf/tree/main)

`#CrossFluf` `#BitgetWallet` `#Solana` `#DeFi` `#FlashLoans` `#Token2022` `#BGWSkills`

#### This project was built upon the [fluf protocol](https://github.com/jordan-public/flash-loan-unlimited-solana)  project enabling virtually unlimited flash loans amounts on dolana, using a token to mint and a liquid pool, weupdated/tested the core engine and added the rebalancing vault mechanics (using drift) and the UI, both the Ui and the agent skills are enabled to perform arbitrage and harvest fees for the liquid pool investors ####

[Demo](#)
