// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {EscrowFixture, Escrow} from "./EscrowFixture.sol";
import {AdversarialUSDC as Token} from "./AdversarialUSDC.sol";

contract TokenTest is EscrowFixture {
    function testNoReturnTransfersSupportedBothDirections() public {
        token.setMode(Token.Mode.NoReturn);
        _fundOne(ID, A);
        vm.warp(escrow.getWorkflow(ID).hardDeadline);
        escrow.withdrawFor(ID, A);
        _eq(token.balanceOf(A), CAP + 10);
        _eq(escrow.totalLiability(), 0);
    }

    function testAllAbnormalDepositsRollBackAccountingAndToken() public {
        token.mint(A, CAP + 10);
        vm.prank(A);
        token.approve(address(escrow), CAP);
        for (uint8 mode = 2; mode <= 8; ++mode) {
            token.setMode(Token.Mode(mode));
            vm.prank(A);
            vm.expectRevert();
            escrow.depositBond(ID);
            _eq(escrow.originalDeposit(ID, A), 0);
            _eq(escrow.balance(ID, A), 0);
            _eq(escrow.totalLiability(), 0);
            _eq(escrow.getWorkflow(ID).fundedCount, 0);
            _eq(token.balanceOf(A), CAP + 10);
            _eq(token.balanceOf(address(escrow)), 0);
        }
        token.setMode(Token.Mode.Normal);
        vm.prank(A);
        escrow.depositBond(ID);
        _eq(escrow.totalLiability(), CAP);
    }

    function testAllAbnormalWithdrawalsKeepClaimRetryable() public {
        _fundOne(ID, A);
        vm.warp(escrow.getWorkflow(ID).hardDeadline);
        token.mint(address(escrow), 5); // Allow sender fee mode to actually move before delta rejection.
        for (uint8 mode = 2; mode <= 8; ++mode) {
            token.setMode(Token.Mode(mode));
            vm.expectRevert();
            escrow.withdrawFor(ID, A);
            _eq(escrow.balance(ID, A), CAP);
            _eq(escrow.totalLiability(), CAP);
            _eq(token.balanceOf(A), 10);
            _eq(token.balanceOf(address(escrow)), CAP + 5);
        }
        token.setMode(Token.Mode.Normal);
        escrow.withdrawFor(ID, A);
        _eq(escrow.totalLiability(), 0);
    }

    function testReentrancyDuringFundingIsRejected() public {
        token.setCallback(address(escrow), abi.encodeCall(escrow.depositBond, (ID)));
        _fundOne(ID, A);
        require(!token.callbackSucceeded() && token.callbackError() == Escrow.Reentrancy.selector, "reentry must fail");
        _eq(escrow.originalDeposit(ID, A), CAP);
        _eq(escrow.getWorkflow(ID).fundedCount, 1);
    }

    function testReentrancyAcrossWorkflowsDuringWithdrawalIsRejected() public {
        bytes32 other = sha256("other");
        _create(other, CAP, 99, REPAIRER);
        _fundOne(ID, A);
        _fundOne(other, B);
        vm.warp(escrow.getWorkflow(ID).hardDeadline);
        token.setCallback(address(escrow), abi.encodeCall(escrow.withdrawFor, (other, B)));
        escrow.withdrawFor(ID, A);
        require(
            !token.callbackSucceeded() && token.callbackError() == Escrow.Reentrancy.selector, "cross-workflow reentry"
        );
        _eq(escrow.balance(other, B), CAP + 1);
        _eq(escrow.totalLiability(), CAP + 1);
    }

    function testReentrancyIntoRefundAndPauseRejected() public {
        _fundOne(ID, A);
        vm.warp(escrow.getWorkflow(ID).hardDeadline);
        token.setCallback(address(escrow), abi.encodeCall(escrow.refundExpired, (ID)));
        escrow.withdrawFor(ID, A);
        require(token.callbackError() == Escrow.Reentrancy.selector, "refund reentry");
    }

    function testTokenRevertAfterReservedExpiryRollsBackDebitsThenRecovers() public {
        _case(ID);
        _reserve(ID, _classes());
        vm.warp(escrow.getWorkflow(ID).repairDeadline);
        token.setMode(Token.Mode.RevertCall);
        vm.expectRevert(Escrow.TransferFailed.selector);
        escrow.withdrawFor(ID, A);
        _state(ID, Escrow.State.Reserved);
        _eq(escrow.reservedDebit(ID, A), 87);
        token.setMode(Token.Mode.Normal);
        escrow.withdrawFor(ID, A);
        _state(ID, Escrow.State.Expired);
        _eq(token.balanceOf(A), CAP + 10);
    }

    function testRejectNonTokenZeroAttestorGuardianAndWrongDecimals() public {
        address att = vm.addr(KEY);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        new Escrow(OUTSIDER, att, GUARDIAN);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        new Escrow(address(token), address(0), GUARDIAN);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        new Escrow(address(token), address(token), GUARDIAN);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        new Escrow(address(token), att, address(0));
        token.setDecimals(18);
        vm.expectRevert(Escrow.InvalidTerms.selector);
        new Escrow(address(token), att, GUARDIAN);
    }
}
