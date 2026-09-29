const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("Escrow", function () {
  let buyer;
  let seller;
  let arbitrator;
  let stranger;
  let escrow;
  const amount = ethers.parseEther("1");

  beforeEach(async function () {
    [buyer, seller, arbitrator, stranger] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("Escrow", buyer);
    escrow = await factory.deploy(seller.address, arbitrator.address, 100, 200, { value: amount });
    await escrow.waitForDeployment();
  });

  async function advanceTime(seconds) {
    await network.provider.send("evm_increaseTime", [seconds]);
    await network.provider.send("evm_mine");
  }

  it("rejects invalid participants, zero windows, and zero-value funding", async function () {
    const factory = await ethers.getContractFactory("Escrow", buyer);
    await expect(
      factory.deploy(ethers.ZeroAddress, arbitrator.address, 100, 200, { value: amount }),
    ).to.be.revertedWithCustomError(factory, "InvalidAddress");
    await expect(
      factory.deploy(seller.address, seller.address, 100, 200, { value: amount }),
    ).to.be.revertedWithCustomError(factory, "InvalidAddress");
    await expect(factory.deploy(seller.address, arbitrator.address, 0, 200, { value: amount })).to.be.revertedWithCustomError(
      factory,
      "InvalidDuration",
    );
    await expect(factory.deploy(seller.address, arbitrator.address, 100, 200)).to.be.revertedWithCustomError(
      factory,
      "InvalidFunding",
    );
  });

  it("allows only the buyer to dispute before the deadline", async function () {
    await expect(escrow.connect(stranger).raiseDispute()).to.be.revertedWithCustomError(escrow, "Unauthorized");
    await expect(escrow.connect(buyer).raiseDispute()).to.emit(escrow, "DisputeRaised");
    expect(await escrow.state()).to.equal(1n);
    await expect(escrow.finalizeUndisputed()).to.be.revertedWithCustomError(escrow, "InvalidState");

    const second = await (await ethers.getContractFactory("Escrow", buyer)).deploy(
      seller.address,
      arbitrator.address,
      100,
      200,
      { value: amount },
    );
    await second.waitForDeployment();
    await advanceTime(101);
    await expect(second.connect(buyer).raiseDispute()).to.be.revertedWithCustomError(second, "DeadlinePassed");
    await expect(second.connect(stranger).finalizeUndisputed()).to.emit(second, "UndisputedFinalized");
    expect(await second.credits(seller.address)).to.equal(amount);
  });

  it("allows only the arbitrator to resolve with an exact allocation", async function () {
    await escrow.connect(buyer).raiseDispute();
    await expect(escrow.connect(stranger).resolveDispute(amount, 0)).to.be.revertedWithCustomError(
      escrow,
      "Unauthorized",
    );
    await expect(
      escrow.connect(arbitrator).resolveDispute(ethers.parseEther("0.6"), ethers.parseEther("0.3")),
    ).to.be.revertedWithCustomError(escrow, "InvalidAllocation");
    await expect(
      escrow.connect(arbitrator).resolveDispute(ethers.parseEther("0.6"), ethers.parseEther("0.4")),
    )
      .to.emit(escrow, "Resolved")
      .withArgs(ethers.parseEther("0.6"), ethers.parseEther("0.4"));
    expect(await escrow.credits(seller.address)).to.equal(ethers.parseEther("0.6"));
    expect(await escrow.credits(buyer.address)).to.equal(ethers.parseEther("0.4"));
    await expect(escrow.connect(arbitrator).resolveDispute(amount, 0)).to.be.revertedWithCustomError(
      escrow,
      "InvalidState",
    );
  });

  it("finalizes an undisputed escrow only after the challenge window", async function () {
    await expect(escrow.connect(stranger).finalizeUndisputed()).to.be.revertedWithCustomError(
      escrow,
      "DeadlineNotReached",
    );
    await advanceTime(101);
    await expect(escrow.connect(stranger).finalizeUndisputed()).to.emit(escrow, "UndisputedFinalized");
    expect(await escrow.state()).to.equal(2n);
    expect(await escrow.credits(seller.address)).to.equal(amount);
  });

  it("refunds a disputed escrow to the buyer after the arbitration timeout", async function () {
    await escrow.connect(buyer).raiseDispute();
    await expect(escrow.connect(stranger).refundAfterArbitrationTimeout()).to.be.revertedWithCustomError(
      escrow,
      "DeadlineNotReached",
    );
    await advanceTime(301);
    await expect(escrow.connect(arbitrator).resolveDispute(amount, 0)).to.be.revertedWithCustomError(
      escrow,
      "DeadlinePassed",
    );
    await expect(escrow.connect(stranger).refundAfterArbitrationTimeout()).to.emit(escrow, "DisputeTimedOut");
    expect(await escrow.state()).to.equal(2n);
    expect(await escrow.credits(buyer.address)).to.equal(amount);
  });

  it("withdraws a beneficiary's credit once and prevents repeated claims", async function () {
    await escrow.connect(buyer).raiseDispute();
    await escrow.connect(arbitrator).resolveDispute(ethers.parseEther("0.25"), ethers.parseEther("0.75"));

    const balanceBefore = await ethers.provider.getBalance(escrow.target);
    await escrow.connect(seller).withdraw();
    const balanceAfter = await ethers.provider.getBalance(escrow.target);
    expect(balanceBefore - balanceAfter).to.equal(ethers.parseEther("0.25"));
    expect(await escrow.credits(seller.address)).to.equal(0n);
    await expect(escrow.connect(seller).withdraw()).to.be.revertedWithCustomError(escrow, "NoCredit");
  });
});
