/**
 * AI-PMM Agent Node
 * 
 * 四个 agent 角色:
 *   1: Price Oracle — 跟踪外部价格
 *   2: Volatility Sensor — 根据波动调 K
 *   3: Fee Optimizer — 根据套利频率调费率
 *   4: Consensus Arbiter — 收集提案，达成共识后提交
 * 
 * 用法: AGENT_ID=1 node scripts/agent-node.js
 */

const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

// Load deployment
const deployment = JSON.parse(fs.readFileSync("deployment.json", "utf8"));
const AGENT_ID = parseInt(process.env.AGENT_ID || "4");

// Pool ABI (simplified)
const POOL_ABI = [
  "function i() view returns (uint256)",
  "function K() view returns (uint256)",
  "function lpFeeRate() view returns (uint256)",
  "function baseReserve() view returns (uint256)",
  "function quoteReserve() view returns (uint256)",
  "function propose(uint256 newI, uint256 newK, uint256 newFeeRate) returns (uint256)",
  "function approve(uint256 proposalId)",
  "function proposalCount() view returns (uint256)",
  "event ProposalCreated(uint256 proposalId, address agent, uint256 newI, uint256 newK, uint256 newFeeRate)",
  "event ParametersTuned(uint256 newI, uint256 newK, uint256 newFeeRate, uint256 proposalId)",
];

class PriceOracle {
  constructor() { this.history = []; }
  
  async getExternalPrice() {
    // MVP: simulate CEX price with random walk
    // Production: fetch from Binance/Coinbase API
    const base = 2000;
    const noise = (Math.random() - 0.5) * 40; // ±$20
    const price = base + noise + Math.sin(Date.now() / 10000) * 30;
    return price;
  }

  async recommend(currentI) {
    const cexPrice = await this.getExternalPrice();
    this.history.push(cexPrice);
    
    if (this.history.length < 3) return { newI: cexPrice, reason: "initial" };
    
    // EMA smoothing
    const h = this.history.slice(-3);
    const ema = h[2] * 0.5 + h[1] * 0.3 + h[0] * 0.2;
    const deviation = Math.abs(ema - currentI) / currentI;
    
    if (deviation > 0.002) {
      return { newI: ema, reason: `deviation ${(deviation * 100).toFixed(3)}%` };
    }
    return { newI: null, reason: "within range" };
  }
}

class VolatilitySensor {
  constructor() { this.prices = []; }
  
  async recommend(currentK, cexPrice) {
    this.prices.push(cexPrice);
    if (this.prices.length < 5) return { newK: null, reason: "gathering data" };
    
    const recent = this.prices.slice(-5);
    let vol = 0;
    for (let j = 1; j < recent.length; j++) {
      vol += Math.abs(recent[j] - recent[j-1]) / recent[j-1];
    }
    vol /= (recent.length - 1);
    
    if (vol > 0.015) {
      const target = Math.min(currentK + 0.1, 0.8);
      return { newK: target, reason: `high vol ${(vol*100).toFixed(2)}%, K↑` };
    } else if (vol < 0.005) {
      const target = Math.max(currentK - 0.05, 0.05);
      return { newK: target, reason: `low vol ${(vol*100).toFixed(2)}%, K↓` };
    }
    return { newK: null, reason: `moderate vol ${(vol*100).toFixed(2)}%` };
  }
}

class FeeOptimizer {
  constructor() { this.arbCount = 0; this.totalSwaps = 0; }
  
  async recommend(currentFee, baseReserve, quoteReserve, currentI) {
    // Check if pool price deviates from oracle (proxy for arb opportunity)
    const impliedPrice = quoteReserve / baseReserve;
    const deviation = Math.abs(impliedPrice - currentI) / currentI;
    
    this.totalSwaps++;
    if (deviation > 0.01) this.arbCount++;
    
    if (this.totalSwaps < 10) return { newFee: null, reason: "gathering data" };
    
    const arbRatio = this.arbCount / this.totalSwaps;
    
    if (arbRatio > 0.3) {
      const target = Math.min(currentFee + 0.001, 0.05);
      return { newFee: target, reason: `high arb ${(arbRatio*100).toFixed(1)}%, fee↑` };
    } else if (arbRatio < 0.1) {
      const target = Math.max(currentFee - 0.0005, 0.001);
      return { newFee: target, reason: `low arb ${(arbRatio*100).toFixed(1)}%, fee↓` };
    }
    return { newFee: null, reason: `normal arb ${(arbRatio*100).toFixed(1)}%` };
  }
}

