/**
 * Example: 4 agents using SDK to run a governance cycle
 * 
 * Each agent is independent — same SDK, different key, own judgment.
 * Consensus emerges from the protocol, not from coordination.
 */

const { GovernorSDK, ChainPilotSensor } = require("../sdk");
const { ethers } = require("ethers");
require("dotenv").config();

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";

async function main() {
  // In production: each agent runs on a separate machine with its own key
  // For demo: we simulate 4 independent agents locally
  const GOVERNOR = process.env.GOVERNOR_ADDRESS || "0x6e5Efe62Cd4E9e2181865B3765d84E32130Ff4ff";
  const ORACLE = process.env.ORACLE_ADDRESS || "0xb5c231086915e5E1f4FD5177b9af3DD1F7105fEf";

  // Load agent keys (in production: each from separate env/vault)
  const agentKeys = [
    process.env.AGENT_KEY_1,
    process.env.AGENT_KEY_2,
    process.env.AGENT_KEY_3,
    process.env.AGENT_KEY_4,
  ].filter(Boolean);

  if (agentKeys.length < 3) {
    console.error("Need at least 3 AGENT_KEY_N env vars for quorum");
    process.exit(1);
  }

  // Initialize agents — same SDK, different identities
  const agents = agentKeys.map((key, i) => ({
    name: `Agent ${i + 1}`,
    sdk: new GovernorSDK({
      rpc: RPC,
      governorAddress: GOVERNOR,
      oracleAddress: ORACLE,
      privateKey: key,
    }),
  }));

  const sensor = new ChainPilotSensor({ chainId: 1 });

  console.log("═══ Sensing Market (ChainPilot) ═══\n");
  const market = await sensor.sense();
  console.log(`  Price:    $${market.price.price.toFixed(2)}`);
  console.log(`  Slippage: ${(market.volatility.slippage * 100).toFixed(4)}%`);
  console.log(`  Spread:   ${(market.crossChain.spread * 100).toFixed(4)}%`);

  console.log("\n═══ Reading Pool State ═══\n");
  const pool = await agents[0].sdk.getPoolState();
  console.log(`  i:   ${pool.i}`);
  console.log(`  K:   ${pool.K}`);
  console.log(`  fee: ${pool.fee}`);

  console.log("\n═══ Agent Decisions ═══\n");
  
  // Each agent makes independent decision
  const decisions = agents.map(agent => {
    const decision = agent.sdk.decide(market, pool);
    const action = decision.shouldPropose ? "PROPOSE" : decision.shouldApprove ? "APPROVE" : "HOLD";
    console.log(`  ${agent.name}: ${action}`);
    if (decision.params) {
      console.log(`    → i=${decision.params.i?.toFixed(2)}, K=${decision.params.K?.toFixed(3)}, fee=${decision.params.fee?.toFixed(5)}`);
    }
    return { ...agent, decision };
  });

  // Find proposer (first agent that wants to propose)
  const proposer = decisions.find(d => d.decision.shouldPropose);
  if (!proposer) {
    console.log("\n  No agent wants to propose. Market stable. Done.");
    return;
  }

  console.log("\n═══ On-Chain Execution ═══\n");
  
  // Propose
  console.log(`  ${proposer.name} proposing...`);
  const proposalId = await proposer.sdk.propose(proposer.decision.params);
  console.log(`  ✓ Proposal #${proposalId} created\n`);

  // Other agents approve
  const approvers = decisions.filter(d => d !== proposer && d.decision.shouldApprove);
  for (const approver of approvers.slice(0, 2)) { // need 2 more for 3/4
    console.log(`  ${approver.name} approving #${proposalId}...`);
    await approver.sdk.approve(proposalId);
    console.log(`  ✓ Approved`);
  }

  console.log("\n═══ Verifying Result ═══\n");
  const newPool = await agents[0].sdk.getPoolState();
  console.log(`  i:   ${pool.i} → ${newPool.i}`);
  console.log(`  K:   ${pool.K} → ${newPool.K}`);
  console.log(`  fee: ${pool.fee} → ${newPool.fee}`);
  console.log("\n  ✅ Governance cycle complete. No human. No vote.\n");
}

main().catch(console.error);
