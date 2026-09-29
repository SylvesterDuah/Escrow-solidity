import { BrowserProvider, Contract, ContractFactory, getAddress, isAddress, JsonRpcProvider, parseEther } from "ethers";
import artifact from "../artifacts/contracts/Escrow.sol/Escrow.json";
import "./style.css";

const SEPOLIA = 11155111n;
const ESCROW_KEY = "cleardeal-sepolia-escrow";
const $ = (selector) => document.querySelector(selector);
const walletButton = $("#connect-button");
const actions = $("#actions");
const toast = $("#toast");
const activity = [];
let provider = new JsonRpcProvider("https://rpc.sepolia.org", Number(SEPOLIA));
let signer;
let account;
let escrow;
let currentDeal;
let locked = false;
let toastTimer;

function short(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function friendlyError(error) {
  const data = error.data || error.error?.data || error.info?.error?.data;
  if (data) {
    try {
      const parsed = new Contract(escrow?.target || "0x0000000000000000000000000000000000000001", artifact.abi).interface.parseError(data);
      if (parsed) {
        const messages = {
          Unauthorized: "This wallet is not authorized for that action.",
          InvalidState: "This action is not available in the current escrow state.",
          DeadlineNotReached: "That deadline has not passed yet.",
          DeadlinePassed: "That action's deadline has passed.",
          InvalidAllocation: "The seller and buyer awards must add up to the full deposit.",
          NoCredit: "This wallet has no escrow credit to withdraw.",
        };
        return messages[parsed.name] || parsed.name;
      }
    } catch {
      // Fall through to the wallet's human-readable error.
    }
  }
  if (error.code === 4001) return "Transaction was rejected in the wallet.";
  return error.shortMessage || error.reason || error.message || "Transaction failed.";
}

function notify(message, error = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4200);
}

function addActivity(message, hash) {
  activity.unshift({ message, hash, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) });
  activity.splice(12);
  $("#activity").innerHTML = activity.map((item) => `<div class="activity-row"><div>${escapeHtml(item.message)}<small>${item.hash ? `${escapeHtml(item.hash.slice(0, 14))}… · Sepolia` : "Local browser action"}</small></div><time>${item.time}</time></div>`).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function setBusy(value) {
  locked = value;
  document.querySelectorAll("button").forEach((button) => {
    if (button.id !== "connect-button" || value) button.disabled = value;
  });
  if (!value) renderActions();
}

async function ensureSepolia() {
  if (!window.ethereum) throw new Error("Install MetaMask to interact with the Sepolia escrow.");
  provider = new BrowserProvider(window.ethereum);
  const network = await provider.getNetwork();
  if (network.chainId !== SEPOLIA) {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
    } catch (error) {
      if (error.code !== 4902) throw error;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0xaa36a7",
          chainName: "Sepolia",
          nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://rpc.sepolia.org"],
          blockExplorerUrls: ["https://sepolia.etherscan.io"],
        }],
      });
    }
    provider = new BrowserProvider(window.ethereum);
  }
  const checkedNetwork = await provider.getNetwork();
  if (checkedNetwork.chainId !== SEPOLIA) throw new Error("Switch MetaMask to Sepolia to continue.");
  return provider;
}

async function connect() {
  provider = await ensureSepolia();
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!accounts.length) throw new Error("No wallet account was selected.");
  signer = await provider.getSigner();
  account = getAddress(await signer.getAddress());
  $("#wallet-state").textContent = "SEPOLIA CONNECTED";
  $("#wallet-state").className = "badge resolved";
  const balance = await provider.getBalance(account);
  $("#wallet-details").classList.remove("hidden");
  $("#wallet-details").innerHTML = `<div><span>Connected wallet</span><strong class="wallet-address" title="${account}">${short(account)}</strong></div><div><span>Test ETH balance</span><strong>${Number((Number(balance) / 1e18).toFixed(5))} ETH</strong></div>`;
  walletButton.textContent = "Refresh wallet";
  if (escrow) escrow = escrow.connect(signer);
  await refresh();
  if (!escrow) $("#actions").innerHTML = `<div class="empty"><span>◇</span><div><strong>Wallet connected</strong><p>Enter the seller and arbitrator addresses to deploy, or load an existing escrow contract.</p></div></div>`;
}

