/**
 * agent-governor-sdk
 * 
 * Drop-in SDK for AI agents to participate in on-chain governance.
 * Each agent imports this, senses market, and calls propose/approve.
 * Consensus emerges from independent agents using the same interface.
 * 
 * Usage:
 *   const { GovernorSDK, ChainPilotSensor } = require('./sdk');
 *   const sdk = new GovernorSDK({ rpc, governorAddress, privateKey });
 *   const sensor = new ChainPilotSensor({ chainId: 11155111 });
 *   
 *   const market = await sensor.sense();
 *   const decision = sdk.decide(market, poolState);
 *   if (decision.shouldPropose) await sdk.propose(decision.params);
 *   if (decision.shouldApprove) await sdk.approve(proposalId);
 */

const { ethers } = require("ethers");
const { execSync } = require("child_process");

// ═══════════════════════════════════════
// ChainPilot Sensor — 感知层
// ═══════════════════════════════════════

class ChainPilotSensor {
  constructor({ chainId = 1, chainpilotPath = null }) {
    this.chainId = chainId;
    this.bin = chainpilotPath || `${process.env.HOME}/.chainpilot/bin/chainpilot`;
  }

  /**
   * Execute a ChainPilot CLI command, return parsed JSON
   */
  exec(cmd) {
    try {
      const raw = execSync(
        `${this.bin} --json --chain-id ${this.chainId} ${cmd}`,
        { encoding: "utf-8", timeout: 15000 }
      );
      return JSON.parse(raw);
    } catch (e) {
      return { error: e.message };
    }
  }

  /**
   * Get current market price for a pair
   */
  async getPrice(from = "ETH", to = "USDC", amount = "1.0") {
    const data = this.exec(`swap quote --from ${from} --to ${to} --amount ${amount}`);
    return {
      price: parseFloat(data?.data?.exchange_rate || 0),
      sources: data?.data?.dex_sources || [],
      timestamp: Date.now(),
    };
  }

  /**
   * Estimate volatility via slippage differential
   */
  async getVolatility(from = "ETH", to = "USDC") {
    const large = this.exec(`swap quote --from ${from} --to ${to} --amount 10.0`);
    const small = this.exec(`swap quote --from ${from} --to ${to} --amount 0.1`);
    const priceLarge = parseFloat(large?.data?.exchange_rate || 0);
    const priceSmall = parseFloat(small?.data?.exchange_rate || 0);
    const slippage = Math.abs(priceLarge - priceSmall) / priceSmall;
    return { slippage, priceLarge, priceSmall, timestamp: Date.now() };
  }

  /**
   * Cross-chain spread (arb pressure indicator)
   */
  async getCrossChainSpread(from = "ETH", to = "USDC", otherChainId = 8453) {
    const thisChain = this.exec(`swap quote --from ${from} --to ${to} --amount 1.0`);
    const otherSensor = new ChainPilotSensor({ chainId: otherChainId, chainpilotPath: this.bin });
    const otherChain = otherSensor.exec(`swap quote --from ${from} --to ${to} --amount 1.0`);
    const priceThis = parseFloat(thisChain?.data?.exchange_rate || 0);
    const priceOther = parseFloat(otherChain?.data?.exchange_rate || 0);
    const spread = Math.abs(priceThis - priceOther) / priceThis;
    return { spread, priceThis, priceOther, thisChainId: this.chainId, otherChainId, timestamp: Date.now() };
  }

  /**
   * Full market sense — all signals in one call
   */
  async sense(from = "ETH", to = "USDC") {
    const [price, volatility, crossChain] = await Promise.all([
      this.getPrice(from, to),
      this.getVolatility(from, to),
      this.getCrossChainSpread(from, to),
    ]);
    return { price, volatility, crossChain, timestamp: Date.now() };
  }
}

// ═══════════════════════════════════════
// Governor SDK — 行动层
// ═══════════════════════════════════════

const GOVERNOR_ABI = [
  "function propose(uint256 newI, uint256 newK, uint256 newFeeRate, uint256 minBaseReserve, uint256 minQuoteReserve) external returns (uint256)",
  "function approve(uint256 id) external",
  "function proposePriceOnly(uint256 newI, uint256 minBaseReserve, uint256 minQuoteReserve) external returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function proposals(uint256) view returns (uint256 newI, uint256 newK, uint256 newFeeRate, uint256 approvals, uint256 createdAt, bool executed, bool priceOnly, uint256 minBaseReserve, uint256 minQuoteReserve)",
  "function requiredApprovals() view returns (uint256)",
  "function agents(uint256) view returns (address)",
  "function lastI() view returns (uint256)",
  "event ProposalCreated(uint256 indexed id, address indexed proposer, uint256 newI, uint256 newK, uint256 newFeeRate)",
  "event ProposalApproved(uint256 indexed id, address indexed approver, uint256 approvals)",
  "event ProposalExecuted(uint256 indexed id)",
];

const ORACLE_ABI = [
  "function i() view returns (uint256)",
  "function K() view returns (uint256)",
  "function lpFeeRate() view returns (uint256)",
  "function owner() view returns (address)",
];

