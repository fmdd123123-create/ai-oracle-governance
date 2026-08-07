/**
 * AI Oracle Governance — ChainPilot Integration Demo
 * 
 * 世界上第一个 AI 自治的 DeFi 池原型
 * 
 * 架构:
 *   ChainPilot (感知层) → Agent 决策 → AgentGovernor (行动层) → DPPOracle
 * 
 * 每个 Agent 用 ChainPilot CLI 获取真实链上数据，
 * 根据策略决定是否 propose 参数调整，
 * 3/4 共识后自动执行 tuneParameters。
 */

const { execSync } = require('child_process');

// ═══════════════════════════════════════
// ChainPilot 感知层
// ═══════════════════════════════════════

class ChainPilotSensor {
  constructor(chainId = 8453) {
    this.chainId = chainId;
    this.bin = process.env.CHAINPILOT_BIN || `${process.env.HOME}/.chainpilot/bin/chainpilot`;
  }

  exec(cmd) {
    const full = `${this.bin} --json --chain-id ${this.chainId} ${cmd}`;
    try {
      const out = execSync(full, { timeout: 20000, encoding: 'utf8' });
      const parsed = JSON.parse(out);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.data;
    } catch (e) {
      console.error(`  [ChainPilot Error] ${cmd}: ${e.message}`);
      return null;
    }
  }

  async getPrice(from = 'ETH', to = 'USDC', amount = '1.0') {
    const data = this.exec(`swap quote --from ${from} --to ${to} --amount ${amount}`);
    return data ? data.exchange_rate : null;
  }

  async getTokenRisk(token) {
    return this.exec(`risk token ${token}`);
  }

  async getTokenInfo(token) {
    return this.exec(`token info ${token}`);
  }
}

// ═══════════════════════════════════════
// Agent 决策层（4 个独立 Agent）
// ═══════════════════════════════════════

class PriceAgent {
  constructor(sensor, poolState) {
    this.sensor = sensor;
    this.poolState = poolState;
    this.name = 'PriceOracle';
  }

  async evaluate() {
    const price = await this.sensor.getPrice('ETH', 'USDC', '1.0');
    if (!price) return null;

    const currentI = this.poolState.i;
    const deviation = Math.abs(price - currentI) / currentI;

    console.log(`  [${this.name}] ChainPilot price: $${price.toFixed(2)}, Pool i: $${currentI.toFixed(2)}, deviation: ${(deviation * 100).toFixed(3)}%`);

    if (deviation > 0.005) {
      return { i: price, reason: `price deviation ${(deviation * 100).toFixed(2)}%` };
    }
    return null;
  }
}

class VolatilityAgent {
  constructor(sensor, poolState) {
    this.sensor = sensor;
    this.poolState = poolState;
    this.name = 'VolatilitySensor';
  }

  async evaluate() {
    const buyPrice = await this.sensor.getPrice('ETH', 'USDC', '10.0');
    const smallBuy = await this.sensor.getPrice('ETH', 'USDC', '0.1');
    if (!buyPrice || !smallBuy) return null;

    const slippage = Math.abs(buyPrice - smallBuy) / smallBuy;
    const currentK = this.poolState.K;

    console.log(`  [${this.name}] 10ETH price: $${buyPrice.toFixed(2)}, 0.1ETH price: $${smallBuy.toFixed(2)}, implied slippage: ${(slippage * 100).toFixed(4)}%`);

    if (slippage > 0.003 && currentK < 0.8) {
      return { K: Math.min(currentK + 0.05, 0.9), reason: `high volatility, slippage ${(slippage * 100).toFixed(3)}%` };
    }
    if (slippage < 0.001 && currentK > 0.2) {
      return { K: Math.max(currentK - 0.05, 0.1), reason: `low volatility, slippage ${(slippage * 100).toFixed(3)}%` };
    }
    return null;
  }
}

class FeeAgent {
  constructor(sensor, poolState) {
    this.sensor = sensor;
    this.poolState = poolState;
    this.name = 'FeeOptimizer';
  }

  async evaluate() {
    const ethSensor = new ChainPilotSensor(1);
    const ethPrice = await ethSensor.getPrice('ETH', 'USDC', '1.0');
    const basePrice = await this.sensor.getPrice('ETH', 'USDC', '1.0');
    if (!ethPrice || !basePrice) return null;

    const crossChainSpread = Math.abs(ethPrice - basePrice) / ethPrice;
    const currentFee = this.poolState.fee;

    console.log(`  [${this.name}] ETH mainnet: $${ethPrice.toFixed(2)}, Base: $${basePrice.toFixed(2)}, cross-chain spread: ${(crossChainSpread * 100).toFixed(4)}%`);

    if (crossChainSpread > 0.002 && currentFee < 0.005) {
      return { fee: Math.min(currentFee + 0.001, 0.005), reason: `arb pressure, spread ${(crossChainSpread * 100).toFixed(3)}%` };
    }
    if (crossChainSpread < 0.0005 && currentFee > 0.001) {
      return { fee: Math.max(currentFee - 0.0005, 0.001), reason: `low arb pressure, spread ${(crossChainSpread * 100).toFixed(3)}%` };
    }
    return null;
  }
}