async function loadEscrow(address) {
  if (!isAddress(address)) throw new Error("Enter a valid escrow contract address.");
  const normalized = getAddress(address);
  const bytecode = await provider.getCode(normalized);
  if (bytecode === "0x") throw new Error("No contract was found at that address on Sepolia.");
  const candidate = new Contract(normalized, artifact.abi, signer || provider);
  await candidate.buyer();
  escrow = signer ? candidate.connect(signer) : candidate;
  localStorage.setItem(ESCROW_KEY, normalized);
  const url = new URL(window.location.href);
  url.searchParams.set("escrow", normalized);
  history.replaceState(null, "", url);
  await refresh();
  notify("Escrow contract loaded from Sepolia.");
}

async function refresh() {
  if (!escrow || !provider) return;
  const [
    state,
    buyer,
    seller,
    arbitrator,
    amount,
    disputeDeadline,
    arbitrationDeadline,
    contractBalance,
    latestBlock,
  ] = await Promise.all([
    escrow.state(), escrow.buyer(), escrow.seller(), escrow.arbitrator(),
    escrow.escrowAmount(), escrow.disputeDeadline(), escrow.arbitrationDeadline(),
    provider.getBalance(escrow.target), provider.getBlock("latest"),
  ]);
  const buyerCredit = await escrow.credits(buyer);
  const sellerCredit = await escrow.credits(seller);
  currentDeal = {
    state: Number(state),
    buyer: getAddress(buyer),
    seller: getAddress(seller),
    arbitrator: getAddress(arbitrator),
    amount,
    disputeDeadline,
    arbitrationDeadline,
    contractBalance,
    buyerCredit,
    sellerCredit,
    now: BigInt(latestBlock.timestamp),
  };
  renderDeal();
  renderActions();
}

function countdown(deadline) {
  const remaining = Number(deadline > currentDeal.now ? deadline - currentDeal.now : 0n);
  if (!remaining) return "Deadline passed";
  if (remaining < 60) return `${remaining}s left`;
  if (remaining < 3600) return `${Math.ceil(remaining / 60)}m left`;
  if (remaining < 86400) return `${Math.ceil(remaining / 3600)}h left`;
  return `${Math.ceil(remaining / 86400)}d left`;
}

function renderDeal() {
  if (!currentDeal) return;
  const d = currentDeal;
  const stateName = ["FUNDED", "DISPUTED", "RESOLVED"][d.state];
  $("#amount").textContent = Number(d.amount) / 1e18;
  $("#contract-address").textContent = `${short(escrow.target)} · Sepolia`;
  $("#deal-state").textContent = stateName;
  $("#deal-state").className = `badge ${["funded", "disputed", "resolved"][d.state]}`;
  $("#deal-meta").classList.remove("hidden");
  $("#contract-balance").textContent = `${Number(d.contractBalance) / 1e18} ETH`;
  $("#dispute-deadline").textContent = d.state === 0 ? countdown(d.disputeDeadline) : "Closed";
  $("#arbitration-deadline").textContent = d.state === 1 ? countdown(d.arbitrationDeadline) : d.state === 2 ? "Complete" : "After dispute";
  $("#parties").classList.remove("hidden");
  $("#parties").innerHTML = [
    ["Buyer", d.buyer], ["Seller", d.seller], ["Arbitrator", d.arbitrator],
  ].map(([label, value]) => `<div class="party"><span>${label}</span><strong title="${value}">${short(value)}</strong></div>`).join("");
}

function button(label, action, className, disabled = false) {
  return `<button class="button ${className}" data-action="${action}" ${disabled || locked ? "disabled" : ""}>${label}</button>`;
}

