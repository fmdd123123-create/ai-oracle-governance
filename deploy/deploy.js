const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // 1. Deploy mock tokens (testnet only)
  const MockToken = await ethers.getContractFactory("MockERC20");
  
  const baseToken = await MockToken.deploy("Mock WETH", "WETH", 18);
  await baseToken.waitForDeployment();
  console.log("Base Token (WETH):", await baseToken.getAddress());

  const quoteToken = await MockToken.deploy("Mock USDC", "USDC", 6);
  await quoteToken.waitForDeployment();
  console.log("Quote Token (USDC):", await quoteToken.getAddress());

  // 2. Generate 4 agent wallets
  const agentWallets = [];
  for (let j = 0; j < 4; j++) {
    const wallet = ethers.Wallet.createRandom();
    agentWallets.push(wallet);
    console.log(`Agent ${j + 1}: ${wallet.address}`);
  }

  // 3. Deploy AI-PMM Pool
  const AIPMMPool = await ethers.getContractFactory("AIPMMPool");
  const pool = await AIPMMPool.deploy(
    await baseToken.getAddress(),
    await quoteToken.getAddress(),
    ethers.parseUnits("2000", 18),     // i = 2000 USDC/ETH
    ethers.parseUnits("0.5", 18),      // K = 0.5
    ethers.parseUnits("0.003", 18),    // fee = 0.3%
    agentWallets.map(w => w.address),  // 4 agents
    3                                   // 3-of-4 consensus
  );
  await pool.waitForDeployment();
  console.log("AI-PMM Pool:", await pool.getAddress());

  // 4. Mint tokens and add liquidity
  const baseAmount = ethers.parseUnits("10", 18);       // 10 WETH
  const quoteAmount = ethers.parseUnits("20000", 6);    // 20000 USDC

  await baseToken.mint(deployer.address, baseAmount);
  await quoteToken.mint(deployer.address, quoteAmount);
  
  await baseToken.approve(await pool.getAddress(), baseAmount);
  await quoteToken.approve(await pool.getAddress(), quoteAmount);
  await pool.addLiquidity(baseAmount, quoteAmount);
  console.log("Liquidity added: 10 WETH + 20000 USDC");

  // 5. Save deployment info
  const deployment = {
    network: "base-sepolia",
    pool: await pool.getAddress(),
    baseToken: await baseToken.getAddress(),
    quoteToken: await quoteToken.getAddress(),
    agents: agentWallets.map((w, idx) => ({
      id: idx + 1,
      address: w.address,
      privateKey: w.privateKey
    })),
    params: { i: "2000", K: "0.5", lpFeeRate: "0.003" },
    deployedAt: new Date().toISOString()
  };

  const fs = require("fs");
  fs.writeFileSync("deployment.json", JSON.stringify(deployment, null, 2));
  console.log("\nDeployment saved to deployment.json");
  console.log("\n⚠️  Fund agent wallets with testnet ETH for gas!");
}

main().catch(console.error);
