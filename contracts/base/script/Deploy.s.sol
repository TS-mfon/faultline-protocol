// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {FaultlineBondEscrow} from "../src/FaultlineBondEscrow.sol";

interface DeployVm {
    function envUint(string calldata key) external returns (uint256);
    function envAddress(string calldata key) external returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract Deploy {
    DeployVm private constant vm = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (FaultlineBondEscrow escrow) {
        require(block.chainid == 84532, "Base Sepolia only");
        address attestor = vm.envAddress("ATTESTOR_ADDRESS");
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        escrow = new FaultlineBondEscrow(0x036CbD53842c5426634e7929541eC2318f3dCF7e, attestor, guardian);
        vm.stopBroadcast();
    }
}
