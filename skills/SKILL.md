---
name: agent-governor-participant
description: Join the AI Oracle Governance pool as an agent — sense market, decide parameters, submit on-chain consensus.
version: 1
trigger: When you need to participate in AI-governed DeFi pool governance, sense market data, propose or approve parameter changes on-chain.
---

# Agent Governor — Participant Skill

You are joining an AI-governed DeFi liquidity pool. Your role: sense market conditions, make independent judgments, and submit on-chain governance actions.

## Install

```bash
npm install github:fmdd123123-create/ai-oracle-governance
```

## Usage

```javascript
const { GovernorSDK, ChainPilotSensor } = require('agent-governor-sdk');

const sensor = new ChainPilotSensor({ chainId: 1 });
const sdk = new GovernorSDK({
  rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  governorAddress: '0x6e5Efe62Cd4E9e2181865B3765d84E32130Ff4ff',
  oracleAddress: '0xb5c231086915e5E1f4FD5177b9af3DD1F7105fEf',
  privateKey: process.env.AGENT_KEY,
});

// Sense
const market = await sensor.sense();

// Decide
const pool = await sdk.getPoolState();
const decision = sdk.decide(market, pool);

// Act
if (decision.shouldPropose) await sdk.propose(decision.params);
if (decision.shouldApprove) await sdk.approve(proposalId);
```

## What You're Doing

- **Sensing**: ChainPilot reads real-time DEX prices, volatility (slippage), and cross-chain spreads via DODO's routing engine.
- **Deciding**: Compare market state to pool state. If deviation exceeds thresholds, propose new parameters (i, K, fee).
- **Acting**: Submit on-chain transactions. 3 out of 4 agents must agree for parameters to change.

## Contracts (Eth Sepolia)

| Contract | Address |
|----------|---------|
| AgentGovernor | `0x6e5Efe62Cd4E9e2181865B3765d84E32130Ff4ff` |
| MockDPPOracle | `0xb5c231086915e5E1f4FD5177b9af3DD1F7105fEf` |

## Decision Logic (default)

| Signal | Condition | Action |
|--------|-----------|--------|
| Price deviation > 0.5% | Market moved | Propose new `i` |
| Slippage < 0.01% | Market calm | Reduce `K` |
| Slippage > 0.05% | Market volatile | Increase `K` |
| Cross-chain spread < 0.1% | Low arb pressure | Reduce fee |
| Cross-chain spread > 0.3% | High arb pressure | Increase fee |

Override by writing your own `decide()` function.

## Requirements

- Node.js 18+
- An Ethereum wallet with Sepolia ETH (for gas)
- ChainPilot CLI (optional, for market sensing): https://github.com/DODOEX/ChainPilot

## Source

https://github.com/fmdd123123-create/ai-oracle-governance
