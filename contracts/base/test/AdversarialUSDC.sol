// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev All modes are test doubles; no claim of testing a live USDC deployment.
contract AdversarialUSDC {
    enum Mode {
        Normal,
        NoReturn,
        FalseReturn,
        Malformed,
        NonBoolean,
        RevertCall,
        ReceiverFee,
        SenderFee,
        NoMovement
    }
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    Mode public mode;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    bytes4 public callbackError;

    function setDecimals(uint8 value) external {
        decimals = value;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setMode(Mode value) external {
        mode = value;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        if (mode == Mode.RevertCall) {
            revert("issuer blocked");
        }
        if (mode != Mode.NoMovement) {
            balanceOf[from] -= amount + (mode == Mode.SenderFee ? 1 : 0);
            balanceOf[to] += amount - (mode == Mode.ReceiverFee ? 1 : 0);
        }
        if (callbackTarget != address(0)) {
            (bool ok, bytes memory result) = callbackTarget.call(callbackData);
            callbackSucceeded = ok;
            if (result.length >= 4) {
                bytes4 selector;
                assembly ("memory-safe") { selector := mload(add(result, 32)) }
                callbackError = selector;
            }
        }
        if (mode == Mode.NoReturn) {
            assembly ("memory-safe") { return(0, 0) }
        }
        if (mode == Mode.Malformed) {
            assembly ("memory-safe") {
                mstore(0, 1)
                return(31, 1)
            }
        }
        if (mode == Mode.NonBoolean) {
            assembly ("memory-safe") {
                mstore(0, 2)
                return(0, 32)
            }
        }
        return mode != Mode.FalseReturn;
    }
}
