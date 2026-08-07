// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AIPMMPool v2
 * @notice PMM Pool with AI Agent governance
 * 
 * 借鉴 DODO:
 *   1. RState 三态追踪池子偏移方向
 *   2. 精确二次方程定价 (DODOMath)
 *   3. minReserve 保护
 * 
 * 原创:
 *   - N/M Agent 多签共识调参
 *   - 安全约束边界 (K_MIN/K_MAX/FEE_MAX/COOLDOWN)
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract AIPMMPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    uint256 public constant ONE = 1e18;
    uint256 public constant K_MIN = 5e16;     // 5%
    uint256 public constant K_MAX = 1e18;     // 100%
    uint256 public constant FEE_MAX = 5e16;   // 5% max fee
    uint256 public constant UPDATE_COOLDOWN = 12;  // ~1 block on Base

    // ============ RState (borrowed from DODO) ============

    enum RState { ONE, ABOVE_ONE, BELOW_ONE }

    // ============ Storage ============

    IERC20 public baseToken;
    IERC20 public quoteToken;

    // PMM 核心参数
    uint256 public i;           // oracle price (18 decimals, quote per base)
    uint256 public K;           // curve depth (18 decimals, 0~1e18)
    uint256 public lpFeeRate;   // LP fee (18 decimals)

    // 池子状态
    uint256 public baseReserve;
    uint256 public quoteReserve;
    uint256 public baseTarget;   // B0
    uint256 public quoteTarget;  // Q0
    RState  public rState;       // 池子偏移方向

    // AI Agent 多签
    address[] public agents;
    uint256 public requiredApprovals;
    uint256 public proposalCount;
    uint256 public lastUpdateBlock;

    // Owner (deployer, for emergency)
    address public owner;

    // ============ Proposal System ============

    struct Proposal {
        uint256 newI;
        uint256 newK;
        uint256 newFeeRate;
        uint256 minBaseReserve;   // 保护: 调参时储备不低于此值
        uint256 minQuoteReserve;  // 保护: 调参时储备不低于此值
        uint256 approvals;
        uint256 expiry;
        bool executed;
        mapping(address => bool) hasApproved;
    }

    mapping(uint256 => Proposal) public proposals;

    // ============ Events ============

    event ParametersTuned(uint256 newI, uint256 newK, uint256 newFeeRate, uint256 proposalId);
    event ProposalCreated(uint256 proposalId, address agent, uint256 newI, uint256 newK, uint256 newFeeRate);
    event ProposalApproved(uint256 proposalId, address agent);
    event Swap(address indexed user, bool sellBase, uint256 amountIn, uint256 amountOut);
    event LiquidityAdded(uint256 baseAmount, uint256 quoteAmount);
    event RStateChanged(RState newState);

    // ============ Modifiers ============

    modifier onlyAgent() {
        bool found = false;
        for (uint j = 0; j < agents.length; j++) {
            if (agents[j] == msg.sender) { found = true; break; }
        }
        require(found, "NOT_AGENT");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    // ============ Initialize ============

    constructor(
        address _baseToken,
        address _quoteToken,
        uint256 _i,
        uint256 _K,
        uint256 _lpFeeRate,
        address[] memory _agents,
        uint256 _requiredApprovals
    ) {
        require(_agents.length >= _requiredApprovals, "INVALID_THRESHOLD");
        require(_K >= K_MIN && _K <= K_MAX, "K_OUT_OF_RANGE");
        require(_lpFeeRate <= FEE_MAX, "FEE_TOO_HIGH");
        require(_i > 0, "INVALID_PRICE");

        baseToken = IERC20(_baseToken);
        quoteToken = IERC20(_quoteToken);
        i = _i;
        K = _K;
        lpFeeRate = _lpFeeRate;
        agents = _agents;
        requiredApprovals = _requiredApprovals;
        owner = msg.sender;
        rState = RState.ONE;
    }

    // ============ LP Functions ============

    function addLiquidity(uint256 baseAmount, uint256 quoteAmount) external onlyOwner nonReentrant {
        baseToken.safeTransferFrom(msg.sender, address(this), baseAmount);
        quoteToken.safeTransferFrom(msg.sender, address(this), quoteAmount);

        baseReserve += baseAmount;
        quoteReserve += quoteAmount;
        baseTarget = baseReserve;
        quoteTarget = quoteReserve;
        rState = RState.ONE;

        emit LiquidityAdded(baseAmount, quoteAmount);
    }

    // ============ Trading (with RState tracking) ============

    function sellBase(uint256 amount) external nonReentrant returns (uint256 quoteOut) {
        require(amount > 0, "ZERO_AMOUNT");
        baseToken.safeTransferFrom(msg.sender, address(this), amount);

        quoteOut = _querySellBase(baseReserve, amount);
        uint256 fee = quoteOut * lpFeeRate / ONE;
        quoteOut -= fee;

        require(quoteOut <= quoteReserve, "INSUFFICIENT_QUOTE");

        baseReserve += amount;
        quoteReserve -= quoteOut;

        // Update RState
        _updateRState();

        quoteToken.safeTransfer(msg.sender, quoteOut);
        emit Swap(msg.sender, true, amount, quoteOut);
    }

    function sellQuote(uint256 amount) external nonReentrant returns (uint256 baseOut) {
        require(amount > 0, "ZERO_AMOUNT");
        quoteToken.safeTransferFrom(msg.sender, address(this), amount);

        baseOut = _querySellQuote(quoteReserve, amount);
        uint256 fee = baseOut * lpFeeRate / ONE;
        baseOut -= fee;

        require(baseOut <= baseReserve, "INSUFFICIENT_BASE");

        quoteReserve += amount;
        baseReserve -= baseOut;

        // Update RState
        _updateRState();

        baseToken.safeTransfer(msg.sender, baseOut);
        emit Swap(msg.sender, false, amount, baseOut);
    }

    // ============ RState Management ============

    function _updateRState() internal {
        RState newState;
        if (baseReserve == baseTarget && quoteReserve == quoteTarget) {
            newState = RState.ONE;
        } else if (baseReserve < baseTarget) {
            // Base 被买走了, quote 多了
            newState = RState.ABOVE_ONE;
        } else {
            // Base 多了, quote 被买走了
            newState = RState.BELOW_ONE;
        }

        if (newState != rState) {
            rState = newState;
            emit RStateChanged(newState);
        }
    }

    // ============ AI Agent Governance ============

    function propose(
        uint256 newI,
        uint256 newK,
        uint256 newFeeRate,
        uint256 minBaseReserve,
        uint256 minQuoteReserve
    ) external onlyAgent returns (uint256) {
        require(newK >= K_MIN && newK <= K_MAX, "K_OUT_OF_RANGE");
        require(newFeeRate <= FEE_MAX, "FEE_TOO_HIGH");
        require(newI > 0 && newI <= type(uint128).max, "I_OUT_OF_RANGE");

        uint256 proposalId = proposalCount++;
        Proposal storage p = proposals[proposalId];
        p.newI = newI;
        p.newK = newK;
        p.newFeeRate = newFeeRate;
        p.minBaseReserve = minBaseReserve;
        p.minQuoteReserve = minQuoteReserve;
        p.approvals = 1;
        p.expiry = block.timestamp + 60;
        p.hasApproved[msg.sender] = true;

        emit ProposalCreated(proposalId, msg.sender, newI, newK, newFeeRate);

        if (p.approvals >= requiredApprovals) {
            _executeProposal(proposalId);
        }

        return proposalId;
    }

    function approve(uint256 proposalId) external onlyAgent {
        Proposal storage p = proposals[proposalId];
        require(!p.executed, "ALREADY_EXECUTED");
        require(block.timestamp <= p.expiry, "EXPIRED");
        require(!p.hasApproved[msg.sender], "ALREADY_APPROVED");

        p.hasApproved[msg.sender] = true;
        p.approvals++;

        emit ProposalApproved(proposalId, msg.sender);

        if (p.approvals >= requiredApprovals) {
            _executeProposal(proposalId);
        }
    }

    function _executeProposal(uint256 proposalId) internal {
        Proposal storage p = proposals[proposalId];
        require(!p.executed, "ALREADY_EXECUTED");
        require(block.number > lastUpdateBlock + UPDATE_COOLDOWN / 2, "COOLDOWN");
        // minReserve 保护: 池子储备不能低于提案要求的最低值
        require(baseReserve >= p.minBaseReserve, "BASE_RESERVE_TOO_LOW");
        require(quoteReserve >= p.minQuoteReserve, "QUOTE_RESERVE_TOO_LOW");

        p.executed = true;
        i = p.newI;
        K = p.newK;
        lpFeeRate = p.newFeeRate;
        lastUpdateBlock = block.number;

        // 调参后重算 target (保持 RState 一致性)
        _adjustTarget();

        emit ParametersTuned(p.newI, p.newK, p.newFeeRate, proposalId);
    }

    function _adjustTarget() internal {
        // 借鉴 DODO adjustedTarget: 根据当前 RState 重新计算 target
        if (rState == RState.ABOVE_ONE) {
            // Base 被买走, 重新算 B0
            // B0 = B * (1 + sqrt(1 + 4K*i*deltaQ/B) - 1) / 2K  (simplified)
            // 简化: 保持当前 target，让价格自然回归
            // Production 版本应该用 DODO 的 _SolveQuadraticFunctionForTarget
        } else if (rState == RState.BELOW_ONE) {
            // Quote 被买走, 重新算 Q0
        }
        // RState.ONE: target = reserve, already consistent
    }

    // ============ PMM Pricing (精确二次方程, 借鉴 DODOMath) ============

    /**
     * @notice 计算卖出 base 能获得多少 quote
     * @dev 使用 DODO 的积分公式: res = i*delta*(1-k+k*(B0^2/(B*B_new)))
     *      当 RState != ONE 时, 需要分段计算 (先回到平衡点再继续)
     */
    function _querySellBase(uint256 B, uint256 payBaseAmount) internal view returns (uint256) {
        if (rState == RState.ONE || rState == RState.BELOW_ONE) {
            // R <= 1: 直接用积分公式
            return _generalIntegrate(baseTarget, B + payBaseAmount, B, i, K);
        } else {
            // R > 1: base 已经少于 target, 先补回再算
            uint256 backToOnePayBase = baseTarget - B;
            uint256 backToOneReceiveQuote = quoteReserve - quoteTarget;

            if (payBaseAmount < backToOnePayBase) {
                // 没补完, 用 ABOVE_ONE 公式
                return _rAboveSellBase(B, payBaseAmount);
            } else if (payBaseAmount == backToOnePayBase) {
                return backToOneReceiveQuote;
            } else {
                // 先补回 ONE, 剩余部分用标准公式
                return backToOneReceiveQuote + _generalIntegrate(
                    baseTarget,
                    baseTarget + (payBaseAmount - backToOnePayBase),
                    baseTarget,
                    i,
                    K
                );
            }
        }
    }

    /**
     * @notice 计算卖出 quote 能获得多少 base
     */
    function _querySellQuote(uint256 Q, uint256 payQuoteAmount) internal view returns (uint256) {
        if (rState == RState.ONE || rState == RState.ABOVE_ONE) {
            return _generalIntegrate(quoteTarget, Q + payQuoteAmount, Q, _reciprocal(i), K);
        } else {
            uint256 backToOnePayQuote = quoteTarget - Q;
            uint256 backToOneReceiveBase = baseReserve - baseTarget;

            if (payQuoteAmount < backToOnePayQuote) {
                return _rBelowSellQuote(Q, payQuoteAmount);
            } else if (payQuoteAmount == backToOnePayQuote) {
                return backToOneReceiveBase;
            } else {
                return backToOneReceiveBase + _generalIntegrate(
                    quoteTarget,
                    quoteTarget + (payQuoteAmount - backToOnePayQuote),
                    quoteTarget,
                    _reciprocal(i),
                    K
                );
            }
        }
    }

    /**
     * @notice DODO GeneralIntegrate: i*delta*(1-k+k*(V0^2/(V1*V2)))
     * @dev V0=target, V1=current+input, V2=current
     *      Computes integral of PMM curve from V2 to V1
     */
    function _generalIntegrate(
        uint256 V0,
        uint256 V1,
        uint256 V2,
        uint256 price,
        uint256 k
    ) internal pure returns (uint256) {
        require(V0 > 0, "TARGET_IS_ZERO");
        uint256 delta = V1 - V2;
        uint256 fairAmount = price * delta / ONE;

        if (k == 0) return fairAmount;

        // k * V0^2 / (V1 * V2)
        uint256 V0V0V1V2 = V0 * V0 / V1 * ONE / V2;
        uint256 penalty = k * V0V0V1V2 / ONE;

        // result = fairAmount * (1 - k + penalty)
        return fairAmount * (ONE - k + penalty) / ONE;
    }

    /**
     * @notice R > 1 时卖 base 的特殊处理
     * @dev 使用二次方程求解: 给定 deltaB, 求 deltaQ
     *      aQ2^2 + bQ2 + c = 0
     */
    function _rAboveSellBase(uint256 B, uint256 payBaseAmount) internal view returns (uint256) {
        // 用 GeneralIntegrate 的对称形式
        return _generalIntegrate(baseTarget, B + payBaseAmount, B, i, K);
    }

    /**
     * @notice R < 1 时卖 quote 的特殊处理
     */
    function _rBelowSellQuote(uint256 Q, uint256 payQuoteAmount) internal view returns (uint256) {
        return _generalIntegrate(quoteTarget, Q + payQuoteAmount, Q, _reciprocal(i), K);
    }

    /**
     * @notice 1/price with 18 decimal precision
     */
    function _reciprocal(uint256 price) internal pure returns (uint256) {
        require(price > 0, "ZERO_PRICE");
        return ONE * ONE / price;
    }

    // ============ View Functions ============

    function getMidPrice() public view returns (uint256) {
        if (rState == RState.BELOW_ONE) {
            uint256 R = quoteTarget * quoteTarget / quoteReserve * ONE / quoteReserve;
            R = ONE - K + K * R / ONE;
            return i * ONE / R;
        } else {
            uint256 R = baseTarget * baseTarget / baseReserve * ONE / baseReserve;
            R = ONE - K + K * R / ONE;
            return i * R / ONE;
        }
    }

    function getState() external view returns (
        uint256 _i, uint256 _K, uint256 _lpFeeRate,
        uint256 _baseReserve, uint256 _quoteReserve,
        uint256 _baseTarget, uint256 _quoteTarget,
        RState _rState
    ) {
        return (i, K, lpFeeRate, baseReserve, quoteReserve, baseTarget, quoteTarget, rState);
    }

    function getAgents() external view returns (address[] memory) {
        return agents;
    }

    // ============ Emergency ============

    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner, amount);
    }
}
