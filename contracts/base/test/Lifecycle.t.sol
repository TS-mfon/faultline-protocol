// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {EscrowFixture, Escrow} from "./EscrowFixture.sol";

contract LifecycleTest is EscrowFixture {
    function testAttestorCanOpenConfirmedCase() public {
        _activate(ID);
        vm.prank(vm.addr(KEY));
        escrow.openCase(ID, CASE);
        require(escrow.getWorkflow(ID).caseId == CASE, "case not opened");
    }

    function testExternalCreatorAndSourceSummary() public view {
        _eq(escrow.bondCap(ID, OUTSIDER), 0);
        Escrow.Workflow memory w = escrow.getWorkflow(ID);
        require(w.workflowHash == WH && w.genlayerContract == SOURCE, "source binding");
        _eq(w.genlayerChainId, 4221);
        _eq(w.hardDeadline, 1000000 + 7 days);
        _state(ID, Escrow.State.Funding);
    }

    function testNodeWeightsAndReservationTransfersNothing() public {
        _case(ID);
        _reserve(ID, _classes()); // A owns two primary nodes (6), B one contributory (1).
        _eq(escrow.reservedDebit(ID, A), 87);
        _eq(escrow.reservedDebit(ID, B), 14);
        _eq(escrow.reservedDebit(ID, C), 0);
        _eq(token.balanceOf(address(escrow)), CAP * 3 + 3);
        _eq(token.balanceOf(REPAIRER), 0);
        _eq(escrow.balance(ID, REPAIRER), 0);
        _eq(escrow.getWorkflow(ID).reserved, 101);
        vm.expectRevert(Escrow.NotMature.selector);
        escrow.withdrawFor(ID, A);
    }

    function testReleaseCreatesFixedCreditsAndAnyoneDrivesPayout() public {
        _case(ID);
        _reserve(ID, _classes());
        _release(ID);
        _eq(token.balanceOf(REPAIRER), 0);
        vm.prank(OUTSIDER);
        escrow.withdrawFor(ID, REPAIRER);
        _eq(token.balanceOf(REPAIRER), 101);
        _eq(token.balanceOf(OUTSIDER), 0);
        escrow.withdrawFor(ID, B);
        escrow.withdrawFor(ID, C);
        escrow.withdrawFor(ID, A);
        _eq(token.balanceOf(A), 10 + CAP - 87);
        _eq(token.balanceOf(B), 10 + CAP + 1 - 14);
        _eq(token.balanceOf(C), 10 + CAP + 2);
        _eq(escrow.totalLiability(), 0);
        _eq(token.balanceOf(address(escrow)), 0);
        _state(ID, Escrow.State.Released);
        require(escrow.getWorkflow(ID).repairHash == sha256("repair-artifacts"), "repair commitment");
        require(escrow.getWorkflow(ID).repairDecisionId == sha256("repair-decision"), "repair judgment");
    }

    function testUnsuccessfulRepairRestoresExactOriginalDebitsWhilePaused() public {
        _case(ID);
        _reserve(ID, _classes());
        uint256 deadline = escrow.getWorkflow(ID).repairDeadline;
        vm.prank(GUARDIAN);
        escrow.pause(true);
        vm.warp(deadline - 1);
        vm.expectRevert(Escrow.NotMature.selector);
        escrow.refundExpired(ID);
        vm.warp(deadline);
        (,, uint256 credit, uint256 debit, uint256 available) = escrow.getAccount(ID, A);
        _eq(credit, CAP - 87);
        _eq(debit, 87);
        _eq(available, CAP);
        escrow.withdrawFor(ID, A); // Lazy expiration: no keeper/guardian cooperation required.
        escrow.refundExpired(ID);
        escrow.refundExpired(ID);
        escrow.withdrawFor(ID, C);
        escrow.withdrawFor(ID, B);
        _eq(token.balanceOf(A), CAP + 10);
        _eq(token.balanceOf(B), CAP + 11);
        _eq(token.balanceOf(C), CAP + 12);
        _eq(escrow.balance(ID, REPAIRER), 0);
        _eq(escrow.reservedDebit(ID, A), 0);
        _eq(escrow.totalLiability(), 0);
        _state(ID, Escrow.State.Expired);
    }

    function testUnresolvedExpiresFullRefundNoAward() public {
        _case(ID);
        uint8[] memory c = _classes();
        c[3] = 5;
        _badReservation(_reservation(ID, c), c);
        vm.warp(escrow.getWorkflow(ID).hardDeadline);
        escrow.refundExpired(ID);
        _eq(escrow.balance(ID, A), CAP);
        _eq(escrow.balance(ID, B), CAP + 1);
        _eq(escrow.balance(ID, C), CAP + 2);
        _eq(escrow.getWorkflow(ID).reserved, 0);
    }

    function testPartiallyFundedWorkflowRefundsOnlyDeposits() public {
        _fundOne(ID, B);
        vm.prank(GUARDIAN);
        escrow.pause(true);
        vm.warp(escrow.getWorkflow(ID).hardDeadline);
        escrow.withdrawFor(ID, B);
        vm.expectRevert(Escrow.NothingToWithdraw.selector);
        escrow.withdrawFor(ID, A);
        _eq(token.balanceOf(B), CAP + 11);
        _eq(escrow.totalLiability(), 0);
    }

    function testActiveAndEmptyFundingExpire() public {
        bytes32 other = sha256("other");
        _create(other, CAP, 101, REPAIRER);
        _activate(ID);
        vm.warp(escrow.getWorkflow(ID).hardDeadline);
        escrow.refundExpired(ID);
        escrow.refundExpired(other);
        _eq(escrow.balance(ID, A), CAP);
        _state(other, Escrow.State.Expired);
    }

    function testPauseNeverBlocksReleasedCredit() public {
        _case(ID);
        _reserve(ID, _classes());
        _release(ID);
        vm.prank(GUARDIAN);
        escrow.pause(true);
        vm.prank(A);
        escrow.withdraw(ID);
        escrow.withdrawFor(ID, REPAIRER);
        _eq(token.balanceOf(REPAIRER), 101);
    }

    function testRepairDeadlineCannotExtendOriginalLock() public {
        _case(ID);
        uint256 hard = escrow.getWorkflow(ID).hardDeadline;
        vm.warp(hard - 1);
        _reserve(ID, _classes());
        _eq(escrow.getWorkflow(ID).repairDeadline, hard);
        Escrow.ReleaseAuthorization memory a = _releaseAuth(ID);
        bytes memory sig = _sign(escrow.hashRelease(a));
        vm.warp(hard);
        vm.expectRevert(Escrow.DeadlinePassed.selector);
        escrow.releaseRepair(a, sig);
        escrow.refundExpired(ID);
        _eq(escrow.balance(ID, A), CAP);
    }

    function testLateRepairLosesBeforeRefundTransaction() public {
        _case(ID);
        _reserve(ID, _classes());
        Escrow.ReleaseAuthorization memory a = _releaseAuth(ID);
        bytes memory sig = _sign(escrow.hashRelease(a));
        vm.warp(escrow.getWorkflow(ID).repairDeadline);
        vm.expectRevert(Escrow.DeadlinePassed.selector);
        escrow.releaseRepair(a, sig);
        escrow.refundExpired(ID);
        _eq(escrow.balance(ID, B), CAP + 1);
    }

    function testReleaseOneSecondBeforeMaturityWorks() public {
        _case(ID);
        _reserve(ID, _classes());
        vm.warp(escrow.getWorkflow(ID).repairDeadline - 1);
        _release(ID);
        vm.warp(escrow.getWorkflow(ID).hardDeadline + 1);
        vm.expectRevert(Escrow.WrongState.selector);
        escrow.refundExpired(ID);
        escrow.withdrawFor(ID, REPAIRER);
        _eq(token.balanceOf(REPAIRER), 101);
    }

    function testOneCaseOneReservationOneReleaseOneWithdrawal() public {
        _case(ID);
        vm.prank(A);
        vm.expectRevert(Escrow.WrongState.selector);
        escrow.openCase(ID, CASE);
        _reserve(ID, _classes());
        _badReservation(_reservation(ID, _classes()), _classes());
        _release(ID);
        _badRelease(_releaseAuth(ID));
        escrow.withdrawFor(ID, REPAIRER);
        vm.expectRevert(Escrow.NothingToWithdraw.selector);
        escrow.withdrawFor(ID, REPAIRER);
    }

    function testParticipantRecipientCanCollectNonliableBondAndRepair() public {
        bytes32 id = sha256("participant-recipient");
        _create(id, CAP, 101, C);
        _case(id);
        _reserve(id, _classes());
        _release(id);
        escrow.withdrawFor(id, C);
        _eq(token.balanceOf(C), CAP + 12 + 101);
    }

    function testRejectLiableRepairerEvenIfRoundedDebitWouldBeZero() public {
        bytes32 id = sha256("liable-recipient");
        _create(id, CAP, 1, B);
        _case(id);
        uint8[] memory c = _classes();
        _badReservation(_reservation(id, c), c);
        _eq(escrow.balance(id, A), CAP);
    }

    function testOneMicroUnitRemainderGoesToLowestLiableAddress() public {
        bytes32 id = sha256("tiny");
        _create(id, CAP, 1, REPAIRER);
        _case(id);
        uint8[] memory c = new uint8[](4);
        c[0] = 2;
        c[1] = 1;
        c[3] = 1;
        _reserve(id, c);
        _eq(escrow.reservedDebit(id, A), 1);
        _eq(escrow.reservedDebit(id, B), 0);
        _eq(escrow.reservedDebit(id, C), 0);
    }

    function testRoundingSkipsNonliableLowAddress() public {
        bytes32 id = sha256("skip");
        _create(id, CAP, 3, REPAIRER);
        _case(id);
        uint8[] memory c = new uint8[](4);
        c[1] = 1;
        c[3] = 2;
        _reserve(id, c);
        _eq(escrow.reservedDebit(id, A), 0);
        _eq(escrow.reservedDebit(id, B), 3);
        _eq(escrow.reservedDebit(id, C), 0);
    }

    function testIndependentWorkflowsAndDonationAreIsolated() public {
        bytes32 other = sha256("other");
        _create(other, CAP, 77, REPAIRER);
        _fundOne(other, A);
        token.mint(address(escrow), 55);
        _case(ID);
        _reserve(ID, _classes());
        _release(ID);
        escrow.withdrawFor(ID, A);
        escrow.withdrawFor(ID, B);
        escrow.withdrawFor(ID, C);
        escrow.withdrawFor(ID, REPAIRER);
        _eq(escrow.balance(other, A), CAP);
        _eq(escrow.totalLiability(), CAP);
        _eq(token.balanceOf(address(escrow)), CAP + 55);
        vm.warp(escrow.getWorkflow(other).hardDeadline);
        escrow.withdrawFor(other, A);
        _eq(token.balanceOf(address(escrow)), 55);
        _eq(escrow.totalLiability(), 0);
    }

    function testOnlyGuardianPausesAndAllNewActivityStops() public {
        vm.expectRevert(Escrow.Unauthorized.selector);
        escrow.pause(true);
        _fund(ID);
        Escrow.ActivationAuthorization memory a = _activation(ID);
        bytes memory sig = _sign(escrow.hashActivation(a));
        vm.prank(GUARDIAN);
        escrow.pause(true);
        vm.expectRevert(Escrow.Paused.selector);
        escrow.activateWorkflow(a, sig);
        vm.prank(A);
        vm.expectRevert(Escrow.Paused.selector);
        escrow.depositBond(ID);
        vm.prank(GUARDIAN);
        escrow.pause(false);
        escrow.activateWorkflow(a, sig);
        vm.prank(GUARDIAN);
        escrow.pause(true);
        vm.prank(A);
        vm.expectRevert(Escrow.Paused.selector);
        escrow.openCase(ID, CASE);
    }

    function testExternalCreatorCannotReportOrWithdrawParticipantsBonds() public {
        _activate(ID);
        vm.prank(OUTSIDER);
        vm.expectRevert(Escrow.Unauthorized.selector);
        escrow.openCase(ID, CASE);
        vm.warp(escrow.getWorkflow(ID).hardDeadline);
        vm.prank(OUTSIDER);
        vm.expectRevert(Escrow.NothingToWithdraw.selector);
        escrow.withdraw(ID);
        _eq(escrow.balance(ID, A), CAP);
    }

    function testFundingCannotDuplicateOrUseOutsiderCap() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(Escrow.Unauthorized.selector);
        escrow.depositBond(ID);
        _fundOne(ID, A);
        vm.prank(A);
        vm.expectRevert(Escrow.Unauthorized.selector);
        escrow.depositBond(ID);
    }

    function testEveryNewActivityLosesAtHardDeadline() public {
        _fund(ID);
        Escrow.ActivationAuthorization memory a = _activation(ID);
        bytes memory sig = _sign(escrow.hashActivation(a));
        vm.warp(escrow.getWorkflow(ID).hardDeadline);
        vm.expectRevert(Escrow.DeadlinePassed.selector);
        escrow.activateWorkflow(a, sig);
        vm.prank(B);
        vm.expectRevert(Escrow.DeadlinePassed.selector);
        escrow.depositBond(ID);
    }
}
