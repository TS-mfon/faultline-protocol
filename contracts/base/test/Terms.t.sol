// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {EscrowFixture, Escrow} from "./EscrowFixture.sol";

contract TermsTest is EscrowFixture {
    function testStoredTermsAreExactAbiCommitmentAndCannotBeReplaced() public {
        (
            address[] memory agents,
            uint256[] memory caps,
            Escrow.RepairAction[] memory repairs,
            bytes32[] memory nodes,
            uint8[] memory owners
        ) = _terms(CAP, 101, REPAIRER);
        bytes32 h = keccak256(abi.encode(ID, WH, agents, caps, CAP, repairs, nodes, owners, uint256(4221), SOURCE));
        require(escrow.getWorkflow(ID).termsHash == h, "terms parity");
        repairs[0].recipient = OUTSIDER;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(ID, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        (
            address[] memory actual,
            bytes32[] memory actualNodes,
            uint8[] memory actualOwners,
            Escrow.RepairAction[] memory actualRepairs
        ) = escrow.getTerms(ID);
        require(
            actual.length == 3 && actualNodes.length == 4 && actualOwners[2] == 0
                && actualRepairs[0].recipient == REPAIRER,
            "frozen arrays"
        );
        require(escrow.getWorkflow(ID).termsHash == h, "frozen terms");
    }

    function testEveryBondMustCoverEntireCapAndAmountsBounded() public {
        (
            address[] memory agents,
            uint256[] memory caps,
            Escrow.RepairAction[] memory repairs,
            bytes32[] memory nodes,
            uint8[] memory owners
        ) = _terms(CAP, 101, REPAIRER);
        bytes32 id = sha256("invalid");
        caps[2] = CAP - 1;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        caps[2] = 10 ** 24;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        caps[2] = CAP;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, 0, repairs, nodes, owners, 4221, SOURCE);
        repairs[0].price = CAP + 1;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
    }

    function testParticipantsMustBeUniqueSortedNonzeroEoas() public {
        (
            address[] memory agents,
            uint256[] memory caps,
            Escrow.RepairAction[] memory repairs,
            bytes32[] memory nodes,
            uint8[] memory owners
        ) = _terms(CAP, 101, REPAIRER);
        bytes32 id = sha256("invalid");
        agents[1] = A;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        agents[0] = B;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        agents[0] = address(0);
        agents[1] = B;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        agents[0] = address(token);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
    }

    function testNodeOwnerMappingMustBeCompleteUniqueAndKnown() public {
        (
            address[] memory agents,
            uint256[] memory caps,
            Escrow.RepairAction[] memory repairs,
            bytes32[] memory nodes,
            uint8[] memory owners
        ) = _terms(CAP, 101, REPAIRER);
        bytes32 id = sha256("invalid");
        owners[3] = 3;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        owners[3] = 0; // C owns no node.
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        owners[3] = 2;
        nodes[3] = nodes[0];
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        nodes[3] = 0;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
    }

    function testZeroIdentifiersSourceAndMalformedLengthsReject() public {
        (
            address[] memory agents,
            uint256[] memory caps,
            Escrow.RepairAction[] memory repairs,
            bytes32[] memory nodes,
            uint8[] memory owners
        ) = _terms(CAP, 101, REPAIRER);
        bytes32 id = sha256("invalid");
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(0, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, 0, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 0, SOURCE);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, address(0));
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, new uint256[](2), CAP, repairs, nodes, owners, 4221, SOURCE);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, new uint8[](3), 4221, SOURCE);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, new bytes32[](9), new uint8[](9), 4221, SOURCE);
    }

    function testRemediesRequireValidUniqueIdRecipientPriceAndBoundedList() public {
        (
            address[] memory agents,
            uint256[] memory caps,
            Escrow.RepairAction[] memory repairs,
            bytes32[] memory nodes,
            uint8[] memory owners
        ) = _terms(CAP, 101, REPAIRER);
        bytes32 id = sha256("invalid");
        repairs[0].id = 0;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        repairs[0].id = REMEDY;
        repairs[0].recipient = address(0);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        repairs[0].recipient = address(escrow);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        repairs[0].recipient = REPAIRER;
        repairs[0].price = 0;
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        repairs = new Escrow.RepairAction[](2);
        repairs[0] = Escrow.RepairAction(REMEDY, REPAIRER, 101);
        repairs[1] = repairs[0];
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, repairs, nodes, owners, 4221, SOURCE);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, new Escrow.RepairAction[](0), nodes, owners, 4221, SOURCE);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        escrow.createWorkflow(id, WH, agents, caps, CAP, new Escrow.RepairAction[](9), nodes, owners, 4221, SOURCE);
    }

    function testMaximumAmountsAndEightAgentsEightNodes() public {
        address[] memory agents = new address[](8);
        uint256[] memory caps = new uint256[](8);
        bytes32[] memory nodes = new bytes32[](8);
        uint8[] memory owners = new uint8[](8);
        Escrow.RepairAction[] memory repairs = new Escrow.RepairAction[](8);
        uint256 max = escrow.MAX_AMOUNT();
        for (uint8 i; i < 8; ++i) {
            agents[i] = address(uint160(100 + i));
            caps[i] = max;
            nodes[i] = sha256(abi.encode(i));
            owners[i] = i;
            repairs[i] = Escrow.RepairAction(sha256(abi.encode(i)), REPAIRER, max);
        }
        bytes32 id = sha256("maximum");
        escrow.createWorkflow(id, WH, agents, caps, max, repairs, nodes, owners, 4221, SOURCE);
        for (uint256 i; i < 8; ++i) {
            _fundOne(id, agents[i]);
        }
        Escrow.ActivationAuthorization memory a = _activation(id);
        escrow.activateWorkflow(a, _sign(escrow.hashActivation(a)));
        vm.prank(agents[0]);
        escrow.openCase(id, CASE);
        uint8[] memory c = new uint8[](8);
        for (uint256 i; i < 8; ++i) {
            c[i] = 1;
        }
        Escrow.ReservationAuthorization memory r = _reservation(id, c);
        r.remedyId = repairs[0].id;
        escrow.reserveAward(r, c, _sign(escrow.hashReservation(r)));
        uint256 allocated;
        for (uint256 i; i < 8; ++i) {
            allocated += escrow.reservedDebit(id, agents[i]);
        }
        _eq(allocated, max);
        _eq(escrow.totalLiability(), max * 8);
    }

    function testPauseBlocksCreation() public {
        (
            address[] memory agents,
            uint256[] memory caps,
            Escrow.RepairAction[] memory repairs,
            bytes32[] memory nodes,
            uint8[] memory owners
        ) = _terms(CAP, 101, REPAIRER);
        vm.prank(GUARDIAN);
        escrow.pause(true);
        vm.expectRevert(Escrow.Paused.selector);
        escrow.createWorkflow(
            0xa7a9dc5bcf71adb2edc202814060a5ab6fca515382e9f1133dcc47d52d9090a2,
            WH,
            agents,
            caps,
            CAP,
            repairs,
            nodes,
            owners,
            4221,
            SOURCE
        );
    }
}
