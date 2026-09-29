const { ethers, network } = require("hardhat");

async function main() {
  const [buyer, seller, arbitrator] = await ethers.getSigners();
  const amount = ethers.parseEther("1");
  const Escrow = await ethers.getContractFactory("Escrow", buyer);
  const escrow = await Escrow.deploy(seller.address, arbitrator.address, 60, 120, { value: amount });
  await escrow.waitForDeployment();

  console.log("Local ETH escrow demo");
  console.log(`Contract:   ${escrow.target}`);
  console.log(`Buyer:      ${buyer.address}`);
  console.log(`Seller:     ${seller.address}`);
  console.log(`Arbitrator: ${arbitrator.address}`);
  console.log(`Deposit:    ${ethers.formatEther(amount)} ETH`);
  console.log(`State:      ${await escrow.state()} (0 = Funded, 1 = Disputed, 2 = Resolved)`);
  console.log(`Contract balance: ${ethers.formatEther(await ethers.provider.getBalance(escrow.target))} ETH`);

  console.log("\n1. Buyer opens a dispute.");
  await (await escrow.connect(buyer).raiseDispute()).wait();
  console.log(`State: ${await escrow.state()} (Disputed)`);

  console.log("\n2. Arbitrator awards 0.7 ETH to seller and 0.3 ETH back to buyer.");
  await (await escrow.connect(arbitrator).resolveDispute(ethers.parseEther("0.7"), ethers.parseEther("0.3"))).wait();
  console.log(`Seller credit: ${ethers.formatEther(await escrow.credits(seller.address))} ETH`);
  console.log(`Buyer credit:  ${ethers.formatEther(await escrow.credits(buyer.address))} ETH`);
  console.log(`Contract balance remains in escrow until withdrawals: ${ethers.formatEther(await ethers.provider.getBalance(escrow.target))} ETH`);

  console.log("\n3. Each party withdraws their own credit.");
  await (await escrow.connect(seller).withdraw()).wait();
  await (await escrow.connect(buyer).withdraw()).wait();
  console.log(`Seller credit after withdrawal: ${ethers.formatEther(await escrow.credits(seller.address))} ETH`);
  console.log(`Buyer credit after withdrawal:  ${ethers.formatEther(await escrow.credits(buyer.address))} ETH`);
  console.log(`Contract balance after withdrawals: ${ethers.formatEther(await ethers.provider.getBalance(escrow.target))} ETH`);

  console.log("\n4. A second escrow shows the arbitration-timeout protection.");
  const timedOutEscrow = await Escrow.deploy(seller.address, arbitrator.address, 60, 120, { value: amount });
  await timedOutEscrow.waitForDeployment();
  await (await timedOutEscrow.connect(buyer).raiseDispute()).wait();
  await network.provider.send("evm_increaseTime", [181]);
  await network.provider.send("evm_mine");
  await (await timedOutEscrow.connect(seller).refundAfterArbitrationTimeout()).wait();
  console.log(`Arbitrator misses deadline; buyer refund credit: ${ethers.formatEther(await timedOutEscrow.credits(buyer.address))} ETH`);
  console.log(`Timed-out escrow state: ${await timedOutEscrow.state()} (Resolved)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
