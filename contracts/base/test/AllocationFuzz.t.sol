// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {EscrowFixture, Escrow} from "./EscrowFixture.sol";

contract AllocationFuzzTest is EscrowFixture {
    /// @dev Independent conservation/refund properties over arbitrary eight-node owner/class patterns.
    function testFuzzEightNodeAllocationConservationAndSettlement(uint96 rawPrice, uint64 pattern, bool repairAccepted)
        public
    {
        uint256 price = uint256(rawPrice) % (10 ** 24 - 3) + 1;
        uint256 cap = 10 ** 24 - 3;
        (address[] memory agents, uint256[] memory caps, Escrow.RepairAction[] memory repairs,,) =
            _terms(cap, price, REPAIRER);
        bytes32[] memory nodes = new bytes32[](8);
        uint8[] memory owners = new uint8[](8);
        uint8[] memory classes = new uint8[](8);
        uint256[3] memory expectedWeights;
        for (uint8 i; i < 8; ++i) {
            nodes[i] = sha256(abi.encode(i));
            owners[i] = i < 3 ? i : uint8((pattern >> (i * 3)) % 3);
            classes[i] = i == 0 ? 1 : uint8((pattern >> (i * 5)) % 5);
            if (classes[i] == 1) {
                expectedWeights[owners[i]] += 3;
            } else if (classes[i] == 2) {
                expectedWeights[owners[i]] += 1;
            }
        }
        bytes32 id = sha256("fuzz");
        escrow.createWorkflow(id, WH, agents, caps, cap, repairs, nodes, owners, 4221, SOURCE);
        _case(id);
        _reserve(id, classes);
        uint256 totalWeight = expectedWeights[0] + expectedWeights[1] + expectedWeights[2];
        uint256 sumDebits;
        uint256 residual;
        uint256 sumFloors;
        for (uint256 i; i < 3; ++i) {
            sumFloors += price * expectedWeights[i] / totalWeight;
        }
        uint256 remainder = price - sumFloors;
        for (uint256 i; i < 3; ++i) {
            uint256 debit = escrow.reservedDebit(id, agents[i]);
            uint256 quota = price * expectedWeights[i] / totalWeight;
            if (remainder > 0 && expectedWeights[i] != 0) {
                ++quota;
                --remainder;
            }
            _eq(debit, quota);
            require(debit <= caps[i], "cap violated");
            if (expectedWeights[i] == 0) {
                _eq(debit, 0);
            }
            sumDebits += debit;
            residual += escrow.balance(id, agents[i]);
        }
        _eq(sumDebits, price);
        _eq(residual + price, cap * 3 + 3);
        if (repairAccepted) {
            _release(id);
        } else {
            vm.warp(escrow.getWorkflow(id).repairDeadline);
            escrow.refundExpired(id);
        }
        vm.prank(GUARDIAN);
        escrow.pause(true);
        for (uint256 i; i < 3; ++i) {
            if (!repairAccepted) {
                _eq(escrow.balance(id, agents[i]), caps[i]);
            }
            if (escrow.balance(id, agents[i]) > 0) {
                escrow.withdrawFor(id, agents[i]);
            }
            if (!repairAccepted) {
                _eq(token.balanceOf(agents[i]), caps[i] + 10);
            }
        }
        if (repairAccepted) {
            escrow.withdrawFor(id, REPAIRER);
            _eq(token.balanceOf(REPAIRER), price);
        } else {
            _eq(token.balanceOf(REPAIRER), 0);
        }
        _eq(escrow.totalLiability(), 0);
        _eq(token.balanceOf(address(escrow)), 0);
    }

    function testFuzzExpiredPartialFundingNeverCreatesCredit(uint8 depositMask, uint32 extraTime) public {
        address[3] memory agents = [A, B, C];
        uint256 total;
        for (uint256 i; i < 3; ++i) {
            if (depositMask & (1 << i) != 0) {
                _fundOne(ID, agents[i]);
                total += CAP + i;
            }
        }
        _eq(escrow.totalLiability(), total);
        vm.warp(escrow.getWorkflow(ID).hardDeadline + uint256(extraTime));
        vm.prank(GUARDIAN);
        escrow.pause(true);
        escrow.refundExpired(ID);
        for (uint256 i; i < 3; ++i) {
            uint256 expected = depositMask & (1 << i) != 0 ? CAP + i : 0;
            _eq(escrow.balance(ID, agents[i]), expected);
            if (expected > 0) {
                escrow.withdrawFor(ID, agents[i]);
            }
        }
        escrow.refundExpired(ID);
        _eq(escrow.totalLiability(), 0);
        _eq(token.balanceOf(address(escrow)), 0);
    }

    function testFuzzSignatureExpiryHasExclusiveBoundary(uint32 lifetime, bool atDeadline) public {
        _fund(ID);
        Escrow.ActivationAuthorization memory a = _activation(ID);
        uint256 delta = uint256(lifetime) % (7 days - 1) + 1;
        a.expiry = block.timestamp + delta;
        bytes memory sig = _sign(escrow.hashActivation(a));
        vm.warp(a.expiry - (atDeadline ? 0 : 1));
        if (atDeadline) {
            vm.expectRevert(Escrow.InvalidAuthorization.selector);
            escrow.activateWorkflow(a, sig);
        } else {
            escrow.activateWorkflow(a, sig);
            _state(ID, Escrow.State.Active);
        }
    }
}
