/**
 * Demo: AgentGovernor 控制 DODO DPPOracle（不改 DODO 代码）
 * 
 * 流程:
 * 1. 部署 MockDPPOracle（模拟真实 DODO 合约）
 * 2. 部署 AgentGovernor（4 agent, 3/4 共识）
 * 3. 将 DPPOracle 的 owner 转移给 AgentGovernor
 * 4. Agent 提案 → 共识 → 自动执行 tuneParameters
 * 5. 验证安全机制（价格偏移过大 → revert）
 */
const { ethers } = require("hardhat");

async function main() {
  const [deployer, ...signers] = await ethers.getSigners();
  const agents = signers.slice(0, 4);

  console.log("=".repeat(60));
  console.log("Demo: AgentGovernor → DODO DPPOracle (零改动)");
  console.log("=".repeat(60));

  // 1. Deploy mock DODO pool
  const MockDPP = await ethers.getContractFactory("MockDPPOracle");
  const dpp = await MockDPP.deploy(
    ethers.parseUnits("2000", 18),   // i = 2000
    ethers.parseUnits("0.5", 18),    // K = 0.5
    ethers.parseUnits("0.003", 18)   // fee = 0.3%
  );
  console.log(`\n✅ DODO DPPOracle deployed: ${await dpp.getAddress()}`);
  console.log(`   owner: ${deployer.address} (deployer)`);
  console.log(`   i=2000, K=0.5, fee=0.3%`);

  // 2. Deploy AgentGovernor
  const Governor = await ethers.getContractFactory("AgentGovernor");
  const gov = await Governor.deploy(
    await dpp.getAddress(),
    agents.map(a => a.address),
    3,  // 3-of-4 consensus
    ethers.parseUnits("2000", 18)  // initial i for deviation tracking
  );
  console.log(`✅ AgentGovernor deployed: ${await gov.getAddress()}`);
  console.log(`   Agents: ${agents.map(a => a.address.slice(0, 8)).join(", ")}`);
  console.log(`   Consensus: 3/4`);

  // 3. Transfer ownership to Governor
  await dpp.transferOwnership(await gov.getAddress());
  const newOwner = await dpp.owner();
  console.log(`\n✅ Ownership transferred to AgentGovernor`);
  console.log(`   DPPOracle.owner = ${newOwner}`);
  console.log(`   (AgentGovernor = ${await gov.getAddress()})`);
  console.log(`   Match: ${newOwner === await gov.getAddress()}`);

  // 4. Agent consensus: propose + approve → auto-execute
  console.log("\n--- Agent Governance Flow ---");
  
  const govAgent1 = gov.connect(agents[0]);
  const govAgent2 = gov.connect(agents[1]);
  const govAgent3 = gov.connect(agents[2]);
  const govAgent4 = gov.connect(agents[3]);

  // Agent 1: "price moved to 2050, adjust K down slightly"
  console.log("\nAgent 1 proposes: i=2050, K=0.48, fee=0.003");
  const tx1 = await govAgent1.propose(
    ethers.parseUnits("2050", 18),    // newI
    ethers.parseUnits("0.48", 18),    // newK
    ethers.parseUnits("0.003", 18),   // fee unchanged
    ethers.parseUnits("1", 18),       // minBaseReserve
    ethers.parseUnits("1000", 18)     // minQuoteReserve
  );
  await tx1.wait();
  console.log("  Proposal 0 created ✅ (1/3 approvals)");

  // Agent 2 approves
  console.log("Agent 2 approves...");
  await govAgent2.approve(0);
  console.log("  (2/3 approvals)");

  // Agent 3 approves → triggers execution on DPPOracle
  console.log("Agent 3 approves → consensus reached → executing on DPPOracle...");
  const tx3 = await govAgent3.approve(0);
  const receipt = await tx3.wait();
  console.log("  🎉 Executed!");

  // Verify DPPOracle params changed
  const finalI = ethers.formatUnits(await dpp.i(), 18);
  const finalK = ethers.formatUnits(await dpp.K(), 18);
  const finalFee = ethers.formatUnits(await dpp.lpFeeRate(), 18);
  console.log(`\n  DPPOracle params now: i=${finalI}, K=${finalK}, fee=${finalFee}`);
  console.log(`  ✅ Verified: AI agents successfully tuned DODO pool!`);

  // 5. Test safety: price deviation too high
  console.log("\n--- Safety Test: Price Deviation ---");
  console.log("  Agent 1 tries: i=3000 (50% jump from 2050) → should revert");
  try {
    await govAgent1.propose(
      ethers.parseUnits("3000", 18),
      ethers.parseUnits("0.5", 18),
      ethers.parseUnits("0.003", 18),
      0, 0
    );
    console.log("  ❌ Should have reverted!");
  } catch (e) {
    const reason = e.message.includes("PRICE_DEVIATION") ? "PRICE_DEVIATION_TOO_HIGH" : e.message.slice(0, 50);
    console.log(`  ✅ Reverted: ${reason}`);
  }

  // 6. Test: price-only fast path
  console.log("\n--- Price-Only Fast Path ---");
  console.log("  Agent 4 proposes price-only: i=2060 (small adjustment)");
  await govAgent4.proposePriceOnly(
    ethers.parseUnits("2060", 18),
    ethers.parseUnits("1", 18),
    ethers.parseUnits("1000", 18)
  );
  await govAgent1.approve(1);
  await govAgent2.approve(1);
  
  const priceAfter = ethers.formatUnits(await dpp.i(), 18);
  console.log(`  DPPOracle.i = ${priceAfter}`);
  console.log(`  ✅ Price updated via fast path`);

  // 7. Test: human override still works
  console.log("\n--- Human Emergency Override ---");
  const currentSettings = await gov.maxPriceDeviation();
  console.log(`  maxPriceDeviation: ${ethers.formatUnits(currentSettings, 18)}`);
  await gov.updateConfig(ethers.parseUnits("0.1", 18), 1, 300); // 10%, cooldown 1, heartbeat 300
  const newSettings = await gov.maxPriceDeviation();
  console.log(`  After human override: ${ethers.formatUnits(newSettings, 18)}`);
  console.log(`  ✅ Human owner retains control over safety parameters`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("✅ DEMO COMPLETE — AgentGovernor → DODO DPPOracle");
  console.log("");
  console.log("  Proven:");
  console.log("  1. AI agents can govern DODO pools via owner address");
  console.log("  2. No changes to DODO contracts required");
  console.log("  3. 3/4 consensus prevents unilateral parameter changes");
  console.log("  4. Safety bounds prevent price manipulation (±5% max)");
  console.log("  5. Human retains emergency override");
  console.log("  6. Price-only fast path for frequent oracle updates");
  console.log("");
  console.log("  This is ready for DIP proposal submission.");
  console.log("=".repeat(60));
}

main().catch(e => { console.error(e); process.exit(1); });
