const { SUPABASE_URL, SUPABASE_ANON_KEY, ENGINE_URL } = window.EG_CONFIG;
const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (s, n = 4) => (s ? `${s.slice(0, n)}…${s.slice(-n)}` : "—");
const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d }));
const fmtPrice = p => (p >= 1 ? fmt(p, 4) : p ? Number(p).toPrecision(3) : "—");
const time = ts => new Date(ts).toLocaleTimeString("en-GB");
const solscan = sig => `https://solscan.io/tx/${sig}`;

let session = null, pollTimer = null, state = null, kolCache = [];

// ── Auth ───────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(ENGINE_URL + path, {
    ...opts,
    headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}`, ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

$("btn-signup").onclick = async () => {
  const { error } = await supa.auth.signUp({ email: $("auth-email").value, password: $("auth-pass").value });
  $("auth-msg").textContent = error ? error.message : "Account created — check your email to confirm, then sign in.";
};
$("btn-login").onclick = async () => {
  const { data, error } = await supa.auth.signInWithPassword({ email: $("auth-email").value, password: $("auth-pass").value });
  if (error) return $("auth-msg").textContent = error.message;
  start(data.session);
};
$("btn-logout").onclick = async () => { await supa.auth.signOut(); location.reload(); };

supa.auth.getSession().then(({ data }) => { if (data.session) start(data.session); });

function start(s) {
  session = s;
  $("auth-screen").classList.add("hidden");
  $("app").classList.remove("hidden");
  poll();
  pollTimer = setInterval(poll, 5000);
  loadKols();
}

// ── State polling ──────────────────────────────────────────────────────────
async function poll() {
  try {
    const { data } = await supa.auth.getSession();
    if (data.session) session = data.session;
    state = await api("/api/me/state");
    render(state);
  } catch (e) { $("wallet-sync").textContent = `engine error: ${e.message}`; }
}

function render(s) {
  $("plan-chip").textContent = s.plan.toUpperCase();
  $("plan-chip").className = `plan-chip ${s.plan}`;
  const mb = $("mode-badge");
  mb.textContent = s.liveTrading ? "LIVE TRADING" : "SIGNAL MODE";
  mb.className = `badge ${s.liveTrading ? "live" : "signal"}`;
  $("rpc-dots").innerHTML = s.rpc.map(r => `<span class="rpc-dot ${r.healthy ? "up" : ""}" title="${esc(r.url)}"></span>`).join("");

  $("wallet-address").textContent = s.wallet.publicKey;
  $("wallet-sync").textContent = `synced ${time(s.ts)}`;
  $("wallet-balance").textContent = s.wallet.balanceSol === null ? "—" : fmt(s.wallet.balanceSol, 4);
  $("awaiting-funds").classList.toggle("hidden", s.wallet.funded || s.wallet.balanceSol === null);
  $("token-holdings").innerHTML = s.wallet.tokens.slice(0, 6).map(t => `<li><b>${fmt(t.amount, 2)}</b> · ${esc(short(t.mint))}</li>`).join("");

  const pnl = s.stats.realizedPnlSol;
  $("stat-pnl").innerHTML = `<span class="${pnl >= 0 ? "pos" : "neg"}">${pnl >= 0 ? "+" : ""}${fmt(pnl, 4)} SOL</span>`;
  $("stat-winrate").textContent = s.stats.winRate === null ? "—" : `${fmt(s.stats.winRate, 0)}%`;
  $("stat-open").textContent = s.stats.openPositions;
  $("stat-closed").textContent = s.stats.closedTrades;

  renderSignals(s);
  renderCopy(s.copyEvents);
  renderPositions(s.positions);
  if (!settingsDirty) renderSettings(s.settings, s.defaults);
}

function gate(checks, security) {
  const all = { ...(checks || {}), ...(security || {}) };
  const keys = Object.keys(all);
  if (!keys.length) return '<span class="sub">—</span>';
  return `<div class="gate">${keys.map(k => `<span class="pip ${all[k].pass ? "pass" : "fail"}" title="${esc(k)}: ${esc(all[k].detail || "")}"></span>`).join("")}</div>`;
}

function renderSignals(s) {
  $("scan-ts").textContent = s.scan?.ts ? `last scan ${time(s.scan.ts)}` : "—";
  const rows = (s.scan?.candidates?.length ? s.scan.candidates : s.signals) || [];
  $("signal-rows").innerHTML = rows.length ? rows.slice(0, 20).map(c => `<tr>
      <td class="sym">${esc(c.symbol || "?")}<span class="sub">${esc(short(c.mint))}</span></td>
      <td class="num-col">$${fmtPrice(c.price_usd ?? c.priceUsd)}</td>
      <td class="num-col">$${fmt(c.liquidity_usd ?? c.liquidityUsd, 0)}</td>
      <td>${gate(c.checks, c.security)}</td>
      <td><span class="status-chip ${(c.trade_ready ?? c.tradeReady) ? "ready" : ""}">${(c.trade_ready ?? c.tradeReady) ? "TRADE_READY" : "filtered"}</span></td>
    </tr>`).join("") : '<tr class="empty-row"><td colspan="5">Scanner runs every 30s…</td></tr>';
}

function renderCopy(events) {
  $("copy-list").innerHTML = (events || []).length ? events.slice(0, 25).map(e => `<li>
      <time>${time(e.ts)}</time>
      <span class="copy-side ${e.side}">${e.side}</span>
      <span>${esc(short(e.mint))} ← ${esc(short(e.trader_address))}</span>
      <span class="sub">${e.executed ? "executed" : esc(e.block_reason || "watched")}</span>
      ${e.our_signature ? `<a href="${solscan(e.our_signature)}" target="_blank" rel="noopener">${short(e.our_signature)}</a>` : ""}
    </li>`).join("") : '<li class="empty-row">KOL trades appear here in real time.</li>';
}

function renderPositions(positions) {
  const open = positions.filter(p => p.status === "open" || p.status === "alert");
  const closed = positions.filter(p => p.status === "closed");
  $("open-rows").innerHTML = open.length ? open.map(p => `<tr>
      <td class="sym">${esc(p.symbol)}${p.status === "alert" ? ' <span class="sub">signal</span>' : ""}<span class="sub">${esc(short(p.mint))}</span></td>
      <td class="sub">${p.source === "copytrade" ? "copy ← " + esc(short(p.copied_from)) : "sniper"}</td>
      <td class="num-col ${Number(p.last_change_pct) >= 0 ? "pos" : "neg"}">${p.last_change_pct === null ? "—" : (Number(p.last_change_pct) >= 0 ? "+" : "") + fmt(p.last_change_pct, 1) + "%"}</td>
      <td class="sub">peak $${fmtPrice(p.peak_price_usd)}</td>
    </tr>`).join("") : '<tr class="empty-row"><td colspan="4">No open positions.</td></tr>';
  $("closed-rows").innerHTML = closed.length ? closed.slice(0, 12).map(p => `<tr>
      <td class="sym">${esc(p.symbol)}</td>
      <td class="num-col ${Number(p.pnl_pct) >= 0 ? "pos" : "neg"}">${p.pnl_pct === null ? "—" : (Number(p.pnl_pct) >= 0 ? "+" : "") + fmt(p.pnl_pct, 1) + "%"}</td>
      <td class="sub">${esc(p.exit_reason || "—")}</td>
      <td>${p.sell_signature ? `<a class="sub" href="${solscan(p.sell_signature)}" target="_blank" rel="noopener">${short(p.sell_signature)}</a>` : '<span class="sub">—</span>'}</td>
    </tr>`).join("") : '<tr class="empty-row"><td colspan="4">No closed trades yet.</td></tr>';
}

// ── KOL leaderboard ────────────────────────────────────────────────────────
async function loadKols() {
  try {
    kolCache = await api("/api/kolscan/leaderboard");
    renderKols();
  } catch { $("kol-list").innerHTML = '<p class="sub">kolscan.io unreachable right now.</p>'; }
}
function renderKols() {
  const followed = new Set((state?.traders || []).map(t => t.address));
  $("kol-list").innerHTML = kolCache.slice(0, 15).map(t => `<div class="kol-row">
      <span class="sym">#${t.rank} ${esc(t.name)}<span class="sub">${esc(short(t.address))}</span></span>
      <button class="btn small ${followed.has(t.address) ? "danger" : ""}" data-addr="${esc(t.address)}" data-name="${esc(t.name)}">
        ${followed.has(t.address) ? "Unfollow" : "Follow"}
      </button>
    </div>`).join("");
  $("kol-list").querySelectorAll("button").forEach(b => b.onclick = async () => {
    const addr = b.dataset.addr;
    if (b.textContent.trim() === "Unfollow") await api(`/api/me/traders/${addr}`, { method: "DELETE" });
    else await api("/api/me/traders", { method: "POST", body: JSON.stringify({ address: addr, name: b.dataset.name }) });
    await poll(); renderKols();
  });
}
$("btn-follow").onclick = async () => {
  const address = $("trader-input").value.trim();
  if (!address) return;
  try { await api("/api/me/traders", { method: "POST", body: JSON.stringify({ address }) }); $("trader-input").value = ""; poll(); }
  catch (e) { alert(e.message); }
};

// ── Scam checker ───────────────────────────────────────────────────────────
$("btn-scam").onclick = async () => {
  const mint = $("scam-input").value.trim();
  if (!mint) return;
  $("scam-result").textContent = "checking on-chain…";
  try {
    const r = await api(`/api/scamcheck/${mint}`);
    const fails = Object.entries(r.checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k}: ${c.detail}`);
    $("scam-result").innerHTML = r.verdict === "real"
      ? '<span class="pos">✓ passed all security checks — looks real</span>'
      : `<span class="neg">✗ SCAM RISK — ${esc(fails.join(" · "))}</span>`;
  } catch (e) { $("scam-result").textContent = e.message; }
};

