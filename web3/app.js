import { BrowserProvider, Contract, ContractFactory, formatEther, getAddress, isAddress, JsonRpcProvider, parseEther } from "ethers";
import artifact from "../artifacts/contracts/Escrow.sol/Escrow.json";
import "./style.css";

const SEPOLIA = 11155111n;
const ESCROW_KEY = "cleardeal-sepolia-escrow";
const HISTORY_KEY = "cleardeal-sepolia-history";
const VIEW_KEY = "cleardeal-sepolia-full-view";
const $ = (selector) => document.querySelector(selector);
const walletButton = $("#connect-button");
const actions = $("#actions");
const toast = $("#toast");
const savedHistory = loadHistory();
const activity = savedHistory.activity;
const contracts = savedHistory.contracts;
const wallets = savedHistory.wallets;
let provider = new JsonRpcProvider("https://rpc.sepolia.org", Number(SEPOLIA));
let signer;
let account;
let escrow;
let currentDeal;
let locked = false;
let toastTimer;
let fullView = localStorage.getItem(VIEW_KEY) === "true";

function loadHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
    return {
      activity: Array.isArray(stored.activity) ? stored.activity.filter((entry) =>
        entry && typeof entry.message === "string" &&
        (entry.txHash === null || typeof entry.txHash === "string") &&
        typeof entry.type === "string" &&
        typeof entry.contract === "string" &&
        typeof entry.time === "string"
      ).slice(0, 100) : [],
      contracts: Array.isArray(stored.contracts) ? stored.contracts.filter((entry) =>
        entry && typeof entry.address === "string" &&
        (entry.deploymentHash === null || typeof entry.deploymentHash === "string")
      ).slice(0, 50) : [],
      wallets: Array.isArray(stored.wallets) ? stored.wallets.filter((address) => typeof address === "string").slice(0, 50) : [],
    };
  } catch {
    return { activity: [], contracts: [], wallets: [] };
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify({ activity, contracts, wallets }));
  } catch (error) {
    console.error("Could not save the Sepolia transaction log in this browser.", error);
    notify("Transaction confirmed, but this browser could not save the local transaction history.", true);
  }
}

function rememberWallet(address) {
  if (!address) return;
  const normalized = getAddress(address);
  if (!wallets.some((saved) => saved.toLowerCase() === normalized.toLowerCase())) {
    wallets.unshift(normalized);
    wallets.splice(0, Math.max(0, wallets.length - 50));
  }
}

function rememberContract(address, deploymentHash = null, deployer = null) {
  const normalized = getAddress(address);
  let record = contracts.find((item) => item.address.toLowerCase() === normalized.toLowerCase());
  if (!record) {
    record = { address: normalized, deploymentHash: null, deployer: null };
    contracts.unshift(record);
    contracts.splice(50);
  }
  if (deploymentHash) record.deploymentHash = deploymentHash;
  if (deployer) record.deployer = getAddress(deployer);
}

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

function roleFor(address, deal = currentDeal) {
  if (!address) return "Unknown wallet";
  if (deal?.buyer.toLowerCase() === address.toLowerCase()) return "Buyer";
  if (deal?.seller.toLowerCase() === address.toLowerCase()) return "Seller";
  if (deal?.arbitrator.toLowerCase() === address.toLowerCase()) return "Arbitrator";
  return `Other wallet ${short(address)}`;
}

