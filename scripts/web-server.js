const path = require("node:path");
const express = require("express");
const { ethers, network } = require("hardhat");

const PORT = 4173;
const HOST = "127.0.0.1";
const MAX_WINDOW = 365 * 24 * 60 * 60;
const app = express();
let accounts;
let escrow;
let activity = [];
let depositWei;
let allocation;

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: "8kb" }));

function accountFor(role) {
  const index = { buyer: 0, seller: 1, arbitrator: 2 }[role];
  if (index === undefined) {
    const error = new Error("Choose buyer, seller, or arbitrator.");
    error.status = 400;
    throw error;
  }
  return accounts[index];
}

function seconds(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_WINDOW) {
    const error = new Error(`${label} must be between 1 second and 1 year.`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

function addActivity(message, transaction) {
  activity.unshift({
    message,
    transaction: transaction.hash,
    block: transaction.blockNumber,
    at: new Date().toISOString(),
  });
  activity = activity.slice(0, 20);
}

function errorMessage(error) {
  const revertData = error.data || error.error?.data || error.info?.error?.data;
  if (revertData && escrow) {
    const decoded = escrow.interface.parseError(revertData);
    if (decoded) return `${decoded.name}: ${decoded.name.replace(/([A-Z])/g, " $1").trim()}`;
  }
  return error.shortMessage || error.reason || error.message || "The transaction failed.";
}

async function currentStatus() {
  if (!escrow) {
    return {
      ready: true,
      escrow: null,
      allocation: null,
      accounts: await Promise.all(
        accounts.map(async (account, index) => ({
          role: ["buyer", "seller", "arbitrator"][index],
          address: account.address,
          balance: ethers.formatEther(await ethers.provider.getBalance(account.address)),
        })),
      ),
      activity,
    };
  }

  const [
    state,
    buyer,
    seller,
    arbitrator,
    amount,
    disputeDeadline,
    arbitrationDeadline,
    buyerCredit,
    sellerCredit,
    contractBalance,
    block,
  ] = await Promise.all([
    escrow.state(),
    escrow.buyer(),
    escrow.seller(),
    escrow.arbitrator(),
    escrow.escrowAmount(),
    escrow.disputeDeadline(),
    escrow.arbitrationDeadline(),
    escrow.credits(await escrow.buyer()),
    escrow.credits(await escrow.seller()),
    ethers.provider.getBalance(escrow.target),
    ethers.provider.getBlock("latest"),
  ]);
  const now = BigInt(block.timestamp);

  return {
    ready: true,
    escrow: {
      address: escrow.target,
      state: Number(state),
      stateName: ["Funded", "Disputed", "Resolved"][Number(state)],
      buyer,
      seller,
      arbitrator,
      amount: ethers.formatEther(amount),
      amountWei: amount.toString(),
      disputeDeadline: Number(disputeDeadline),
      arbitrationDeadline: Number(arbitrationDeadline),
      secondsToDisputeDeadline: Number(disputeDeadline > now ? disputeDeadline - now : 0n),
      secondsToArbitrationDeadline: Number(arbitrationDeadline > now ? arbitrationDeadline - now : 0n),
      buyerCredit: ethers.formatEther(buyerCredit),
      sellerCredit: ethers.formatEther(sellerCredit),
      contractBalance: ethers.formatEther(contractBalance),
    },
    allocation,
    accounts: await Promise.all(
      accounts.map(async (account, index) => ({
        role: ["buyer", "seller", "arbitrator"][index],
        address: account.address,
        balance: ethers.formatEther(await ethers.provider.getBalance(account.address)),
      })),
    ),
    activity,
  };
}

app.get("/api/status", async (_req, res, next) => {
  try {
    res.json(await currentStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/escrows", async (req, res, next) => {
  try {
    const { amount, disputeWindow, arbitrationWindow } = req.body;
    let value;
    try {
      value = ethers.parseEther(String(amount));
    } catch {
      return res.status(400).json({ error: "Enter a valid ETH amount." });
    }
    if (value <= 0n) return res.status(400).json({ error: "Deposit must be greater than zero." });

    const challenge = seconds(disputeWindow, "Dispute window");
    const arbitration = seconds(arbitrationWindow, "Arbitration window");
    const factory = await ethers.getContractFactory("Escrow", accounts[0]);
    const nextEscrow = await factory.deploy(accounts[1].address, accounts[2].address, challenge, arbitration, {
      value,
    });
    const receipt = await nextEscrow.deploymentTransaction().wait();
    escrow = nextEscrow;
    depositWei = value;
    allocation = null;
    activity = [];
    addActivity(`Buyer funded escrow with ${ethers.formatEther(value)} ETH`, receipt);
    res.json(await currentStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/actions", async (req, res, next) => {
  try {
    if (!escrow || depositWei === undefined) {
      return res.status(409).json({ error: "Create an escrow before taking an action." });
    }
    const { action, role } = req.body;
    const signer = accountFor(role);
    let transaction;
    let message;

    if (action === "dispute") {
      transaction = await escrow.connect(signer).raiseDispute();
      message = "Buyer opened a dispute";
    } else if (action === "finalize") {
      transaction = await escrow.connect(signer).finalizeUndisputed();
      allocation = { seller: ethers.formatEther(depositWei), buyer: "0" };
      message = "Undisputed escrow finalized for the seller";
    } else if (action === "resolve") {
      let sellerWei;
      try {
        sellerWei = ethers.parseEther(String(req.body.sellerAmount));
      } catch {
        return res.status(400).json({ error: "Enter a valid seller award in ETH." });
      }
      if (sellerWei < 0n || sellerWei > depositWei) {
        return res.status(400).json({ error: "Seller award must be between zero and the escrow amount." });
      }
      transaction = await escrow.connect(signer).resolveDispute(sellerWei, depositWei - sellerWei);
      allocation = {
        seller: ethers.formatEther(sellerWei),
        buyer: ethers.formatEther(depositWei - sellerWei),
      };
      message = `Arbitrator awarded ${ethers.formatEther(sellerWei)} ETH to the seller and ${ethers.formatEther(depositWei - sellerWei)} ETH to the buyer`;
    } else if (action === "timeout-refund") {
      transaction = await escrow.connect(signer).refundAfterArbitrationTimeout();
      allocation = { seller: "0", buyer: ethers.formatEther(depositWei) };
      message = "Arbitration timed out; buyer received a full refund credit";
    } else if (action === "withdraw") {
      transaction = await escrow.connect(signer).withdraw();
      message = `${role[0].toUpperCase()}${role.slice(1)} withdrew their credit`;
    } else if (action === "advance-time") {
      const duration = seconds(req.body.seconds, "Time advance");
      await network.provider.send("evm_increaseTime", [duration]);
      await network.provider.send("evm_mine");
      activity.unshift({
        message: `Local test clock advanced by ${duration} seconds`,
        transaction: null,
        block: null,
        at: new Date().toISOString(),
      });
      activity = activity.slice(0, 20);
      return res.json(await currentStatus());
    } else {
      return res.status(400).json({ error: "Unknown escrow action." });
    }

    addActivity(message, await transaction.wait());
    res.json(await currentStatus());
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, "../web"), { index: "index.html" }));
app.use((error, _req, res, _next) => {
  const status = Number.isInteger(error.status) ? error.status : 400;
  res.status(status).json({ error: errorMessage(error) });
});

async function main() {
  accounts = (await ethers.getSigners()).slice(0, 3);
  const server = app.listen(PORT, HOST, () => {
    console.log(`Escrow demo running at http://${HOST}:${PORT}`);
    console.log("Ephemeral local chain only. No public network or real ETH is used.");
    console.log("Press Ctrl+C to stop the website and discard the local chain.");
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
