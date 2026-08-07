/**
 * Register 4 Oracle Agent identities on BSC Testnet via ERC-8004
 * 
 * Each agent gets an on-chain identity token — discoverable, verifiable.
 * This is the identity layer for AgentGovernor consensus.
 */

const { ERC8004Agent } = require('@bnbagent/sdk/erc8004');
const { EVMWalletProvider } = require('@bnbagent/sdk');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const AGENT_ROLES = [
  { name: 'PriceOracle', description: 'Senses real-time price via ChainPilot. Proposes i parameter adjustments when deviation exceeds threshold.' },
  { name: 'VolatilitySensor', description: 'Monitors market volatility through large/small quote differential. Adjusts K (curve depth) accordingly.' },
  { name: 'FeeOptimizer', description: 'Detects cross-chain arbitrage pressure. Optimizes lpFeeRate to balance LP yield vs volume.' },
  { name: 'ConsensusAggregator', description: 'Aggregates signals from other agents. Triggers governance proposals when consensus conditions are met.' },
];

async function main() {
  console.log('═══ ERC-8004 Agent Identity Registration (BSC Testnet) ═══\n');

  // Load deployer key
  const deployerKey = fs.readFileSync(path.join(process.env.HOME, '.trading_wallet_key'), 'utf8').trim();
  
  // Generate 4 agent wallets (deterministic from deployer + index)
  const agents = [];
  for (let i = 0; i < 4; i++) {
    const wallet = ethers.Wallet.createRandom();
    agents.push(wallet);
  }

  // Fund agents first (need gas for registration)
  const provider = new ethers.JsonRpcProvider('https://bsc-testnet-rpc.publicnode.com');
  const deployer = new ethers.Wallet(deployerKey, provider);
  
  console.log(`Deployer: ${deployer.address}`);
  const balance = await provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} tBNB\n`);

  // Try registering via SDK
  for (let i = 0; i < 4; i++) {
    const role = AGENT_ROLES[i];
    console.log(`  Registering ${role.name} (${agents[i].address})...`);
    
    try {
      // Create wallet provider for this agent
      const agentProvider = new ethers.Wallet(agents[i].privateKey, provider);
      
      // Fund agent for gas
      const fundTx = await deployer.sendTransaction({
        to: agents[i].address,
        value: ethers.parseEther('0.01'),
      });
      await fundTx.wait();
      console.log(`    Funded: 0.01 tBNB`);

      // Use ERC8004Agent to register
      const erc8004 = await ERC8004Agent.create({
        walletProvider: new EVMWalletProvider({
          privateKey: agents[i].privateKey,
          password: 'oracle-agent-' + i,
        }),
        network: 'bsc-testnet',
      });
      
      const uri = erc8004.generateAgentUri({
        name: `AgentGovernor/${role.name}`,
        description: role.description,
        endpoints: [{ url: 'https://ark.honeyhughub.world/oracle', protocol: 'http' }],
      });
      
      const result = await erc8004.registerAgent(uri);
      
      console.log(`    ✅ Registered! ${JSON.stringify(result)}\n`);
    } catch (err) {
      console.log(`    ⚠️  ${err.message}\n`);
    }
  }

  // Save agent info
  const agentInfo = agents.map((a, i) => ({
    role: AGENT_ROLES[i].name,
    address: a.address,
    privateKey: a.privateKey,
  }));
  
  const outPath = path.join(__dirname, '../deployments/bsc-agents.json');
  fs.writeFileSync(outPath, JSON.stringify(agentInfo, null, 2));
  console.log(`Agent keys saved: ${outPath}`);
}

main().catch(console.error);