function renderActions() {
  if (!currentDeal) return;
  const d = currentDeal;
  if (!account) {
    actions.innerHTML = `<div class="empty"><span>◇</span><div><strong>Connect the right wallet</strong><p>This contract is live on Sepolia. Connect the buyer, seller, or arbitrator wallet to take the permitted action.</p></div></div>`;
    return;
  }
  const isBuyer = account.toLowerCase() === d.buyer.toLowerCase();
  const isSeller = account.toLowerCase() === d.seller.toLowerCase();
  const isArbitrator = account.toLowerCase() === d.arbitrator.toLowerCase();
  if (d.state === 0) {
    const challenge = isBuyer
      ? `<div class="action-row"><div class="action-copy"><strong>Need to challenge the deal?</strong><p>Only the buyer can open a dispute before the challenge deadline.</p></div>${button("Raise dispute", "dispute", "danger", d.now >= d.disputeDeadline)}</div>`
      : `<div class="action-row"><div class="action-copy"><strong>Challenge period is open</strong><p>Only the buyer can raise a dispute before the deadline.</p></div><span class="step-tag">BUYER ONLY</span></div>`;
    const finalize = `<div class="action-row"><div class="action-copy"><strong>Finalize without a dispute</strong><p>Anyone can finalize after the challenge window closes. Funds are credited to the seller.</p></div>${button("Finalize", "finalize", "secondary", d.now < d.disputeDeadline)}</div>`;
    actions.innerHTML = `<div class="action-stack">${challenge}<div class="action-divider"></div>${finalize}</div>`;
  } else if (d.state === 1) {
    const resolve = isArbitrator
      ? `<div class="action-copy"><strong>Settle the dispute</strong><p>The buyer gets the remaining amount from the ${Number(d.amount) / 1e18} ETH deposit.</p></div><form class="award" id="award-form"><label>Seller award (ETH)<input name="sellerAmount" type="number" min="0" max="${Number(d.amount) / 1e18}" step="any" value="${Number(d.amount) / 1e18}" required /></label><button class="button primary" type="submit" ${d.now >= d.arbitrationDeadline || locked ? "disabled" : ""}>Settle</button></form>`
      : `<div class="action-row"><div class="action-copy"><strong>Waiting for arbitrator</strong><p>Only the designated arbitrator can decide how to split the escrow.</p></div><span class="step-tag">ARBITRATOR ONLY</span></div>`;
    actions.innerHTML = `<div class="action-stack">${resolve}<div class="action-divider"></div><div class="action-row"><div class="action-copy"><strong>Arbitration timeout</strong><p>After the deadline, anyone can trigger a full refund to the buyer.</p></div>${button("Refund buyer", "timeout", "danger", d.now < d.arbitrationDeadline)}</div></div>`;
  } else {
    const credit = isBuyer ? d.buyerCredit : isSeller ? d.sellerCredit : 0n;
    const available = Number(credit) / 1e18;
    actions.innerHTML = `<div class="action-row"><div class="action-copy"><strong>${available > 0 ? `${available} ETH credit available` : "Escrow resolved"}</strong><p>${isBuyer ? "Buyer" : isSeller ? "Seller" : "This wallet"} credit: ${available} ETH. Connect a credited party to withdraw.</p></div>${button(available > 0 ? "Withdraw credit" : "No credit", "withdraw", "secondary", available === 0)}</div>`;
  }
}

async function transact(action, extra = {}) {
  if (!signer || !escrow) throw new Error("Connect your Sepolia wallet first.");
  setBusy(true);
  try {
    let tx;
    let message;
    if (action === "dispute") {
      tx = await escrow.connect(signer).raiseDispute();
      message = "Buyer opened a dispute";
    } else if (action === "finalize") {
      tx = await escrow.connect(signer).finalizeUndisputed();
      message = "Undisputed escrow finalized for seller";
    } else if (action === "resolve") {
      const sellerAmount = parseEther(String(extra.sellerAmount));
      if (sellerAmount > currentDeal.amount) throw new Error("Seller award cannot exceed the escrow deposit.");
      tx = await escrow.connect(signer).resolveDispute(sellerAmount, currentDeal.amount - sellerAmount);
      message = `Arbitrator split the escrow: ${Number(sellerAmount) / 1e18} ETH to seller`;
    } else if (action === "timeout") {
      tx = await escrow.connect(signer).refundAfterArbitrationTimeout();
      message = "Arbitration timed out; full buyer refund credited";
    } else if (action === "withdraw") {
      tx = await escrow.connect(signer).withdraw();
      message = "Escrow credit withdrawn";
    } else {
      throw new Error("Unknown escrow action.");
    }
    notify("Waiting for Sepolia confirmation…");
    const receipt = await tx.wait();
    addActivity(message, receipt.hash);
    await refresh();
    notify("Transaction confirmed on Sepolia.");
  } catch (error) {
    notify(friendlyError(error), true);
  } finally {
    setBusy(false);
    await refresh();
  }
}