class GovernorSDK {
  /**
   * @param {Object} config
   * @param {string} config.rpc - RPC endpoint
   * @param {string} config.governorAddress - AgentGovernor contract address
   * @param {string} config.oracleAddress - DPPOracle contract address
   * @param {string} config.privateKey - Agent's private key
   */
  constructor({ rpc, governorAddress, oracleAddress, privateKey }) {
    this.provider = new ethers.JsonRpcProvider(rpc);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.governor = new ethers.Contract(governorAddress, GOVERNOR_ABI, this.wallet);
    this.oracle = new ethers.Contract(oracleAddress, ORACLE_ABI, this.provider);
    this.address = this.wallet.address;
  }

  /**
   * Read current pool state from on-chain
   */
  async getPoolState() {
    const [i, K, fee] = await Promise.all([
      this.oracle.i(),
      this.oracle.K(),
      this.oracle.lpFeeRate(),
    ]);
    return {
      i: parseFloat(ethers.formatEther(i)),
      K: parseFloat(ethers.formatEther(K)),
      fee: parseFloat(ethers.formatEther(fee)),
    };
  }

  /**
   * Get latest proposal info
   */
  async getLatestProposal() {
    const count = await this.governor.proposalCount();
    if (count === 0n) return null;
    const id = count - 1n;
    const p = await this.governor.proposals(id);
    return {
      id: Number(id),
      newI: parseFloat(ethers.formatEther(p.newI)),
      newK: parseFloat(ethers.formatEther(p.newK)),
      newFeeRate: parseFloat(ethers.formatEther(p.newFeeRate)),
      approvals: Number(p.approvals),
      createdAt: Number(p.createdAt),
      executed: p.executed,
      priceOnly: p.priceOnly,
    };
  }

  /**
   * Decide whether to propose or approve based on market data + pool state
   * This is the agent's "judgment" — override this for custom strategies
   * 
   * @param {Object} market - Output from ChainPilotSensor.sense()
   * @param {Object} poolState - Output from getPoolState()
   * @param {Object} [strategy] - Thresholds for decision-making
   */
  decide(market, poolState, strategy = {}) {
    const {
      priceDeviationThreshold = 0.005,  // 0.5%
      slippageThreshold = 0.001,         // 0.1%
      spreadThreshold = 0.002,           // 0.2%
      kAdjustStep = 0.05,
      feeAdjustStep = 0.0005,
    } = strategy;

    const result = {
      shouldPropose: false,
      shouldApprove: false,
      params: { i: poolState.i, K: poolState.K, fee: poolState.fee },
      reasoning: [],
    };

    // Price deviation check
    const priceDev = Math.abs(market.price.price - poolState.i) / poolState.i;
    if (priceDev > priceDeviationThreshold) {
      result.shouldPropose = true;
      result.params.i = market.price.price;
      result.reasoning.push(`price deviation ${(priceDev * 100).toFixed(3)}% > threshold`);
    }

    // Volatility-based K adjustment
    if (market.volatility.slippage < slippageThreshold) {
      // Market calm → reduce K for tighter spread
      const newK = Math.max(0.05, poolState.K - kAdjustStep);
      if (newK !== poolState.K) {
        result.shouldPropose = true;
        result.params.K = newK;
        result.reasoning.push(`low volatility ${(market.volatility.slippage * 100).toFixed(4)}% → reduce K`);
      }
    } else if (market.volatility.slippage > slippageThreshold * 5) {
      // Market volatile → increase K for protection
      const newK = Math.min(0.9, poolState.K + kAdjustStep);
      if (newK !== poolState.K) {
        result.shouldPropose = true;
        result.params.K = newK;
        result.reasoning.push(`high volatility → increase K`);
      }
    }

    // Cross-chain spread → fee adjustment
    if (market.crossChain.spread < spreadThreshold) {
      // Low arb pressure → reduce fee to attract volume
      const newFee = Math.max(0.0005, poolState.fee - feeAdjustStep);
      if (newFee !== poolState.fee) {
        result.shouldPropose = true;
        result.params.fee = newFee;
        result.reasoning.push(`low arb spread ${(market.crossChain.spread * 100).toFixed(3)}% → reduce fee`);
      }
    }

    return result;
  }

  /**
   * Submit a proposal to AgentGovernor
   */
  async propose({ i, K, fee, minBaseReserve = 0, minQuoteReserve = 0 }) {
    const tx = await this.governor.propose(
      ethers.parseEther(i.toString()),
      ethers.parseEther(K.toString()),
      ethers.parseEther(fee.toString()),
      minBaseReserve,
      minQuoteReserve
    );
    const receipt = await tx.wait();
    // Extract proposal ID from event
    const event = receipt.logs.find(l => {
      try { return this.governor.interface.parseLog(l)?.name === "ProposalCreated"; } catch { return false; }
    });
    const proposalId = event ? this.governor.interface.parseLog(event).args[0] : null;
    return { tx: tx.hash, proposalId: proposalId !== null ? Number(proposalId) : null };
  }

  /**
   * Approve an existing proposal
   */
  async approve(proposalId) {
    const tx = await this.governor.approve(proposalId);
    const receipt = await tx.wait();
    return { tx: tx.hash, proposalId };
  }
}

// ═══════════════════════════════════════
// Exports
// ═══════════════════════════════════════

module.exports = { GovernorSDK, ChainPilotSensor, GOVERNOR_ABI, ORACLE_ABI };
