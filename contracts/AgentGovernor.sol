// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentGovernor
 * @notice 轻量 AI Agent 多签治理合约，作为 DPPOracle 的 owner
 * 
 * 这个合约不改 DODO 任何代码。它只做一件事：
 * 收集 AI agent 的共识，然后以 owner 身份调用 DPPOracle.tuneParameters()
 * 
 * 用于 DIP 提案的 Phase 1 demo
 */

interface IDPPOracle {
    function tuneParameters(
        uint256 newLpFeeRate,
        uint256 newI,
        uint256 newK,
        uint256 minBaseReserve,
        uint256 minQuoteReserve
    ) external returns (bool);

    function tunePrice(
        uint256 newI,
        uint256 minBaseReserve,
        uint256 minQuoteReserve
    ) external returns (bool);
}

contract AgentGovernor {
    // ============ Storage ============

    address public dppOracle;         // target pool
    address public humanOwner;        // emergency override
    address[] public agents;
    uint256 public requiredApprovals; // M of N
    uint256 public proposalCount;

    // Safety bounds
    uint256 public maxPriceDeviation = 5e16;  // 5% max change per update
    uint256 public updateCooldown = 1;        // min blocks between updates
    uint256 public lastUpdateBlock;
    uint256 public lastI;                     // last known i for deviation check

    // Heartbeat
    uint256 public lastAgentActivity;
    uint256 public heartbeatTimeout = 300;    // 300 blocks (~10min on Base)

    // ============ Proposal ============

    struct Proposal {
        uint256 newI;
        uint256 newK;
        uint256 newFeeRate;
        uint256 minBaseReserve;
        uint256 minQuoteReserve;
        uint256 approvals;
        uint256 createdAt;
        bool executed;
        bool priceOnly;  // only tune price, not K/fee
        mapping(address => bool) hasApproved;
    }

    mapping(uint256 => Proposal) public proposals;

    // ============ Events ============

    event ProposalCreated(uint256 indexed id, address agent, uint256 newI, uint256 newK, uint256 newFee);
    event ProposalApproved(uint256 indexed id, address agent, uint256 totalApprovals);
    event Executed(uint256 indexed id, uint256 newI, uint256 newK, uint256 newFee);
    event HeartbeatReset(address agent);
    event EmergencyPause(address humanOwner);

    // ============ Modifiers ============

    modifier onlyAgent() {
        require(_isAgent(msg.sender), "NOT_AGENT");
        _;
    }

    modifier onlyHuman() {
        require(msg.sender == humanOwner, "NOT_HUMAN_OWNER");
        _;
    }

    modifier poolAlive() {
        require(block.number - lastAgentActivity < heartbeatTimeout, "HEARTBEAT_DEAD");
        _;
    }

    // ============ Constructor ============

    constructor(
        address _dppOracle,
        address[] memory _agents,
        uint256 _requiredApprovals,
        uint256 _initialI
    ) {
        require(_agents.length >= _requiredApprovals && _requiredApprovals > 0, "INVALID_CONFIG");
        dppOracle = _dppOracle;
        humanOwner = msg.sender;
        agents = _agents;
        requiredApprovals = _requiredApprovals;
        lastI = _initialI;
        lastAgentActivity = block.number;
    }

    // ============ Agent Functions ============

    function propose(
        uint256 newI,
        uint256 newK,
        uint256 newFeeRate,
        uint256 minBaseReserve,
        uint256 minQuoteReserve
    ) external onlyAgent poolAlive returns (uint256) {
        // Safety: price deviation check
        if (lastI > 0) {
            uint256 deviation = newI > lastI 
                ? (newI - lastI) * 1e18 / lastI 
                : (lastI - newI) * 1e18 / lastI;
            require(deviation <= maxPriceDeviation, "PRICE_DEVIATION_TOO_HIGH");
        }

        // Safety: parameter bounds
        require(newK >= 5e16 && newK <= 1e18, "K_OUT_OF_RANGE");
        require(newFeeRate <= 5e16, "FEE_TOO_HIGH");

        uint256 id = proposalCount++;
        Proposal storage p = proposals[id];
        p.newI = newI;
        p.newK = newK;
        p.newFeeRate = newFeeRate;
        p.minBaseReserve = minBaseReserve;
        p.minQuoteReserve = minQuoteReserve;
        p.approvals = 1;
        p.createdAt = block.timestamp;
        p.hasApproved[msg.sender] = true;

        lastAgentActivity = block.number;
        emit ProposalCreated(id, msg.sender, newI, newK, newFeeRate);

        if (p.approvals >= requiredApprovals) {
            _execute(id);
        }
        return id;
    }

    function proposePriceOnly(
        uint256 newI,
        uint256 minBaseReserve,
        uint256 minQuoteReserve
    ) external onlyAgent poolAlive returns (uint256) {
        if (lastI > 0) {
            uint256 deviation = newI > lastI 
                ? (newI - lastI) * 1e18 / lastI 
                : (lastI - newI) * 1e18 / lastI;
            require(deviation <= maxPriceDeviation, "PRICE_DEVIATION_TOO_HIGH");
        }

        uint256 id = proposalCount++;
        Proposal storage p = proposals[id];
        p.newI = newI;
        p.minBaseReserve = minBaseReserve;
        p.minQuoteReserve = minQuoteReserve;
        p.approvals = 1;
        p.createdAt = block.timestamp;
        p.priceOnly = true;
        p.hasApproved[msg.sender] = true;

        lastAgentActivity = block.number;

        if (p.approvals >= requiredApprovals) {
            _execute(id);
        }
        return id;
    }

    function approve(uint256 id) external onlyAgent poolAlive {
        Proposal storage p = proposals[id];
        require(!p.executed, "ALREADY_EXECUTED");
        require(block.timestamp - p.createdAt <= 60, "EXPIRED");
        require(!p.hasApproved[msg.sender], "ALREADY_APPROVED");

        p.hasApproved[msg.sender] = true;
        p.approvals++;
        lastAgentActivity = block.number;

        emit ProposalApproved(id, msg.sender, p.approvals);

        if (p.approvals >= requiredApprovals) {
            _execute(id);
        }
    }

    // ============ Internal ============

    function _execute(uint256 id) internal {
        Proposal storage p = proposals[id];
        require(!p.executed, "ALREADY_EXECUTED");
        require(block.number > lastUpdateBlock + updateCooldown, "COOLDOWN");

        p.executed = true;
        lastUpdateBlock = block.number;
        lastI = p.newI;

        if (p.priceOnly) {
            IDPPOracle(dppOracle).tunePrice(p.newI, p.minBaseReserve, p.minQuoteReserve);
        } else {
            IDPPOracle(dppOracle).tuneParameters(
                p.newFeeRate, p.newI, p.newK, 
                p.minBaseReserve, p.minQuoteReserve
            );
        }

        emit Executed(id, p.newI, p.newK, p.newFeeRate);
    }

    // ============ Human Override ============

    function emergencyPause() external onlyHuman {
        // Set heartbeat to dead so no new proposals execute
        lastAgentActivity = 0;
        emit EmergencyPause(msg.sender);
    }

    function updateConfig(
        uint256 _maxDeviation,
        uint256 _cooldown,
        uint256 _heartbeat
    ) external onlyHuman {
        maxPriceDeviation = _maxDeviation;
        updateCooldown = _cooldown;
        heartbeatTimeout = _heartbeat;
    }

    function transferPoolOwnership(address newOwner) external onlyHuman {
        // If we need to hand control back or to a new governor
        // This requires DPPOracle to have a transferOwnership function
        // For now, just update the pointer
        dppOracle = newOwner;
    }

    // ============ View ============

    function _isAgent(address addr) internal view returns (bool) {
        for (uint j = 0; j < agents.length; j++) {
            if (agents[j] == addr) return true;
        }
        return false;
    }

    function getAgents() external view returns (address[] memory) {
        return agents;
    }

    function isAlive() external view returns (bool) {
        return block.number - lastAgentActivity < heartbeatTimeout;
    }
}
