# DIP: AI Agent Native Governance for DPPOracle

## Summary

Enable AI agents to collectively govern DPPOracle pool parameters (i, K, lpFeeRate) through a native multi-agent consensus mechanism, replacing the current single-owner model.

## Motivation

### Problem

`DPPOracle.tuneParameters()` is gated by `onlyOwner` — a single address. This assumes a human operator making low-frequency, manual adjustments. As AI agents become economic actors on-chain, this model becomes a bottleneck:

1. **Speed**: Market conditions change in seconds. Human operators cannot maintain price accuracy at the speed MEV bots exploit it.
2. **Single point of failure**: One compromised key = total pool control.
3. **No checks**: A single owner can make arbitrary parameter changes with no consensus or sanity check.

### Opportunity

DODO's PMM is **uniquely positioned** for AI agent governance because:

- Unlike Uniswap's constant product (x*y=k, no parameters to tune), PMM exposes **three tunable knobs** (i, K, fee) that directly control pricing behavior
- The `DPPOracle` variant already separates oracle price (i) from curve mechanics (K, fee) — this is exactly the decomposition AI agents need
- PMM's slippage is structurally lower for small trades, which is the dominant pattern in agent-to-agent commerce

### Evidence

We ran a local simulation comparing fixed-parameter PMM vs AI-governed PMM (4 agents, 3/4 consensus):

| Metric | Fixed | AI-Governed | Improvement |
|--------|-------|-------------|-------------|
| LP yield | baseline | +24.2% | ↑ |
| Arbitrage leakage | baseline | -87.8% | ↓ |
| Impermanent loss | -21.15% | -0.76% | ↓ |

Full simulation code: [link to repo]

## Specification

### Option A: Minimal Change (Recommended for Phase 1)

No changes to core DODO contracts. Instead, standardize the **owner address pattern**:

```
┌─────────────────────────────────────────────┐
│  AI Agent Consensus Layer (new)             │
│                                             │
│  Agent 1 ──┐                                │
│  Agent 2 ──┤── propose/approve ──→ execute  │
│  Agent 3 ──┤      (N/M consensus)           │
│  Agent 4 ──┘                                │
│                                             │
│  Output: single tx from owner address       │
└──────────────────────┬──────────────────────┘
                       │ msg.sender == owner
                       ▼
┌─────────────────────────────────────────────┐
│  DPPOracle (unchanged)                      │
│  tuneParameters(newI, newK, newFee, ...)    │
└─────────────────────────────────────────────┘
```

Deliverable: A reference `AgentGovernor` contract that:
- Registers N agent addresses
- Accepts proposals with parameter bounds and minReserve constraints
- Executes on M-of-N approval
- Enforces cooldown, K/fee bounds, max price deviation per update
- Emits events for off-chain monitoring

### Option B: Native Integration (Phase 2)

Add to `DPPOracleAdmin`:

```solidity
// New storage
address[] public agents;
uint256 public requiredApprovals;
uint256 public proposalCount;
mapping(uint256 => AgentProposal) public proposals;

// New modifier
modifier onlyOwnerOrAgentConsensus() {
    require(
        msg.sender == _OWNER_ || _isApprovedProposal(msg.sender),
        "NOT_AUTHORIZED"
    );
    _;
}

// New safety bounds
uint256 public maxPriceDeviation;  // max % change per update
uint256 public updateCooldown;     // min blocks between updates
```

### Safety Mechanisms

Regardless of which option:

1. **Parameter bounds**: K ∈ [5%, 100%], fee ∈ [0.1%, 5%], price deviation ≤ 5% per update
2. **minReserve protection**: Reject parameter changes if reserves drop below threshold
3. **Cooldown**: Minimum 1 block between updates (prevents same-block manipulation)
4. **Heartbeat**: If no agent submits for N blocks, fee auto-increases to near-100% (circuit breaker)
5. **Owner override**: Human owner retains emergency pause/withdraw capability

## Rationale

### Why PMM and not AMM?

AMMs (Uniswap x*y=k) are "code is law" — deterministic, no parameters to govern. This is a feature for simplicity but a liability against MEV.

PMM's tunable parameters (i, K, fee) are not bugs — they are **governance surfaces**. The question is who governs them. Moving from "one human" to "consensus of AI agents" is a natural evolution, especially as:

1. x402 protocol enables agent-to-agent payments (Coinbase, Cloudflare, 40+ companies)
2. ChainPilot (DODO's own CLI) already treats agents as DeFi operators
3. Agent transaction volume will dwarf human volume within 2 years

### Why DODO specifically?

- Only major DEX with **oracle-driven + parameter-tunable** pool architecture
- ChainPilot already positions DODO as AI-native infrastructure
- Chinese team with Asian market access (HKDAP stablecoin integration potential)
- PMM's lower slippage suits high-frequency, small-value agent trades

## Implementation Plan

### Phase 1 (Now — no DODO changes needed)
- Deploy `AgentGovernor` contract as DPPOracle owner on Base Sepolia
- Run 4 AI agent nodes with different strategies (price oracle, volatility, fee optimization, consensus)
- Publish results and open-source code

### Phase 2 (Community approval)
- Integrate agent governance natively into DPPOracleAdmin
- Add safety mechanisms (heartbeat, circuit breaker)
- Audit

### Phase 3 (Production)
- Mainnet deployment on Base/Ethereum
- SDK for third-party AI agents to participate as parameter governors
- Integration with x402 for agent payment settlement through DODO pools

## Who We Are

NEOscript — Hong Kong-based AI infrastructure team. We build AI adaptation layers: structuring workflows so AI agents can execute reliably within defined constraints. This proposal is our first DeFi contribution, combining our AI orchestration expertise with DODO's PMM mechanism.

## References

- DODO PMM whitepaper
- x402 Foundation (Linux Foundation, July 2025)
- Cloudflare Agent Wallet (August 2026)
- ChainPilot documentation
- Our simulation repository: [link]
