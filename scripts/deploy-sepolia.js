/**
 * Deploy AgentGovernor + MockDPPOracle to Eth Sepolia
 * 
 * Demonstrates: AI agents governing a DeFi pool on a live testnet
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  // Step 1: Deploy MockDPPOracle (simulates DODO's DPPOracle)
  console.log("═══ Deploying MockDPPOracle ═══");
  const MockDPPOracle = await hre.ethers.getContractFactory("MockDPPOracle");
  // i = 1900e18 (ETH price), K = 0.5e18, fee = 0.003e18 (0.3%)
  const oracle = await MockDPPOracle.deploy(
    hre.ethers.parseEther("1900"),
    hre.ethers.parseEther("0.5"),
    hre.ethers.parseEther("0.003")
  );
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log("  MockDPPOracle:", oracleAddr);

  // Step 2: Deploy AgentGovernor with 4 agent addresses
  // For demo: use deployer as all 4 agents (in production these are separate keys)
  console.log("\n═══ Deploying AgentGovernor ═══");
  const agents = [
    deployer.address,  // Agent 1: PriceOracle
    deployer.address,  // Agent 2: VolatilitySensor
    deployer.address,  // Agent 3: FeeOptimizer
    deployer.address,  // Agent 4: ConsensusArbiter
  ];
  
  const AgentGovernor = await hre.ethers.getContractFactory("AgentGovernor");
  const governor = await AgentGovernor.deploy(
    oracleAddr,              // _dppOracle
    agents,                  // _agents
    3,                       // _requiredApprovals (3/4)
    hre.ethers.parseEther("1900")  // _initialI
  );
  await governor.waitForDeployment();
  const govAddr = await governor.getAddress();
  console.log("  AgentGovernor:", govAddr);
  console.log("  Quorum: 3/4");
  console.log("  Admin:", deployer.address);

  // Step 3: Transfer DPPOracle ownership to AgentGovernor
  console.log("\n═══ Transferring Ownership ═══");
  const tx = await oracle.transferOwnership(govAddr);
  await tx.wait();
  const newOwner = await oracle.owner();
  console.log("  MockDPPOracle.owner() =", newOwner);
  console.log("  ✅ Ownership transferred to AgentGovernor");

  // Summary
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  Deployment Complete — Eth Sepolia               ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`\n  MockDPPOracle:  ${oracleAddr}`);
  console.log(`  AgentGovernor: ${govAddr}`);
  console.log(`  Chain: Eth Sepolia (11155111)`);
  console.log(`  Explorer: https://sepolia.etherscan.io/address/${govAddr}`);
  console.log(`\n  Next: Run agents/chainpilot-demo.js with GOVERNOR_ADDRESS=${govAddr}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