walletButton.addEventListener("click", async () => {
  try {
    await connect();
    notify("Wallet connected to Sepolia.");
  } catch (error) {
    notify(friendlyError(error), true);
  }
});

$("#deploy-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!signer) return notify("Connect the buyer wallet on Sepolia first.", true);
  const form = new FormData(event.currentTarget);
  let seller;
  let arbitrator;
  let value;
  try {
    seller = getAddress(String(form.get("seller")).trim());
    arbitrator = getAddress(String(form.get("arbitrator")).trim());
    value = parseEther(String(form.get("amount")));
    if (value <= 0n) throw new Error("Deposit must be greater than zero.");
    if (new Set([account.toLowerCase(), seller.toLowerCase(), arbitrator.toLowerCase()]).size !== 3) {
      throw new Error("Buyer, seller, and arbitrator must be three different wallets.");
    }
  } catch (error) {
    return notify(error.message || "Enter valid wallet addresses and a valid deposit.", true);
  }
  const buttonEl = event.currentTarget.querySelector('button[type="submit"]');
  buttonEl.disabled = true;
  try {
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
    const deployment = await factory.deploy(
      seller,
      arbitrator,
      Number(form.get("disputeWindow")),
      Number(form.get("arbitrationWindow")),
      { value },
    );
    notify("Confirm deployment in MetaMask, then wait for Sepolia confirmation…");
    await deployment.waitForDeployment();
    escrow = deployment;
    localStorage.setItem(ESCROW_KEY, escrow.target);
    history.replaceState(null, "", `?escrow=${escrow.target}`);
    addActivity(`Deployed and funded escrow with ${Number(value) / 1e18} ETH`, deployment.deploymentTransaction().hash);
    await refresh();
    notify("Escrow deployed and funded on Sepolia.");
  } catch (error) {
    notify(friendlyError(error), true);
  } finally {
    buttonEl.disabled = false;
  }
});

$("#load-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (!provider) await ensureSepolia();
    await loadEscrow($("#load-address").value.trim());
  } catch (error) {
    notify(friendlyError(error), true);
  }
});

actions.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (target && !target.disabled) transact(target.dataset.action);
});
actions.addEventListener("submit", (event) => {
  if (event.target.id !== "award-form") return;
  event.preventDefault();
  transact("resolve", { sellerAmount: event.target.elements.sellerAmount.value });
});

if (window.ethereum) {
  window.ethereum.on("accountsChanged", async (accounts) => {
    if (!accounts.length) {
      account = undefined;
      signer = undefined;
      $("#wallet-state").textContent = "NOT CONNECTED";
      $("#wallet-state").className = "badge";
      $("#wallet-details").classList.add("hidden");
      return renderActions();
    }
    try { await connect(); } catch (error) { notify(friendlyError(error), true); }
  });
  window.ethereum.on("chainChanged", () => window.location.reload());
}

const initialAddress = new URLSearchParams(window.location.search).get("escrow") || localStorage.getItem(ESCROW_KEY);
if (initialAddress) {
  $("#load-address").value = initialAddress;
  loadEscrow(initialAddress).catch((error) => notify(friendlyError(error), true));
}
setInterval(() => {
  if (escrow && provider && !locked) refresh().catch(() => {});
}, 8000);
