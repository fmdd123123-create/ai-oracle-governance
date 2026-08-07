# agent-governor-sdk

SDK for AI agents to participate in on-chain DeFi governance.

## Philosophy

Consensus requires a shared interface. This SDK is that interface.

Each agent independently:
1. **Senses** market state (via ChainPilot)
2. **Decides** whether to propose or approve (via configurable strategy)
3. **Acts** on-chain (via GovernorSDK)

No agent knows what others will do. Consensus emerges from independent judgment through a shared protocol.

## Quick Start

```javascript
const { GovernorSDK, ChainPilotSensor } = require('./sdk');

// Initialize
const sdk = new GovernorSDK({
  rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  governorAddress: '0x6e5Efe62Cd4E9e2181865B3765d84E32130Ff4ff',
  oracleAddress: '0xb5c231086915e5E1f4FD5177b9af3DD1F7105fEf',
  privateKey: process.env.AGENT_KEY,
});

const sensor = new ChainPilotSensor({ chainId: 1 });

// Sense → Decide → Act
const market = await sensor.sense();
const pool = await sdk.getPoolState();
const decision = sdk.decide(market, pool);

if (decision.shouldPropose) {
  const id = await sdk.propose(decision.params);
  console.log(`Proposed #${id}`);
}
```

## API

### ChainPilotSensor

| Method | Returns | Description |
|--------|---------|-------------|
| `sense(from, to)` | `{ price, volatility, crossChain }` | Full market snapshot |
| `getPrice(from, to, amount)` | `{ price, sources }` | Spot price via DODO routing |
| `getVolatility(from, to)` | `{ slippage }` | Implied volatility from size differential |
| `getCrossChainSpread(from, to, otherChainId)` | `{ spread }` | Arb pressure between chains |

### GovernorSDK

| Method | Returns | Description |
|--------|---------|-------------|
| `getPoolState()` | `{ i, K, fee }` | Current on-chain parameters |
| `propose(params)` | `proposalId` | Submit parameter change proposal |
| `approve(id)` | `txHash` | Vote yes on a pending proposal |
| `decide(market, pool)` | `{ shouldPropose, shouldApprove, params }` | Default decision logic |
| `getLatestProposal()` | `{ id, newI, newK, ... }` | Read latest pending proposal |

### GovernorSDK.decide() — Default Strategy

```
Price deviation > 0.5%  → propose new i
Slippage < 0.01%        → reduce K (market calm, offer better prices)
Slippage > 0.05%        → increase K (market volatile, protect LPs)
Cross-chain spread < 0.1% → reduce fee (low arb pressure)
Cross-chain spread > 0.3% → increase fee (high arb pressure)
```

Override by subclassing or passing a custom `strategy` function.

## Writing a Custom Agent

```javascript
const { GovernorSDK, ChainPilotSensor } = require('./sdk');

class MyAgent {
  constructor(config) {
    this.sdk = new GovernorSDK(config);
    this.sensor = new ChainPilotSensor({ chainId: 1 });
  }

  // Override decision logic
  decide(market, pool) {
    // Your strategy here
    if (market.price.price > pool.i * 1.01) {
      return {
        shouldPropose: true,
        params: { i: market.price.price, K: pool.K, fee: pool.fee },
      };
    }
    return { shouldPropose: false, shouldApprove: true };
  }

  async run() {
    const market = await this.sensor.sense();
    const pool = await this.sdk.getPoolState();
    const decision = this.decide(market, pool);

    if (decision.shouldPropose) {
      await this.sdk.propose(decision.params);
    }

    // Check if there's a pending proposal to approve
    const latest = await this.sdk.getLatestProposal();
    if (latest && !latest.executed && decision.shouldApprove) {
      await this.sdk.approve(latest.id);
    }
  }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Agent 1          Agent 2          Agent 3          │
│  ┌──────┐         ┌──────┐         ┌──────┐        │
│  │sensor│         │sensor│         │sensor│        │
│  │decide│         │decide│         │decide│        │
│  │ act  │         │ act  │         │ act  │        │
│  └──┬───┘         └──┬───┘         └──┬───┘        │
│     │                 │                 │           │
│     └────────────────┼─────────────────┘           │
│                       ▼                             │
│            ┌─────────────────────┐                  │
│            │  AgentGovernor.sol  │                  │
│            │  (3/4 consensus)    │                  │
│            └─────────┬───────────┘                  │
│                      ▼                              │
│            ┌─────────────────────┐                  │
│            │  DPPOracle (DODO)   │                  │
│            │  tuneParameters()   │                  │
│            └─────────────────────┘                  │
└─────────────────────────────────────────────────────┘
```

## License

MIT
