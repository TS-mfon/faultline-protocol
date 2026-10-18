// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {EscrowFixture, Escrow} from "./EscrowFixture.sol";

contract AuthorizationTest is EscrowFixture {
    function testActivationRequiresAllFundingAndExactPhase() public {
        _fundOne(ID, A);
        _badActivation(_activation(ID));
        _fundOne(ID, B);
        _fundOne(ID, C);
        Escrow.ActivationAuthorization memory a = _activation(ID);
        a.phase = 2;
        _badActivation(a);
        a = _activation(ID);
        a.caseId = CASE;
        _badActivation(a);
        a = _activation(ID);
        a.snapshotHash = 0;
        _badActivation(a);
        a = _activation(ID);
        a.decisionId = 0;
        _badActivation(a);
        a = _activation(ID);
        a.nonce = 1;
        _badActivation(a);
        a = _activation(ID);
        a.expiry = block.timestamp;
        _badActivation(a);
        a = _activation(ID);
        a.expiry++;
        _badActivation(a);
        a = _activation(ID);
        escrow.activateWorkflow(a, _sign(escrow.hashActivation(a)));
        _badActivation(a);
        _eq(escrow.getWorkflow(ID).nextNonce, 1);
    }

    function testValidSignatureCannotChangeFrozenTermsOrSource() public {
        _fund(ID);
        Escrow.ActivationAuthorization memory a = _activation(ID);
        a.termsHash = sha256("substituted terms");
        _badActivation(a);
        a = _activation(ID);
        a.workflowHash = sha256("other manifest");
        _badActivation(a);
        a = _activation(ID);
        a.genlayerChainId = 4222;
        _badActivation(a);
        a = _activation(ID);
        a.genlayerContract = OUTSIDER;
        _badActivation(a);
    }

    function testEveryActivationFieldIsSigned() public {
        _fund(ID);
        Escrow.ActivationAuthorization memory a = _activation(ID);
        bytes memory sig = _sign(escrow.hashActivation(a));
        bytes memory encoded = abi.encode(a);
        for (uint256 i; i < 11; ++i) {
            Escrow.ActivationAuthorization memory changed =
                abi.decode(_flip(encoded, i), (Escrow.ActivationAuthorization));
            (bool ok,) = address(escrow).call(abi.encodeCall(escrow.activateWorkflow, (changed, sig)));
            require(!ok, "unsigned activation field");
        }
        escrow.activateWorkflow(a, sig);
    }

    function testEveryReservationFieldIsSigned() public {
        _case(ID);
        uint8[] memory c = _classes();
        Escrow.ReservationAuthorization memory a = _reservation(ID, c);
        bytes memory sig = _sign(escrow.hashReservation(a));
        bytes memory encoded = abi.encode(a);
        for (uint256 i; i < 13; ++i) {
            Escrow.ReservationAuthorization memory changed =
                abi.decode(_flip(encoded, i), (Escrow.ReservationAuthorization));
            (bool ok,) = address(escrow).call(abi.encodeCall(escrow.reserveAward, (changed, c, sig)));
            require(!ok, "unsigned reservation field");
        }
        escrow.reserveAward(a, c, sig);
    }

    function testEveryReleaseFieldIsSigned() public {
        _case(ID);
        _reserve(ID, _classes());
        Escrow.ReleaseAuthorization memory a = _releaseAuth(ID);
        bytes memory sig = _sign(escrow.hashRelease(a));
        bytes memory encoded = abi.encode(a);
        for (uint256 i; i < 15; ++i) {
            Escrow.ReleaseAuthorization memory changed = abi.decode(_flip(encoded, i), (Escrow.ReleaseAuthorization));
            (bool ok,) = address(escrow).call(abi.encodeCall(escrow.releaseRepair, (changed, sig)));
            require(!ok, "unsigned release field");
        }
        escrow.releaseRepair(a, sig);
    }

    function _flip(bytes memory encoded, uint256 index) private pure returns (bytes memory changed) {
        changed = new bytes(encoded.length);
        for (uint256 j; j < encoded.length; ++j) {
            changed[j] = encoded[j];
        }
        changed[index * 32 + 31] = bytes1(uint8(changed[index * 32 + 31]) ^ 1);
    }

    function testCrossChainDomainRejectsReplay() public {
        _fund(ID);
        Escrow.ActivationAuthorization memory a = _activation(ID);
        bytes memory sig = _sign(escrow.hashActivation(a));
        vm.chainId(8453);
        vm.expectRevert(Escrow.InvalidSignature.selector);
        escrow.activateWorkflow(a, sig);
        vm.chainId(84532);
        escrow.activateWorkflow(a, sig);
    }

    function testCrossContractDomainRejectsReplay() public {
        _fund(ID);
        Escrow.ActivationAuthorization memory a = _activation(ID);
        bytes memory sig = _sign(escrow.hashActivation(a));
        escrow = new Escrow(address(token), vm.addr(KEY), GUARDIAN);
        _create(ID, CAP, 101, REPAIRER);
        _fund(ID);
        vm.expectRevert(Escrow.InvalidSignature.selector);
        escrow.activateWorkflow(a, sig);
    }

    function testCrossWorkflowReplayRejectsEvenSameManifest() public {
        _fund(ID);
        Escrow.ActivationAuthorization memory a = _activation(ID);
        bytes memory sig = _sign(escrow.hashActivation(a));
        bytes32 other = sha256("other");
        _create(other, CAP, 101, REPAIRER);
        _fund(other);
        a.workflowId = other;
        a.termsHash = escrow.getWorkflow(other).termsHash;
        vm.expectRevert(Escrow.InvalidSignature.selector);
        escrow.activateWorkflow(a, sig);
    }

    function testHighSMalleabilityBadVZeroRAndWrongSigner() public {
        _fund(ID);
        Escrow.ActivationAuthorization memory a = _activation(ID);
        bytes32 digest = escrow.hashActivation(a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, digest);
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        vm.expectRevert(Escrow.InvalidSignature.selector);
        escrow.activateWorkflow(a, abi.encodePacked(r, bytes32(order - uint256(s)), uint8(v == 27 ? 28 : 27)));
        vm.expectRevert(Escrow.InvalidSignature.selector);
        escrow.activateWorkflow(a, abi.encodePacked(r, s, uint8(v - 27)));
        vm.expectRevert(Escrow.InvalidSignature.selector);
        escrow.activateWorkflow(a, abi.encodePacked(bytes32(0), s, v));
        vm.expectRevert(Escrow.InvalidSignature.selector);
        escrow.activateWorkflow(a, abi.encodePacked(r, bytes32(0), v));
        vm.expectRevert(Escrow.InvalidSignature.selector);
        escrow.activateWorkflow(a, new bytes(64));
        vm.expectRevert(Escrow.InvalidSignature.selector);
        escrow.activateWorkflow(a, new bytes(66));
        (v, r, s) = vm.sign(KEY + 1, digest);
        vm.expectRevert(Escrow.InvalidSignature.selector);
        escrow.activateWorkflow(a, abi.encodePacked(r, s, v));
    }

    function testRejectAwardBeforeCaseAndReleaseBeforeReservation() public {
        _activate(ID);
        _badReservation(_reservation(ID, _classes()), _classes());
        _badRelease(_releaseAuth(ID));
    }

    function testReservationSemanticBindingEvenWithAttestorSignature() public {
        _case(ID);
        uint8[] memory c = _classes();
        Escrow.ReservationAuthorization memory a = _reservation(ID, c);
        a.phase = 1;
        _badReservation(a, c);
        a = _reservation(ID, c);
        a.caseId = sha256("other case");
        _badReservation(a, c);
        a = _reservation(ID, c);
        a.remedyId = sha256("unknown remedy");
        _badReservation(a, c);
        a = _reservation(ID, c);
        a.snapshotHash = 0;
        _badReservation(a, c);
        a = _reservation(ID, c);
        a.decisionId = 0;
        _badReservation(a, c);
        a = _reservation(ID, c);
        a.decisionId = sha256("activation");
        _badReservation(a, c);
        a = _reservation(ID, c);
        a.classesHash = bytes32(0);
        _badReservation(a, c);
        a = _reservation(ID, c);
        a.genlayerContract = OUTSIDER;
        _badReservation(a, c);
        a = _reservation(ID, c);
        a.genlayerChainId = 1;
        _badReservation(a, c);
        a = _reservation(ID, c);
        a.nonce = 0;
        _badReservation(a, c);
    }

    function testReleaseRequiresNewJudgmentAndExactReservedCommitments() public {
        _case(ID);
        _reserve(ID, _classes());
        Escrow.ReleaseAuthorization memory a = _releaseAuth(ID);
        a.phase = 2;
        _badRelease(a);
        a = _releaseAuth(ID);
        a.decisionId = a.reservationDecisionId;
        _badRelease(a);
        a = _releaseAuth(ID);
        a.decisionId = sha256("activation");
        _badRelease(a);
        a = _releaseAuth(ID);
        a.decisionId = 0;
        _badRelease(a);
        a = _releaseAuth(ID);
        a.snapshotHash = 0;
        _badRelease(a);
        a = _releaseAuth(ID);
        a.repairHash = 0;
        _badRelease(a);
        a = _releaseAuth(ID);
        a.caseId = 0;
        _badRelease(a);
        a = _releaseAuth(ID);
        a.remedyId = 0;
        _badRelease(a);
        a = _releaseAuth(ID);
        a.reservationDecisionId = sha256("wrong judgment");
        _badRelease(a);
        a = _releaseAuth(ID);
        a.reservationSnapshotHash = sha256("wrong snapshot");
        _badRelease(a);
        a = _releaseAuth(ID);
        a.genlayerChainId = 1;
        _badRelease(a);
        a = _releaseAuth(ID);
        a.genlayerContract = OUTSIDER;
        _badRelease(a);
        a = _releaseAuth(ID);
        a.nonce = 1;
        _badRelease(a);
        _eq(escrow.balance(ID, REPAIRER), 0);
    }

    function testClassArrayCannotBeReorderedAfterSigning() public {
        _case(ID);
        uint8[] memory c = _classes();
        Escrow.ReservationAuthorization memory a = _reservation(ID, c);
        bytes memory sig = _sign(escrow.hashReservation(a));
        c[0] = 2;
        c[1] = 1;
        vm.expectRevert(Escrow.InvalidAuthorization.selector);
        escrow.reserveAward(a, c, sig);
    }

    function testOmittedInvalidUnresolvedAndWrongLengthClasses() public {
        _case(ID);
        uint8[] memory c = new uint8[](4);
        _badReservation(_reservation(ID, c), c);
        c[0] = 5;
        _badReservation(_reservation(ID, c), c);
        c[0] = 6;
        _badReservation(_reservation(ID, c), c);
        c[0] = 255;
        _badReservation(_reservation(ID, c), c);
        c = new uint8[](3);
        c[0] = 1;
        _badReservation(_reservation(ID, c), c);
        c = new uint8[](5);
        c[0] = 1;
        _badReservation(_reservation(ID, c), c);
    }

    function testDistinctEip712TypehashesAndIndependentActivationEncoding() public view {
        bytes32 activationType = keccak256(
            "ActivationAuthorization(bytes32 workflowId,bytes32 workflowHash,bytes32 termsHash,uint256 genlayerChainId,address genlayerContract,bytes32 caseId,bytes32 snapshotHash,bytes32 decisionId,uint8 phase,uint256 nonce,uint256 expiry)"
        );
        Escrow.ActivationAuthorization memory a = _activation(ID);
        bytes32 structHash = keccak256(
            abi.encode(
                activationType,
                a.workflowId,
                a.workflowHash,
                a.termsHash,
                a.genlayerChainId,
                a.genlayerContract,
                a.caseId,
                a.snapshotHash,
                a.decisionId,
                a.phase,
                a.nonce,
                a.expiry
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("FaultlineBondEscrow"),
                keccak256("1"),
                uint256(84532),
                address(escrow)
            )
        );
        require(escrow.hashActivation(a) == keccak256(abi.encodePacked(hex"1901", domain, structHash)), "EIP712 parity");
        require(
            activationType != escrow.RESERVATION_TYPEHASH() && activationType != escrow.RELEASE_TYPEHASH()
                && escrow.RESERVATION_TYPEHASH() != escrow.RELEASE_TYPEHASH(),
            "types must differ"
        );
    }

    function testPauseBlocksPendingReservationAndRelease() public {
        _case(ID);
        vm.prank(GUARDIAN);
        escrow.pause(true);
        _badReservation(_reservation(ID, _classes()), _classes());
        vm.prank(GUARDIAN);
        escrow.pause(false);
        _reserve(ID, _classes());
        vm.prank(GUARDIAN);
        escrow.pause(true);
        _badRelease(_releaseAuth(ID));
        vm.warp(escrow.getWorkflow(ID).repairDeadline);
        escrow.refundExpired(ID);
    }
}