class ConsensusAgent {
  constructor(sensor, poolState) {
    this.sensor = sensor;
    this.poolState = poolState;
    this.name = 'ConsensusArbiter';
  }

  async evaluate(proposals) {
    const validProposals = proposals.filter(p => p !== null);
    console.log(`  [${this.name}] Received ${validProposals.length}/3 proposals`);

    if (validProposals.length === 0) {
      console.log(`  [${this.name}] No adjustments needed. Pool is healthy.`);
      return null;
    }

    const merged = {
      i: this.poolState.i,
      K: this.poolState.K,
      fee: this.poolState.fee,
      reasons: []
    };

    for (const p of validProposals) {
      if (p.i) { merged.i = p.i; merged.reasons.push(p.reason); }
      if (p.K) { merged.K = p.K; merged.reasons.push(p.reason); }
      if (p.fee) { merged.fee = p.fee; merged.reasons.push(p.reason); }
    }

    console.log(`  [${this.name}] Consensus: i=$${merged.i.toFixed(2)}, K=${merged.K.toFixed(3)}, fee=${(merged.fee * 100).toFixed(2)}%`);
    console.log(`  [${this.name}] Reasons: ${merged.reasons.join('; ')}`);
    return merged;
  }
}

// ═══════════════════════════════════════
// 主程序：一轮完整 Oracle 周期
// ═══════════════════════════════════════

async function runOracleCycle() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  AI Oracle Governance — ChainPilot Integration Demo     ║');
  console.log('║  ChainPilot (感知) → Agents (决策) → Governor (执行)    ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // 模拟池子当前状态（故意设偏 i，测试 agent 能否检测）
  const poolState = {
    i: 1900.0,
    K: 0.5,
    fee: 0.003,
  };

  console.log('═══ Current Pool State ═══');
  console.log(`  i (mid-price): $${poolState.i.toFixed(2)}`);
  console.log(`  K (curvature): ${poolState.K}`);
  console.log(`  fee: ${(poolState.fee * 100).toFixed(2)}%\n`);

  const sensor = new ChainPilotSensor(8453);

  console.log('═══ Phase 1: Agent Sensing (via ChainPilot) ═══\n');

  const priceAgent = new PriceAgent(sensor, poolState);
  const volAgent = new VolatilityAgent(sensor, poolState);
  const feeAgent = new FeeAgent(sensor, poolState);
  const consensusAgent = new ConsensusAgent(sensor, poolState);

  console.log('--- Price Oracle Agent ---');
  const priceProp = await priceAgent.evaluate();

  console.log('\n--- Volatility Sensor Agent ---');
  const volProp = await volAgent.evaluate();

  console.log('\n--- Fee Optimizer Agent ---');
  const feeProp = await feeAgent.evaluate();

  console.log('\n═══ Phase 2: Consensus ═══\n');
  const finalParams = await consensusAgent.evaluate([priceProp, volProp, feeProp]);

  console.log('\n═══ Phase 3: Governance Action ═══\n');
  if (finalParams) {
    console.log('  ✅ PROPOSAL READY — would call AgentGovernor.propose():');
    console.log(`     i:   $${poolState.i} → $${finalParams.i.toFixed(2)}`);
    console.log(`     K:   ${poolState.K} → ${finalParams.K.toFixed(3)}`);
    console.log(`     fee: ${(poolState.fee * 100).toFixed(2)}% → ${(finalParams.fee * 100).toFixed(2)}%`);
    console.log('\n  Production flow:');
    console.log('  3/4 agents approve → AgentGovernor.sol → DPPOracle.tuneParameters()');
  } else {
    console.log('  ⏸️  NO ACTION — pool parameters within healthy bounds');
  }

  console.log('\n═══ Demo Complete ═══');
  console.log('  Data source: ChainPilot v1.2.2 (DODO routing engine)');
  console.log('  Governance: AgentGovernor.sol (3/4 multi-agent consensus)');
  console.log('  Target: DODO DPPOracle (zero code changes)');
  console.log('  GitHub: https://github.com/fmdd123123-create/ai-oracle-governance\n');
}

runOracleCycle().catch(console.error);
