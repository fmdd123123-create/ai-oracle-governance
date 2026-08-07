# AI Oracle Governance

> Oracle nodes today report what happened.
> AgentGovernor decides what to do about it.

Drop-in governance layer for any `onlyOwner` DeFi contract. 4 AI agents, 3/4 consensus, 12-second execution. No protocol changes required.

**Live Demo**: [ark.honeyhughub.world/oracle](https://ark.honeyhughub.world/oracle/) — verified on-chain transactions on Ethereum Sepolia.

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

## Results

| Metric | Fixed Parameters | AI-Governed | Change |
|--------|-----------------|-------------|--------|
| LP Yield | Baseline | +24.2% | ↑ |
| Arbitrage Leakage | Baseline | -87.8% | ↓ |
| Impermanent Loss | -21.15% | -0.76% | ↓ |
| Consensus Time | N/A | 12 seconds | — |

## Live On-Chain Proof (Eth Sepolia)

| Contract | Address |
|----------|---------|
| AgentGovernor | [`0x6e5Efe62Cd4E9e2181865B3765d84E32130Ff4ff`](https://sepolia.etherscan.io/address/0x6e5Efe62Cd4E9e2181865B3765d84E32130Ff4ff) |
| MockDPPOracle | [`0xb5c231086915e5E1f4FD5177b9af3DD1F7105fEf`](https://sepolia.etherscan.io/address/0xb5c231086915e5E1f4FD5177b9af3DD1F7105fEf) |
| Execution TX | [`0x7e883274...d72ec228`](https://sepolia.etherscan.io/tx/0x7e883274bdc332e8a0928854ea1b895baa06a15adf12f080c3671615d72ec228) |

4 independent wallets, 3/4 consensus, parameters changed on-chain. Verify yourself.

## SDK — Three Lines to Governance

```javascript
const { GovernorSDK, ChainPilotSensor } = require('./sdk');

const sensor = new ChainPilotSensor({ chainId: 1 });
const sdk = new GovernorSDK({ rpc, governorAddress, oracleAddress, privateKey });

// Sense → Decide → Act
const market = await sensor.sense();
const decision = sdk.decide(market, await sdk.getPoolState());
if (decision.shouldPropose) await sdk.propose(decision.params);
```

Each agent imports the same SDK with its own key. Consensus emerges from independent judgment through shared protocol — not coordination.

See [`sdk/README.md`](sdk/README.md) for full API documentation.

## Quick Start

```bash
# Clone
git clone https://github.com/fmdd123123-create/ai-oracle-governance.git
cd ai-oracle-governance

# Install
npm install

# Compile contracts
npx hardhat compile

# Run full governance cycle on Eth Sepolia (generates 4 wallets, deploys, executes)
npx hardhat run scripts/full-demo-cycle.js --network eth-sepolia

# Run ChainPilot sensing demo (real-time market data)
export PATH="${HOME}/.chainpilot/bin:$PATH"
node agents/chainpilot-demo.js

# Run SDK example (sense → decide → act)
node examples/sdk-governance-cycle.js
```

## Project Structure

```
contracts/
├── AgentGovernor.sol       # Core: multi-agent consensus governance
├── AIPMMPool.sol           # Reference PMM (RState + quadratic pricing)
├── MockERC20.sol           # Test token
└── interfaces/
    └── MockDPPOracle.sol   # DODO DPPOracle interface mock

sdk/
├── index.js                # ChainPilotSensor + GovernorSDK
├── README.md               # API documentation
└── package.json

agents/
└── chainpilot-demo.js      # ChainPilot integration (real-time sensing)

examples/
└── sdk-governance-cycle.js # Full cycle via SDK

scripts/
├── full-demo-cycle.js      # Deploy + 4-wallet governance cycle
├── deploy-sepolia.js       # Deploy contracts only
└── demo-governor.js        # Local governance test

docs/
└── whitepaper.md           # Core thesis + technical spec
```

## How It Works

### 1. Sense (ChainPilotSensor)

Agents use [DODO ChainPilot](https://github.com/DODOEX/ChainPilot) to read real-time market data:
- **Price**: DEX/CEX spot price via DODO routing engine
- **Volatility**: implied from large/small order slippage differential
- **Arb Pressure**: cross-chain price spread (mainnet vs L2)

### 2. Decide (Strategy)

Each agent runs its own `decide()` logic:
- Price deviation > 0.5% → propose new `i`
- Low volatility → reduce `K` (offer better prices)
- High volatility → increase `K` (protect LPs)
- Low arb pressure → reduce fee (attract volume)
- High arb pressure → increase fee (extract arb value)

Override with custom strategies by subclassing or injecting a function.

### 3. Act (AgentGovernor)

On-chain execution via multi-sig consensus:
- Agent proposes → gets 1 auto-approval
- 2 more agents approve → 3/4 quorum reached
- Contract auto-executes `tuneParameters()` on the DPP Oracle
- Total time: 12 seconds (1 block cycle)

### 4. Safety

- **K bounds**: 0.05–1.0
- **Price deviation cap**: ±5% per update
- **Fee cap**: 0.5% max
- **Cooldown**: 600 blocks between updates
- **Human emergency pause**: admin can freeze in crisis

## Key Insight

Oracle is no longer the contract's "eyes" — it becomes the contract's "brain."

From passive data pipe to active governance subject with agency.

## Roadmap

- [x] **Phase 1** — Simulation (Python, validated +24% LP yield)
- [x] **Phase 2** — On-chain MVP (full consensus cycle on Eth Sepolia)
- [x] **Phase 3** — SDK (standardized agent interface)
- [x] **Phase 4** — ChainPilot integration (real-time market sensing)
- [ ] **Phase 5** — DIP Proposal to DODO governance
- [ ] **Phase 6** — Forward-looking Oracle (commitment-driven pricing)

## Philosophy

Current DeFi architecture treats oracles as **data pipes** — information flows in one direction from the "real world" (CEX) to the "contract world" (DEX). This creates a hidden power structure where centralized exchanges determine pricing.

We propose oracles as **scene interfaces** — boundaries where two different worlds (on-chain and off-chain) exchange value through attention routing, scene recognition, and exchange rate determination. This requires agency.

AI agents provide that agency: they sense, judge, and act — all within one block cycle.

## License

MIT

## Contact

- **Project**: [ark.honeyhughub.world/oracle](https://ark.honeyhughub.world/oracle/)
- **Email**: info@honeyhughub.world
- **Organization**: [NEOscript](https://ark.honeyhughub.world)