class ConsensusArbiter {
  constructor(provider, pool, agentWallet) {
    this.provider = provider;
    this.pool = pool;
    this.wallet = agentWallet;
    this.pendingProposals = [];
  }
  
  async collectAndPropose(recommendations) {
    // Filter non-null recommendations
    const validI = recommendations.filter(r => r.newI !== null).map(r => r.newI);
    const validK = recommendations.filter(r => r.newK !== null).map(r => r.newK);
    const validFee = recommendations.filter(r => r.newFee !== null).map(r => r.newFee);
    
    // Median for each
    const finalI = validI.length >= 2 ? median(validI) : null;
    const finalK = validK.length >= 2 ? median(validK) : null;
    const finalFee = validFee.length >= 2 ? median(validFee) : null;
    
    if (finalI || finalK || finalFee) {
      const currentI = parseFloat(ethers.formatUnits(await this.pool.i(), 18));
      const currentK = parseFloat(ethers.formatUnits(await this.pool.K(), 18));
      const currentFee = parseFloat(ethers.formatUnits(await this.pool.lpFeeRate(), 18));
      
      const newI = ethers.parseUnits((finalI || currentI).toFixed(6), 18);
      const newK = ethers.parseUnits((finalK || currentK).toFixed(6), 18);
      const newFee = ethers.parseUnits((finalFee || currentFee).toFixed(6), 18);
      
      console.log(`  → Proposing: i=${finalI?.toFixed(2) || 'no change'}, K=${finalK?.toFixed(4) || 'no change'}, fee=${finalFee?.toFixed(4) || 'no change'}`);
      
      try {
        const tx = await this.pool.propose(newI, newK, newFee);
        const receipt = await tx.wait();
        console.log(`  ✅ Proposal submitted: tx=${receipt.hash}`);
      } catch (e) {
        console.log(`  ❌ Proposal failed: ${e.message}`);
      }
    } else {
      console.log("  → No consensus reached, holding parameters");
    }
  }
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ============ Main Loop ============

async function main() {
  const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
  const agentInfo = deployment.agents[AGENT_ID - 1];
  const wallet = new ethers.Wallet(agentInfo.privateKey, provider);
  const pool = new ethers.Contract(deployment.pool, POOL_ABI, wallet);
  
  console.log(`\n🤖 Agent ${AGENT_ID} started: ${agentInfo.address}`);
  console.log(`   Pool: ${deployment.pool}`);
  console.log(`   Role: ${["Price Oracle", "Volatility Sensor", "Fee Optimizer", "Consensus Arbiter"][AGENT_ID - 1]}`);
  
  const priceOracle = new PriceOracle();
  const volSensor = new VolatilitySensor();
  const feeOptimizer = new FeeOptimizer();
  const arbiter = new ConsensusArbiter(provider, pool, wallet);
  
  // Run loop
  let tick = 0;
  setInterval(async () => {
    tick++;
    console.log(`\n--- Tick ${tick} ---`);
    
    try {
      const currentI = parseFloat(ethers.formatUnits(await pool.i(), 18));
      const currentK = parseFloat(ethers.formatUnits(await pool.K(), 18));
      const currentFee = parseFloat(ethers.formatUnits(await pool.lpFeeRate(), 18));
      const baseRes = parseFloat(ethers.formatUnits(await pool.baseReserve(), 18));
      const quoteRes = parseFloat(ethers.formatUnits(await pool.quoteReserve(), 6));
      
      console.log(`  Current: i=${currentI.toFixed(2)}, K=${currentK.toFixed(4)}, fee=${(currentFee*100).toFixed(3)}%`);
      console.log(`  Reserves: ${baseRes.toFixed(4)} BASE, ${quoteRes.toFixed(2)} QUOTE`);
      
      const cexPrice = await priceOracle.getExternalPrice();
      
      // Each agent computes recommendation
      const rec1 = await priceOracle.recommend(currentI);
      const rec2 = await volSensor.recommend(currentK, cexPrice);
      const rec3 = await feeOptimizer.recommend(currentFee, baseRes, quoteRes, currentI);
      
      console.log(`  Agent 1 (Price): ${rec1.reason}`);
      console.log(`  Agent 2 (Vol):   ${rec2.reason}`);
      console.log(`  Agent 3 (Fee):   ${rec3.reason}`);
      
      // Agent 4 collects and proposes
      if (AGENT_ID === 4) {
        await arbiter.collectAndPropose([rec1, rec2, rec3]);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }, 15000); // every 15 seconds
}

main().catch(console.error);
