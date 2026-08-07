# AI Oracle Governance

> Oracle nodes today report what happened.
> AgentGovernor decides what to do about it.

Drop-in governance layer for any `onlyOwner` DeFi contract. 4 AI agents, 3/4 consensus, 12-second execution. No protocol changes required.

## The Problem

DeFi's deepest contradiction: **immutable rules in a mutable world.**

- Uniswap's `x*y=k` cannot adapt to market regime changes
- Governance voting takes days — attackers move in seconds
- Oracles report prices but don't act on them
- Single-owner parameter control is a centralization point

## The Solution

**Oracle as Governance** — transform oracles from passive price feeds into active governance agents.

```
┌─────────────────────────────────────────────────────────────┐
│  AI Agent Consensus Layer  (AgentGovernor contract)          │
│                                                             │
│  Agent 1: Price Oracle     ── sense external price          │
│  Agent 2: Volatility       ── sense market regime           │
│  Agent 3: Fee Optimizer    ── sense arbitrage frequency     │
│  Agent 4: Consensus        ── aggregate + propose           │
│                                                             │
│  propose() → 3/4 approve → execute()                       │
└──────────────────────────────┬──────────────────────────────┘
                               │ msg.sender == owner
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Any DeFi Pool  (DODO DPPOracle, Uniswap V4, etc.)         │
│                                                             │
│  tuneParameters(i, K, fee, ...)                             │
│  No code changes required — just transfer ownership         │
└─────────────────────────────────────────────────────────────┘
```

## Results (Simulation)

| Metric | Fixed Parameters | AI-Governed | Change |
|--------|-----------------|-------------|--------|
| LP Yield | Baseline | +24.2% | ↑ |
| Arbitrage Leakage | Baseline | -87.8% | ↓ |
| Impermanent Loss | -21.15% | -0.76% | ↓ |
| Consensus Time | N/A | 12 seconds | — |

## How It Works

### 1. AgentGovernor Contract

A lightweight multi-sig governance contract that wraps any `onlyOwner` DeFi pool:

- **4 registered agents** (independent EOAs or bots)
- **3/4 consensus threshold** for parameter changes
- **Safety bounds**: K_MIN/K_MAX, ±5% price deviation, update cooldown
- **Human emergency override** preserved

### 2. AI Agent Nodes

Each agent runs independently and submits parameter proposals based on its specialty:

- **Price Oracle Agent** — tracks CEX/DEX price divergence
- **Volatility Agent** — adjusts K based on market regime (trend vs chop)
- **Fee Optimizer Agent** — adjusts fees based on arbitrage frequency
- **Consensus Agent** — aggregates proposals and submits on-chain

### 3. PMM Integration

Built for DODO's Proactive Market Maker (PMM), which exposes tunable parameters:
- `i` — price oracle (mid-price)
- `K` — curve depth (0 = constant price, 1 = Uniswap-like)
- `lpFeeRate` — LP fee percentage

Unlike Uniswap's immutable `x*y=k`, PMM parameters can adapt without redeployment.

## Quick Start

```bash
# Clone
git clone https://github.com/anthropics/ai-oracle-governance.git
cd ai-oracle-governance

# Install
npm install

# Compile contracts
npx hardhat compile

# Run local test (full cycle: deploy → agents propose → consensus → execute)
npx hardhat run scripts/test-local.js

# Deploy to Base Sepolia
cp .env.example .env  # add your private key + RPC
npx hardhat run deploy/deploy.js --network base-sepolia

# Start agent nodes
AGENT_ID=1 node agents/agent-node.js  # in separate terminals
AGENT_ID=2 node agents/agent-node.js
AGENT_ID=3 node agents/agent-node.js
AGENT_ID=4 node agents/agent-node.js
```

## Project Structure

```
contracts/
├── AgentGovernor.sol       # Core: multi-agent consensus governance
├── AIPMMPool.sol           # Reference PMM implementation (RState + quadratic pricing)
├── MockERC20.sol           # Test token
└── interfaces/
    └── MockDPPOracle.sol   # DODO DPPOracle interface mock

agents/
└── agent-node.js           # 4-role agent implementation

simulation/
└── simulation.py           # Phase 1 Python simulation

docs/
├── whitepaper.md           # Core thesis
└── dip-proposal.md         # DODO governance proposal

deploy/
└── deploy.js               # Base Sepolia deployment
```

## Key Insight

Oracle is no longer the contract's "eyes" — it becomes the contract's "brain."

From passive data pipe to active governance subject with agency.

## Roadmap

- [x] **Phase 1** — Simulation (Python, validated +24% LP yield)
- [x] **Phase 2** — On-chain MVP (Hardhat local, full consensus cycle)
- [ ] **Phase 3** — Base Sepolia live demo
- [ ] **Phase 4** — DIP Proposal to DODO governance
- [ ] **Phase 5** — Forward-looking Oracle (commitment-driven pricing)

## Philosophy

Current DeFi architecture treats oracles as **data pipes** — information flows in one direction from the "real world" (CEX) to the "contract world" (DEX). This creates a hidden power structure where centralized exchanges determine pricing.

We propose oracles as **scene interfaces** — boundaries where two different worlds (on-chain and off-chain) exchange value through attention routing, scene recognition, and exchange rate determination. This requires agency.

AI agents provide that agency: they sense, judge, and act — all within one block cycle.

## License

MIT

## Contact

- **Project**: [NEOscript](https://ark.honeyhughub.world/oracle/)
- **Email**: nathan@honeyhughub.world
