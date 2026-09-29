const roleSelect = document.querySelector("#role-select");
const actionArea = document.querySelector("#action-area");
const createForm = document.querySelector("#create-form");
const toast = document.querySelector("#toast");

let snapshot;
let busy = false;
let toastTimer;

const roleNames = { buyer: "Buyer", seller: "Seller", arbitrator: "Arbitrator" };
const roleLetters = { buyer: "B", seller: "S", arbitrator: "A" };

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function notify(message, isError = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatCountdown(seconds) {
  if (!snapshot?.escrow) return "—";
  if (!seconds) return "Window closed";
  if (seconds < 60) return `${seconds}s remaining`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} remaining`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} remaining`;
  const days = Math.ceil(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} remaining`;
}

function currentAccount() {
  const role = roleSelect.value;
  return snapshot?.accounts.find((account) => account.role === role);
}

function renderIdentity() {
  const role = roleSelect.value;
  const account = currentAccount();
  document.querySelector("#role-avatar").textContent = roleLetters[role];
  document.querySelector("#account-address").textContent = account ? shortAddress(account.address) : "Connecting to local demo…";
  document.querySelector("#account-balance").textContent = account ? `${Number(account.balance).toFixed(2)} ETH` : "— ETH";
  document.querySelector("#copy-address").disabled = !account;
}

function renderOverview() {
  const deal = snapshot?.escrow;
  const statusPill = document.querySelector("#status-pill");
  const lockedBadge = document.querySelector("#locked-badge");
  const heading = document.querySelector("#escrow-heading");

  if (!deal) {
    document.querySelector("#deal-amount").textContent = "—";
    document.querySelector("#contract-address").textContent = "Contract not deployed yet";
    document.querySelector("#contract-balance").textContent = "0";
    document.querySelector("#dispute-timer").textContent = "—";
    document.querySelector("#arbitration-timer").textContent = "—";
    document.querySelector("#copy-contract").disabled = true;
    heading.textContent = "Start a new deal";
    statusPill.className = "status-pill status-empty";
    statusPill.innerHTML = '<span class="status-dot"></span> NOT STARTED';
    lockedBadge.className = "locked-badge";
    lockedBadge.innerHTML = '<span class="lock-icon">⌑</span> AWAITING DEPOSIT';
    return;
  }

  document.querySelector("#deal-amount").textContent = Number(deal.amount).toFixed(4).replace(/\.?0+$/, "");
  document.querySelector("#contract-address").textContent = shortAddress(deal.address);
  document.querySelector("#contract-balance").textContent = Number(deal.contractBalance).toFixed(4).replace(/\.?0+$/, "");
  document.querySelector("#dispute-timer").textContent =
    deal.state === 0 ? formatCountdown(deal.secondsToDisputeDeadline) : "Closed";
  document.querySelector("#arbitration-timer").textContent =
    deal.state === 1 ? formatCountdown(deal.secondsToArbitrationDeadline) : deal.state === 2 ? "Complete" : "Starts after dispute";
  document.querySelector("#copy-contract").disabled = false;
  heading.textContent = `${roleNames[roleSelect.value]}’s deal`;

  const statusText = ["FUNDED", "DISPUTED", "RESOLVED"][deal.state];
  statusPill.className = `status-pill status-${deal.stateName.toLowerCase()}`;
  statusPill.innerHTML = `<span class="status-dot"></span> ${statusText}`;
  if (deal.state === 0) {
    lockedBadge.className = "locked-badge is-locked";
    lockedBadge.innerHTML = '<span class="lock-icon">⌑</span> FUNDS PROTECTED';
  } else if (deal.state === 1) {
    lockedBadge.className = "locked-badge is-disputed";
    lockedBadge.innerHTML = '<span class="lock-icon">⌑</span> DISPUTE OPEN';
  } else {
    lockedBadge.className = "locked-badge is-released";
    lockedBadge.innerHTML = '<span class="lock-icon">✓</span> CREDITS ASSIGNED';
  }
}

function renderStepper() {
  const deal = snapshot?.escrow;
  const currentStep = deal ? deal.state === 2 ? 2 : deal.state === 1 ? 1 : 0 : -1;
  document.querySelectorAll(".step").forEach((step) => {
    const stepIndex = Number(step.dataset.step);
    step.classList.toggle("active", stepIndex === currentStep);
    step.classList.toggle("complete", currentStep > stepIndex);
  });
  document.querySelectorAll(".step-connector").forEach((connector, index) => {
    connector.classList.toggle("complete", currentStep > index);
  });
}

function button(action, text, style, disabled = false) {
  return `<button class="button ${style}" type="button" data-action="${action}" ${disabled || busy ? "disabled" : ""}>${text}</button>`;
}

function renderActions() {
  const deal = snapshot?.escrow;
  const role = roleSelect.value;
  if (!deal) {
    actionArea.innerHTML = `<div class="empty-state">
      <span class="empty-icon"><svg viewBox="0 0 32 32" fill="none"><path d="M16 4v24M4 16h24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
      <div><strong>Set up your escrow</strong><p>Choose an amount and create a local demo deal to get started.</p></div>
    </div>`;
    return;
  }

  if (deal.state === 0) {
    const dispute = role === "buyer"
      ? `<div class="action-card"><div class="action-copy"><strong>Something’s not right?</strong><p>Open a dispute before the challenge window closes. The arbitrator can then decide how funds are split.</p></div>${button("dispute", "Raise dispute", "button-danger", deal.secondsToDisputeDeadline === 0)}</div>`
      : `<div class="action-card"><div class="action-copy"><strong>Buyer’s challenge window is open</strong><p>Only the buyer can dispute during this window. After it ends, the seller can claim the deposit.</p></div><span class="role-hint">WAITING ON BUYER</span></div>`;
    const finalize = `<div class="action-card"><div class="action-copy"><strong>Release to seller</strong><p>Anyone can finalize after the dispute window closes.</p></div>${button("finalize", "Finalize deal", "button-secondary", deal.secondsToDisputeDeadline > 0)}</div>`;
    const skip = `<div class="action-card"><div class="action-copy"><strong>Want to try the next step?</strong><p>Fast-forward the local test clock. This control only exists in this demo.</p></div>${button("advance-dispute", "Skip window", "button-outline")}</div>`;
    actionArea.innerHTML = `<div class="action-stack">${dispute}<div class="action-divider"></div>${finalize}<div class="action-divider"></div>${skip}</div>`;
    return;
  }

  if (deal.state === 1) {
    const resolve = role === "arbitrator"
      ? `<div class="action-copy"><strong>Decide how to split the escrow</strong><p>Your award to the seller determines the buyer’s refund. Both amounts must add up to ${deal.amount} ETH.</p></div>
         <form class="award-form" id="award-form"><label for="seller-award">Seller receives (ETH)<input id="seller-award" name="sellerAmount" type="number" min="0" max="${deal.amount}" step="any" value="${deal.amount}" required /></label><button class="button button-primary" type="submit" ${busy || deal.secondsToArbitrationDeadline === 0 ? "disabled" : ""}>Settle dispute</button></form>
         <div class="action-hint">${deal.secondsToArbitrationDeadline === 0 ? "Arbitration deadline passed. The buyer refund can now be triggered." : "The arbitrator must settle before the deadline."}</div>`
      : `<div class="action-copy"><strong>Waiting for the arbitrator</strong><p>The buyer opened a dispute. Only the arbitrator can decide the split before the deadline.</p></div><span class="role-hint">ARBITRATOR ACTION</span>`;
    const timeout = `<div class="action-divider"></div><div class="action-card"><div class="action-copy"><strong>Arbitration deadline fallback</strong><p>If the arbitrator does not decide in time, anyone can trigger a full refund to the buyer.</p></div>${button("timeout-refund", "Refund buyer", "button-danger", deal.secondsToArbitrationDeadline > 0)}</div>`;
    const skip = `<div class="action-divider"></div><div class="action-card"><div class="action-copy"><strong>Testing the timeout?</strong><p>Fast-forward this local chain past the arbitration deadline.</p></div>${button("advance-arbitration", "Skip to timeout", "button-outline")}</div>`;
    actionArea.innerHTML = `<div class="action-stack">${resolve}${timeout}${skip}</div>`;
    return;
  }

  const ownCredit = role === "buyer" ? deal.buyerCredit : role === "seller" ? deal.sellerCredit : "0";
  const hasCredit = Number(ownCredit) > 0;
  const awarded = snapshot.allocation || { seller: deal.sellerCredit, buyer: deal.buyerCredit };
  const creditedRoles = [
    { role: "seller", amount: awarded.seller },
    { role: "buyer", amount: awarded.buyer },
  ].filter((credit) => Number(credit.amount) > 0);
  const splitSummary = creditedRoles.length
    ? `Awarded — ${creditedRoles.map((credit) => `${roleNames[credit.role]}: ${credit.amount} ETH`).join(" · ")}.`
    : "No funds were awarded.";
  actionArea.innerHTML = `<div class="action-card">
    <div class="action-copy"><strong>${hasCredit ? `${ownCredit} ETH is ready to withdraw` : "This deal is settled"}</strong>
    <p>${splitSummary} Select a credited party above to withdraw their balance.</p></div>
    ${button("withdraw", hasCredit ? "Withdraw credit" : "No credit for this role", hasCredit ? "button-secondary" : "button-outline", !hasCredit)}
  </div>`;
}

function renderActivity() {
  const list = document.querySelector("#activity-list");
  const items = snapshot?.activity || [];
  if (!items.length) {
    list.innerHTML = '<div class="activity-empty">Transactions and contract events will appear here.</div>';
    return;
  }
  list.innerHTML = items.map((item) => {
    const time = new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const detail = item.transaction
      ? `Block ${item.block} · ${item.transaction.slice(0, 10)}…`
      : "Local test action";
    return `<div class="activity-item">
      <span class="activity-icon">✓</span>
      <div><div class="activity-message">${escapeHtml(item.message)}</div><div class="activity-meta">${detail}</div></div>
      <span class="activity-time">${time}</span>
    </div>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function render() {
  if (!snapshot) return;
  renderIdentity();
  renderOverview();
  renderStepper();
  renderActions();
  renderActivity();
}

async function refresh() {
  if (busy) return;
  snapshot = await request("/api/status");
  render();
}

async function perform(action, details = {}) {
  if (busy) return;
  busy = true;
  renderActions();
  try {
    snapshot = await request("/api/actions", {
      method: "POST",
      body: JSON.stringify({ action, role: roleSelect.value, ...details }),
    });
    render();
    notify("Transaction confirmed on the local chain.");
  } catch (error) {
    notify(error.message, true);
    renderActions();
  } finally {
    busy = false;
    render();
  }
}

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const submit = document.querySelector("#create-button");
  busy = true;
  submit.classList.add("is-loading");
  submit.disabled = true;
  try {
    snapshot = await request("/api/escrows", {
      method: "POST",
      body: JSON.stringify({
        amount: createForm.elements.amount.value,
        disputeWindow: createForm.elements.disputeWindow.value,
        arbitrationWindow: createForm.elements.arbitrationWindow.value,
      }),
    });
    render();
    notify("Escrow deployed and funded on the local chain.");
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy = false;
    submit.classList.remove("is-loading");
    submit.disabled = false;
    render();
  }
});

actionArea.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  if (action === "advance-dispute") {
    perform("advance-time", { seconds: Math.max(1, snapshot.escrow.secondsToDisputeDeadline + 1) });
  } else if (action === "advance-arbitration") {
    perform("advance-time", { seconds: Math.max(1, snapshot.escrow.secondsToArbitrationDeadline + 1) });
  } else {
    perform(action);
  }
});

actionArea.addEventListener("submit", (event) => {
  if (event.target.id !== "award-form") return;
  event.preventDefault();
  perform("resolve", { sellerAmount: event.target.elements.sellerAmount.value });
});

roleSelect.addEventListener("change", render);

document.querySelector("#copy-address").addEventListener("click", async () => {
  const account = currentAccount();
  if (!account) return;
  await navigator.clipboard.writeText(account.address);
  notify("Account address copied.");
});

document.querySelector("#copy-contract").addEventListener("click", async () => {
  if (!snapshot?.escrow) return;
  await navigator.clipboard.writeText(snapshot.escrow.address);
  notify("Contract address copied.");
});

refresh().catch((error) => notify(error.message, true));
setInterval(() => refresh().catch((error) => notify(error.message, true)), 5000);