// ── Settings (defaults + custom) ───────────────────────────────────────────
let settingsDirty = false;
const FIELDS = [
  ["sniperEnabled", "Sniper on", "bool"], ["copytradeEnabled", "Copytrading on", "bool"],
  ["buySizeSol", "Sniper size (SOL)"], ["copySizeSol", "Copy size (SOL)"],
  ["maxOpenPositions", "Max positions"], ["slippageBps", "Slippage (bps)"],
  ["followKolscanTop", "Auto-follow kolscan top N"],
  ["entry.minLiquiditySol", "Min liquidity (SOL)"], ["entry.minTxns5m", "Min 5m txns"],
  ["entry.minBuySellRatio", "Min buy/sell ratio"],
  ["exit.baseTpPct", "Take-profit %"], ["exit.trailDropPct", "Trail drop %"],
  ["exit.hardSlPct", "Hard SL %"], ["exit.maxHoldMinutes", "Max hold (min)"],
];
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split("."); let c = o; ks.slice(0, -1).forEach(k => c = c[k] = c[k] || {}); c[ks.at(-1)] = v; };

function renderSettings(settings, defaults) {
  $("settings-grid").innerHTML = FIELDS.map(([path, label, type]) => {
    const val = getPath(settings, path), def = getPath(defaults, path);
    const custom = JSON.stringify(val) !== JSON.stringify(def);
    if (type === "bool") return `<label>${label}<select data-path="${path}" class="${custom ? "custom" : ""}">
        <option value="true" ${val ? "selected" : ""}>on</option><option value="false" ${!val ? "selected" : ""}>off</option></select></label>`;
    return `<label>${label} ${custom ? "· custom" : "· default"}<input data-path="${path}" type="number" step="any" value="${val}" class="${custom ? "custom" : ""}" /></label>`;
  }).join("");
  $("settings-grid").querySelectorAll("input,select").forEach(el => el.onchange = () => settingsDirty = true);
}
$("btn-save-settings").onclick = async () => {
  const overrides = {};
  $("settings-grid").querySelectorAll("[data-path]").forEach(el => {
    const v = el.tagName === "SELECT" ? el.value === "true" : Number(el.value);
    if (JSON.stringify(v) !== JSON.stringify(getPath(state.defaults, el.dataset.path))) setPath(overrides, el.dataset.path, v);
  });
  await api("/api/me/settings", { method: "PUT", body: JSON.stringify(overrides) });
  settingsDirty = false; $("settings-msg").textContent = "saved ✓"; poll();
};
$("btn-reset-settings").onclick = async () => {
  await api("/api/me/settings", { method: "PUT", body: JSON.stringify({}) });
  settingsDirty = false; $("settings-msg").textContent = "reset to best defaults ✓"; poll();
};
