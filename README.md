# Escrow-solidity

## ETH escrow with dispute resolution

A small, self-contained Solidity example: the buyer funds an escrow at deployment, a seller receives undisputed funds after a challenge window, and a designated arbitrator can split funds after a buyer opens a dispute. If the arbitrator misses the second deadline, anyone can trigger a full refund to the buyer.

## Security model

- The buyer, seller, and arbitrator are fixed at deployment and must be three different nonzero addresses.
- Only the buyer can dispute, and only before `disputeDeadline`.
- After that deadline, anyone can finalize an undisputed escrow, but the funds are credited only to the seller.
- Only the arbitrator can resolve a dispute, and the allocation must total exactly the original deposit.
- At or after `arbitrationDeadline`, anyone can trigger a refund to the buyer. The EVM cannot run code automatically at a deadline, so a caller must submit this transaction.
- Deadlines use `block.timestamp`, which is suitable for coarse windows rather than precise timing; choose windows that account for chain conditions.
- Funds are credited before withdrawal. Each beneficiary withdraws separately, so a failing recipient cannot block another beneficiary's payment. Withdrawal uses checks-effects-interactions and a reentrancy guard.
- The contract accepts native ETH only and does not support cancellation, upgrades, changing the arbitrator, or ERC-20 tokens.
- It has no direct-deposit method after construction. ETH forcibly sent by mechanisms such as `selfdestruct` is not included in escrow accounting and cannot be withdrawn.

These controls reduce common failure modes but do not make a contract impossible to bypass or guarantee it is secure. The arbitrator is trusted to make a fair decision before the timeout, and a bug in the EVM, compiler, deployment process, or contract could still put funds at risk. This example is unaudited and is not production-ready; obtain an independent audit and test on a test network before handling real funds.

## Run tests

Requires Node.js and npm.

```sh
npm install
npm test
npm run demo
```

The tests compile with the pinned `solc` JavaScript compiler and run on Hardhat's ephemeral local EVM.
The demo also uses an ephemeral local EVM; it does not send transactions to a public network or use real ETH.

## Run the interactive website

```sh
npm install
npm run web
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The site deploys a new escrow to an in-process, ephemeral Hardhat chain and lets you switch between three pre-funded demo roles. Use the test-clock buttons to move through deadlines without waiting. Stop the server with Ctrl+C; the local chain and its state are discarded. The web server only binds to loopback and is for local demonstrations, not production use.
