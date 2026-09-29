// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Escrow {
    enum State {
        Funded,
        Disputed,
        Resolved
    }

    address public immutable buyer;
    address public immutable seller;
    address public immutable arbitrator;
    uint256 public immutable escrowAmount;
    uint256 public immutable disputeDeadline;
    uint256 public immutable arbitrationDeadline;

    State public state;
    mapping(address => uint256) public credits;
    bool private withdrawalInProgress;

    error InvalidAddress();
    error InvalidDuration();
    error InvalidFunding();
    error Unauthorized();
    error InvalidState();
    error DeadlineNotReached();
    error DeadlinePassed();
    error InvalidAllocation();
    error WithdrawalFailed();
    error ReentrantWithdrawal();
    error NoCredit();

    event DisputeRaised(address indexed buyer);
    event Resolved(uint256 sellerAmount, uint256 buyerAmount);
    event UndisputedFinalized(uint256 amount);
    event DisputeTimedOut(uint256 refundedAmount);
    event Withdrawn(address indexed account, uint256 amount);

    modifier nonReentrantWithdrawal() {
        if (withdrawalInProgress) revert ReentrantWithdrawal();
        withdrawalInProgress = true;
        _;
        withdrawalInProgress = false;
    }

    constructor(
        address seller_,
        address arbitrator_,
        uint256 disputeWindow,
        uint256 arbitrationWindow
    ) payable {
        if (msg.value == 0) revert InvalidFunding();
        if (
            seller_ == address(0) ||
            arbitrator_ == address(0) ||
            seller_ == msg.sender ||
            arbitrator_ == msg.sender ||
            arbitrator_ == seller_
        ) revert InvalidAddress();
        if (disputeWindow == 0 || arbitrationWindow == 0) revert InvalidDuration();

        buyer = msg.sender;
        seller = seller_;
        arbitrator = arbitrator_;
        escrowAmount = msg.value;
        disputeDeadline = block.timestamp + disputeWindow;
        arbitrationDeadline = disputeDeadline + arbitrationWindow;
        state = State.Funded;
    }

    function raiseDispute() external {
        if (msg.sender != buyer) revert Unauthorized();
        if (state != State.Funded) revert InvalidState();
        if (block.timestamp >= disputeDeadline) revert DeadlinePassed();

        state = State.Disputed;
        emit DisputeRaised(msg.sender);
    }

    function finalizeUndisputed() external {
        if (state != State.Funded) revert InvalidState();
        if (block.timestamp < disputeDeadline) revert DeadlineNotReached();

        state = State.Resolved;
        credits[seller] += escrowAmount;
        emit UndisputedFinalized(escrowAmount);
    }

    function resolveDispute(uint256 sellerAmount, uint256 buyerAmount) external {
        if (msg.sender != arbitrator) revert Unauthorized();
        if (state != State.Disputed) revert InvalidState();
        if (block.timestamp >= arbitrationDeadline) revert DeadlinePassed();
        if (sellerAmount > escrowAmount || buyerAmount != escrowAmount - sellerAmount) {
            revert InvalidAllocation();
        }

        state = State.Resolved;
        credits[seller] += sellerAmount;
        credits[buyer] += buyerAmount;
        emit Resolved(sellerAmount, buyerAmount);
    }

    function refundAfterArbitrationTimeout() external {
        if (state != State.Disputed) revert InvalidState();
        if (block.timestamp < arbitrationDeadline) revert DeadlineNotReached();

        state = State.Resolved;
        credits[buyer] += escrowAmount;
        emit DisputeTimedOut(escrowAmount);
    }

    function withdraw() external nonReentrantWithdrawal {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NoCredit();

        credits[msg.sender] = 0;
        (bool success,) = payable(msg.sender).call{value: amount}("");
        if (!success) revert WithdrawalFailed();

        emit Withdrawn(msg.sender, amount);
    }
}
