// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FaultlineBondEscrow as Escrow} from "../src/FaultlineBondEscrow.sol";
import {AdversarialUSDC as Token} from "./AdversarialUSDC.sol";
import {Vm} from "./Vm.sol";

abstract contract EscrowFixture {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant KEY = 0xA11CE; // public test-only signer, never used for deployment
    address internal constant A = address(0x100);
    address internal constant B = address(0x200);
    address internal constant C = address(0x300);
    address internal constant REPAIRER = address(0x400);
    address internal constant GUARDIAN = address(0x500);
    address internal constant OUTSIDER = address(0x600);
    address internal constant SOURCE = address(0x700);
    bytes32 internal constant ID = 0xda7f739f627198465eeab537a6f7a435dc4a0c332f9e4a8462293eb3f4ab7ee0;
    bytes32 internal constant WH = 0xb3014f0e85bdafa8b0d78e1593e970daad07376eb391ac161b6fc9b938293f67;
    bytes32 internal constant CASE = 0xbbfcd4160a1e8674dac62292ae48be4785262ad7078f9ec11b74a254ce70fa06;
    bytes32 internal constant REMEDY = 0xa1a14ff4aab4f1d3efbe2f3fe8e32ec686289ba95e5b2fc3e1f38052d64da522;
    uint256 internal constant CAP = 1000000;
    Token internal token;
    Escrow internal escrow;

    function setUp() public virtual {
        vm.warp(1000000);
        vm.chainId(84532);
        token = new Token();
        escrow = new Escrow(address(token), vm.addr(KEY), GUARDIAN);
        _create(ID, CAP, 101, REPAIRER);
    }

    function _terms(uint256 cap, uint256 price, address recipient)
        internal
        pure
        returns (
            address[] memory agents,
            uint256[] memory caps,
            Escrow.RepairAction[] memory repairs,
            bytes32[] memory nodes,
            uint8[] memory owners
        )
    {
        agents = new address[](3);
        agents[0] = A;
        agents[1] = B;
        agents[2] = C;
        caps = new uint256[](3);
        caps[0] = cap;
        caps[1] = cap + 1;
        caps[2] = cap + 2;
        repairs = new Escrow.RepairAction[](1);
        repairs[0] = Escrow.RepairAction(REMEDY, recipient, price);
        nodes = new bytes32[](4);
        nodes[0] = sha256("n0");
        nodes[1] = sha256("n1");
        nodes[2] = sha256("n2");
        nodes[3] = sha256("n3");
        owners = new uint8[](4);
        owners[0] = 0;
        owners[1] = 1;
        owners[2] = 0;
        owners[3] = 2;
    }

    function _create(bytes32 id, uint256 cap, uint256 price, address recipient) internal {
        (
            address[] memory agents,
            uint256[] memory caps,
            Escrow.RepairAction[] memory repairs,
            bytes32[] memory nodes,
            uint8[] memory owners
        ) = _terms(cap, price, recipient);
        vm.prank(OUTSIDER);
        escrow.createWorkflow(id, WH, agents, caps, cap, repairs, nodes, owners, 4221, SOURCE);
    }

    function _fundOne(bytes32 id, address agent) internal {
        uint256 amount = escrow.bondCap(id, agent);
        token.mint(agent, amount + 10);
        vm.startPrank(agent);
        token.approve(address(escrow), amount);
        escrow.depositBond(id);
        vm.stopPrank();
    }

    function _fund(bytes32 id) internal {
        _fundOne(id, A);
        _fundOne(id, B);
        _fundOne(id, C);
    }

    function _sign(bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _activation(bytes32 id) internal view returns (Escrow.ActivationAuthorization memory a) {
        Escrow.Workflow memory w = escrow.getWorkflow(id);
        a = Escrow.ActivationAuthorization(
            id,
            WH,
            w.termsHash,
            4221,
            SOURCE,
            0,
            sha256("funding-proof"),
            sha256("activation"),
            1,
            w.nextNonce,
            w.hardDeadline
        );
    }

    function _activate(bytes32 id) internal {
        _fund(id);
        Escrow.ActivationAuthorization memory a = _activation(id);
        escrow.activateWorkflow(a, _sign(escrow.hashActivation(a)));
    }

    function _case(bytes32 id) internal {
        _activate(id);
        vm.prank(A);
        escrow.openCase(id, CASE);
    }

    function _classes() internal pure returns (uint8[] memory c) {
        c = new uint8[](4);
        c[0] = 1;
        c[1] = 2;
        c[2] = 1;
        c[3] = 3;
    }

    function _reservation(bytes32 id, uint8[] memory c)
        internal
        view
        returns (Escrow.ReservationAuthorization memory a)
    {
        Escrow.Workflow memory w = escrow.getWorkflow(id);
        a = Escrow.ReservationAuthorization(
            id,
            WH,
            w.termsHash,
            4221,
            SOURCE,
            CASE,
            sha256("responsibility-snapshot"),
            sha256("responsibility-decision"),
            2,
            w.nextNonce,
            w.hardDeadline,
            REMEDY,
            keccak256(abi.encode(c))
        );
    }

    function _reserve(bytes32 id, uint8[] memory c) internal {
        Escrow.ReservationAuthorization memory a = _reservation(id, c);
        escrow.reserveAward(a, c, _sign(escrow.hashReservation(a)));
    }

    function _releaseAuth(bytes32 id) internal view returns (Escrow.ReleaseAuthorization memory a) {
        Escrow.Workflow memory w = escrow.getWorkflow(id);
        a = Escrow.ReleaseAuthorization(
            id,
            WH,
            w.termsHash,
            4221,
            SOURCE,
            CASE,
            sha256("repair-snapshot"),
            sha256("repair-decision"),
            3,
            w.nextNonce,
            w.hardDeadline,
            REMEDY,
            w.reservationDecisionId,
            w.reservationSnapshotHash,
            sha256("repair-artifacts")
        );
    }

    function _release(bytes32 id) internal {
        Escrow.ReleaseAuthorization memory a = _releaseAuth(id);
        escrow.releaseRepair(a, _sign(escrow.hashRelease(a)));
    }

    function _state(bytes32 id, Escrow.State state) internal view {
        require(escrow.getWorkflow(id).state == state, "state mismatch");
    }

    function _eq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "amount mismatch");
    }

    function _badActivation(Escrow.ActivationAuthorization memory a) internal {
        bytes memory sig = _sign(escrow.hashActivation(a));
        vm.expectRevert();
        escrow.activateWorkflow(a, sig);
    }

    function _badReservation(Escrow.ReservationAuthorization memory a, uint8[] memory c) internal {
        bytes memory sig = _sign(escrow.hashReservation(a));
        vm.expectRevert();
        escrow.reserveAward(a, c, sig);
    }

    function _badRelease(Escrow.ReleaseAuthorization memory a) internal {
        bytes memory sig = _sign(escrow.hashRelease(a));
        vm.expectRevert();
        escrow.releaseRepair(a, sig);
    }
}