function addActivity(type, message, txHash, contractAddress, actor) {
  const contract = contractAddress ? getAddress(contractAddress) : "";
  const wallet = actor ? getAddress(actor) : "";
  activity.unshift({
    type,
    message: `${roleFor(wallet)} ${message}`,
    txHash,
    contract,
    wallet,
    time: new Date().toISOString(),
  });
  activity.splice(100);
  rememberContract(contract);
  rememberWallet(wallet);
  saveHistory();
  renderActivity();
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
  rememberWallet(account);
  saveHistory();
  $("#wallet-state").textContent = "SEPOLIA CONNECTED";
  $("#wallet-state").className = "badge resolved";
  const balance = await provider.getBalance(account);
  $("#wallet-details").classList.remove("hidden");
  $("#wallet-details").innerHTML = `<div><span>Connected wallet</span><strong class="wallet-address" title="${account}">${short(account)}</strong></div><div><span>Test ETH balance</span><strong>${Number((Number(balance) / 1e18).toFixed(5))} ETH</strong></div>`;
  walletButton.textContent = "Refresh wallet";
  renderActivity();
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
  rememberContract(normalized);
  saveHistory();
  renderActivity();
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

const actionLabels = {
  deployment: "Deployment TX",
  dispute: "Dispute TX",
  arbitration: "Arbitration TX",
  withdrawal: "Withdrawal TX",
  finalization: "Finalization TX",
  "timeout-refund": "Timeout refund TX",
};

function transactionLink(hash, compact) {
  if (!hash) return '<span class="transaction-missing">Not recorded in this browser</span>';
  const displayHash = compact ? `${hash.slice(0, 14)}…${hash.slice(-8)}` : hash;
  return `<a class="transaction-value" href="https://sepolia.etherscan.io/tx/${encodeURIComponent(hash)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(hash)}">${escapeHtml(displayHash)}</a>`;
}

function addressLink(address) {
  return `<a class="transaction-value" href="https://sepolia.etherscan.io/address/${encodeURIComponent(address)}" target="_blank" rel="noopener noreferrer">${escapeHtml(address)}</a>`;
}

function contractDetails(contract, index) {
  const items = activity.filter((entry) => entry.contract.toLowerCase() === contract.address.toLowerCase());
  const deployment = contract.deploymentHash || items.find((entry) => entry.type === "deployment")?.txHash || null;
  const deployer = contract.deployer || items.find((entry) => entry.type === "deployment")?.wallet || null;
  const rows = [
    `<div class="detail-row"><span>Contract #${index + 1}</span>${addressLink(contract.address)}</div>`,
    `<div class="detail-row"><span>Deployment TX #${index + 1}</span>${transactionLink(deployment, false)}</div>`,
  ];
  if (deployer) rows.push(`<div class="detail-row"><span>Deployer wallet</span>${addressLink(deployer)}</div>`);
  for (const type of ["dispute", "arbitration", "withdrawal", "finalization", "timeout-refund"]) {
    const matches = items.filter((entry) => entry.type === type && entry.txHash);
    if (matches.length) {
      matches.forEach((entry, actionIndex) => {
        const suffix = matches.length > 1 ? ` #${actionIndex + 1}` : "";
        rows.push(`<div class="detail-row"><span>${actionLabels[type]}${suffix}</span>${transactionLink(entry.txHash, false)}</div>`);
      });
    }
  }
  return `<section class="contract-record"><h3>Contract #${index + 1} transactions</h3>${rows.join("")}</section>`;
}

function renderActivity() {
  const activityElement = $("#activity");
  const detailsElement = $("#transaction-details");
  const recent = activity.slice(0, 12);
  activityElement.innerHTML = recent.length
    ? recent.map((item) => {
      const hash = item.txHash ? `${transactionLink(item.txHash, !fullView)} · Sepolia` : "Contract address loaded";
      const contract = item.contract ? ` · ${short(item.contract)}` : "";
      return `<div class="activity-row"><div>${escapeHtml(item.message)}<small>${hash}${escapeHtml(contract)}</small></div><time>${new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>`;
    }).join("")
    : '<p class="muted">Confirmed transactions for this browser session will appear here.</p>';

  detailsElement.innerHTML = wallets.length || contracts.length
    ? `${wallets.length ? `<section class="contract-record"><h3>Wallets</h3>${wallets.map((address, index) => `<div class="detail-row"><span>Wallet${wallets.length > 1 ? ` #${index + 1}` : ""}</span>${addressLink(address)}</div>`).join("")}</section>` : ""}${contracts.length ? contracts.map(contractDetails).join("") : ""}<p class="history-note">Full transaction history is saved in this browser. Contracts opened here show their address; a deployment hash is shown if this browser recorded the deployment.</p>`
    : '<p class="muted">Wallets and transactions will appear here after you connect and interact with an escrow.</p>';

  detailsElement.classList.toggle("hidden", !fullView);
  $("#full-view-toggle").textContent = fullView ? "Show compact view" : "Show full details";
  $("#full-view-toggle").setAttribute("aria-expanded", String(fullView));
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
      message = "raised a dispute";
    } else if (action === "finalize") {
      tx = await escrow.connect(signer).finalizeUndisputed();
      message = `finalized the undisputed escrow; ${formatEther(currentDeal.amount)} ETH was credited to the seller`;
    } else if (action === "resolve") {
      const sellerAmount = parseEther(String(extra.sellerAmount));
      if (sellerAmount > currentDeal.amount) throw new Error("Seller award cannot exceed the escrow deposit.");
      const buyerAmount = currentDeal.amount - sellerAmount;
      tx = await escrow.connect(signer).resolveDispute(sellerAmount, currentDeal.amount - sellerAmount);
      message = `resolved the dispute: ${formatEther(sellerAmount)} ETH awarded to the seller and ${formatEther(buyerAmount)} ETH returned to the buyer`;
    } else if (action === "timeout") {
      tx = await escrow.connect(signer).refundAfterArbitrationTimeout();
      message = `triggered the arbitration-timeout refund; ${formatEther(currentDeal.amount)} ETH was credited to the buyer`;
    } else if (action === "withdraw") {
      const credit = account.toLowerCase() === currentDeal.buyer.toLowerCase()
        ? currentDeal.buyerCredit
        : await escrow.credits(account);
      tx = await escrow.connect(signer).withdraw();
      message = `withdrew ${formatEther(credit)} ETH of escrow credit`;
    } else {
      throw new Error("Unknown escrow action.");
    }
    notify("Waiting for Sepolia confirmation…");
    const receipt = await tx.wait();
    const eventType = {
      dispute: "dispute",
      resolve: "arbitration",
      timeout: "timeout-refund",
      withdraw: "withdrawal",
      finalize: "finalization",
    }[action];
    addActivity(eventType, message, receipt.hash, escrow.target, account);
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
    const deploymentTransaction = deployment.deploymentTransaction();
    const deploymentHash = deploymentTransaction.hash;
    rememberContract(escrow.target, deploymentHash, account);
    await refresh();
    addActivity(
      "deployment",
      `deployed Contract #${contracts.findIndex((item) => item.address.toLowerCase() === escrow.target.toLowerCase()) + 1} and deposited ${formatEther(value)} Sepolia ETH`,
      deploymentHash,
      escrow.target,
      account,
    );
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
$("#full-view-toggle").addEventListener("click", () => {
  fullView = !fullView;
  localStorage.setItem(VIEW_KEY, String(fullView));
  renderActivity();
});
renderActivity();
setInterval(() => {
  if (escrow && provider && !locked) refresh().catch(() => {});
}, 8000);
