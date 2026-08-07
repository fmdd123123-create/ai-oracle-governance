/**
 * Deploy AgentGovernor (quorum=1) for live demo cycle
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  console.log("═══ Deploying MockDPPOracle ═══");
  const MockDPPOracle = await hre.ethers.getContractFactory("MockDPPOracle");
  const oracle = await MockDPPOracle.deploy(
    hre.ethers.parseEther("1900"),
    hre.ethers.parseEther("0.5"),
    hre.ethers.parseEther("0.003")
  );
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log("  MockDPPOracle:", oracleAddr);

  console.log("\n═══ Deploying AgentGovernor (quorum=1 for demo) ═══");
  const agents = [deployer.address];
  
  const AgentGovernor = await hre.ethers.getContractFactory("AgentGovernor");
  const governor = await AgentGovernor.deploy(
    oracleAddr, agents, 1, hre.ethers.parseEther("1900")
  );
  await governor.waitForDeployment();
  const govAddr = await governor.getAddress();
  console.log("  AgentGovernor:", govAddr);

  console.log("\n═══ Transferring Ownership ═══");
  const tx = await oracle.transferOwnership(govAddr);
  await tx.wait();
  console.log("  ✅ Ownership transferred");

  console.log("\n═══ DEPLOYED ═══");
  console.log(`  ORACLE=${oracleAddr}`);
  console.log(`  GOVERNOR=${govAddr}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
