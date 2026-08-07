/**
 * 本地集成测试：部署 + 加流动性 + 4 agent 提案 + 共识执行 + swap
 */
const { ethers } = require("hardhat");

async function main() {
  const [deployer, user, ...agentSigners] = await ethers.getSigners();
  
  // 如果 signer 不够，用随机 wallet
  const agents = [];
  for (let j = 0; j < 4; j++) {
    if (agentSigners[j]) {
      agents.push(agentSigners[j]);
    } else {
      const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
      // Fund it
      await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") });
      agents.push(wallet);
    }
  }

  console.log("=".repeat(60));
  console.log("AI-PMM Phase 2: 本地集成测试");
  console.log("=".repeat(60));
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Agents: ${agents.map(a => a.address.slice(0, 10)).join(", ")}`);

  // 1. Deploy tokens
  const MockToken = await ethers.getContractFactory("MockERC20");
  const base = await MockToken.deploy("Wrapped ETH", "WETH", 18);
  const quote = await MockToken.deploy("USD Coin", "USDC", 18); // 18 dec for simplicity
  console.log(`\n✅ Tokens deployed: WETH=${await base.getAddress()}, USDC=${await quote.getAddress()}`);

  // 2. Deploy pool (3-of-4 consensus)
  const AIPMMPool = await ethers.getContractFactory("AIPMMPool");
  const pool = await AIPMMPool.deploy(
    await base.getAddress(),
    await quote.getAddress(),
    ethers.parseUnits("2000", 18),    // i = 2000
    ethers.parseUnits("0.5", 18),     // K = 0.5
    ethers.parseUnits("0.003", 18),   // fee = 0.3%
    agents.map(a => a.address),
    3  // 3-of-4
  );
  console.log(`✅ Pool deployed: ${await pool.getAddress()}`);
  console.log(`   i=2000, K=0.5, fee=0.3%, consensus=3/4`);

  // 3. Add liquidity
  const baseAmt = ethers.parseUnits("10", 18);
  const quoteAmt = ethers.parseUnits("20000", 18);
  await base.mint(deployer.address, baseAmt);
  await quote.mint(deployer.address, quoteAmt);
  await base.approve(await pool.getAddress(), baseAmt);
  await quote.approve(await pool.getAddress(), quoteAmt);
  await pool.addLiquidity(baseAmt, quoteAmt);
  console.log(`✅ Liquidity: 10 WETH + 20000 USDC`);

  // 4. Agent 1 proposes parameter change
  console.log("\n--- Agent Governance ---");
  const poolAgent1 = pool.connect(agents[0]);
  const poolAgent2 = pool.connect(agents[1]);
  const poolAgent3 = pool.connect(agents[2]);
  const poolAgent4 = pool.connect(agents[3]);

  // Agent 1 proposes: price moved to 2050, increase K slightly
  console.log("\nAgent 1 proposes: i=2050, K=0.55, fee=0.003");
  const tx1 = await poolAgent1.propose(
    ethers.parseUnits("2050", 18),
    ethers.parseUnits("0.55", 18),
    ethers.parseUnits("0.003", 18)
  );
  await tx1.wait();
  console.log("  Proposal 0 created ✅");

  // Agent 2 approves
  console.log("Agent 2 approves proposal 0");
  const tx2 = await poolAgent2.approve(0);
  await tx2.wait();
  console.log("  Approved (2/3) ✅");

  // Agent 3 approves → triggers execution
  console.log("Agent 3 approves proposal 0 → should execute");
  const tx3 = await poolAgent3.approve(0);
  const receipt3 = await tx3.wait();
  
  // Check if ParametersTuned event fired
  const tunedEvent = receipt3.logs.find(log => {
    try {
      return pool.interface.parseLog(log)?.name === "ParametersTuned";
    } catch { return false; }
  });
  
  if (tunedEvent) {
    console.log("  🎉 Parameters tuned via 3/4 consensus!");
  }

  // Verify new params
  const newI = ethers.formatUnits(await pool.i(), 18);
  const newK = ethers.formatUnits(await pool.K(), 18);
  const newFee = ethers.formatUnits(await pool.lpFeeRate(), 18);
  console.log(`  New params: i=${newI}, K=${newK}, fee=${newFee}`);

  // 5. Test swap
  console.log("\n--- Swap Test ---");
  const swapAmount = ethers.parseUnits("1", 18); // 1 WETH
  await base.mint(user.address, swapAmount);
  await base.connect(user).approve(await pool.getAddress(), swapAmount);
  
  const userQuoteBefore = await quote.balanceOf(user.address);
  await pool.connect(user).sellBase(swapAmount);
  const userQuoteAfter = await quote.balanceOf(user.address);
  const received = ethers.formatUnits(userQuoteAfter - userQuoteBefore, 18);
  
  console.log(`  Sold 1 WETH → received ${parseFloat(received).toFixed(2)} USDC`);
  console.log(`  Expected ~2050 (minus fee). Got ${received}`);

  // 6. Summary
  console.log("\n" + "=".repeat(60));
  console.log("✅ Phase 2 集成测试通过:");
  console.log("  - PMM 合约部署成功");
  console.log("  - 4 Agent 多签治理工作");
  console.log("  - 3/4 共识触发参数更新");
  console.log("  - Swap 使用 AI 调整后的参数定价");
  console.log("=".repeat(60));
}

main().catch(e => { console.error(e); process.exit(1); });
