// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Minimal local cheatcode interface. No external test dependencies.
interface Vm {
    function warp(uint256 timestamp) external;
    function chainId(uint256 newChainId) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
}
