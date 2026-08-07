// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockDPPOracle
 * @notice 模拟 DODO DPPOracle 的接口，用于测试 AgentGovernor
 */
contract MockDPPOracle {
    address public owner;
    uint256 public lpFeeRate;
    uint256 public i;
    uint256 public K;
    uint256 public baseReserve;
    uint256 public quoteReserve;

    event ParametersTuned(uint256 newLpFeeRate, uint256 newI, uint256 newK);
    event PriceTuned(uint256 newI);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(uint256 _i, uint256 _K, uint256 _fee) {
        owner = msg.sender;
        i = _i;
        K = _K;
        lpFeeRate = _fee;
        baseReserve = 10e18;
        quoteReserve = 20000e18;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function tuneParameters(
        uint256 newLpFeeRate,
        uint256 newI,
        uint256 newK,
        uint256 minBaseReserve,
        uint256 minQuoteReserve
    ) external onlyOwner returns (bool) {
        require(baseReserve >= minBaseReserve, "RESERVE_NOT_ENOUGH");
        require(quoteReserve >= minQuoteReserve, "RESERVE_NOT_ENOUGH");
        lpFeeRate = newLpFeeRate;
        i = newI;
        K = newK;
        emit ParametersTuned(newLpFeeRate, newI, newK);
        return true;
    }

    function tunePrice(
        uint256 newI,
        uint256 minBaseReserve,
        uint256 minQuoteReserve
    ) external onlyOwner returns (bool) {
        require(baseReserve >= minBaseReserve, "RESERVE_NOT_ENOUGH");
        require(quoteReserve >= minQuoteReserve, "RESERVE_NOT_ENOUGH");
        i = newI;
        emit PriceTuned(newI);
        return true;
    }
}
