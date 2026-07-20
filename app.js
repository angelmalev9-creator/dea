(() => {
"use strict";

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  ENGINE_URL,
} = window.EG_CONFIG;

const supa = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(
  /[&<>"']/g,
  character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]
);

const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const fmt = (value, digits = 2) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "—";
  }

  return Number(value).toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
};

const compact = value => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "—";
  }

  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(Number(value));
};

const price = value => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "—";
  if (parsed >= 1) return `$${fmt(parsed, 4)}`;
  if (parsed >= 0.01) return `$${parsed.toFixed(5)}`;
  return `$${parsed.toPrecision(4)}`;
};

const time = value => value
  ? new Date(value).toLocaleTimeString("en-GB")
  : "—";

const dateTime = value => value
  ? new Date(value).toLocaleString("en-GB")
  : "—";

const short = (value, size = 4) => value
  ? `${value.slice(0, size)}…${value.slice(-size)}`
  : "—";

const age = minutes => {
  if (minutes === null || minutes === undefined) return "—";
  const value = Math.max(0, Number(minutes));
  if (value < 1) return `${Math.max(1, Math.round(value * 60))}s`;
  if (value < 60) return `${Math.round(value)}m`;
  if (value < 1440) return `${(value / 60).toFixed(value < 600 ? 1 : 0)}h`;
  return `${(value / 1440).toFixed(value < 14400 ? 1 : 0)}d`;
};

const positiveClass = value => Number(value) >= 0 ? "positive" : "negative";
const solscan = signature => `https://solscan.io/tx/${encodeURIComponent(signature)}`;
const clone = value => JSON.parse(JSON.stringify(value));

let session = null;
let state = null;
let marketState = { items: [], refreshTs: null, discoveryTs: null };
let leaderboard = [];
let activeView = "market-view";
let activeFeedTab = "new";
let refreshTimer = null;
let leadersTimer = null;
let settingsDirty = false;
let selectedMint = null;
let selectedDetail = null;
let chart = null;
let candleSeries = null;
let currentCandles = [];
let chartTimeframe = "minute";
let chartAggregate = 1;

const watchlist = new Set(
  JSON.parse(localStorage.getItem("eg-watchlist") || "[]")
);

const FILTER_IDS = [
  "filter-age-max",
  "filter-liq-min",
  "filter-liq-max",
  "filter-mcap-min",
  "filter-mcap-max",
  "filter-volume-min",
  "filter-txns-min",
  "filter-ratio-min",
  "filter-change-min",
  "filter-top10-max",
  "filter-dex",
  "filter-sort",
  "filter-dex-paid",
  "filter-socials",
  "filter-security",
];

async function api(path, options = {}) {
  if (!session?.access_token) {
    throw new Error("Not signed in");
  }

  const response = await fetch(`${ENGINE_URL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.access_token}`,
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error || response.statusText);
    error.payload = payload;
    throw error;
  }

  return payload;
}

// ── Authentication ────────────────────────────────────────────────────────
$("btn-login").onclick = async () => {
  const { data, error } = await supa.auth.signInWithPassword({
    email: $("auth-email").value,
    password: $("auth-pass").value,
  });

  if (error) {
    $("auth-msg").textContent = error.message;
    return;
  }

  start(data.session);
};

$("btn-signup").onclick = async () => {
  const { error } = await supa.auth.signUp({
    email: $("auth-email").value,
    password: $("auth-pass").value,
  });

  $("auth-msg").textContent = error
    ? error.message
    : "Account created. Confirm the email and sign in.";
};

$("btn-logout").onclick = async () => {
  await supa.auth.signOut();
  location.reload();
};

supa.auth.getSession().then(({ data }) => {
  if (data.session) start(data.session);
});

function start(currentSession) {
  session = currentSession;
  $("auth-screen").classList.add("hidden");
  $("app").classList.remove("hidden");

  restoreFilters();
  bindUi();
  refreshAll();
  loadLeaders();

  clearInterval(refreshTimer);
  clearInterval(leadersTimer);

  refreshTimer = setInterval(refreshAll, 5_000);
  leadersTimer = setInterval(loadLeaders, 120_000);
}

let uiBound = false;

function bindUi() {
  if (uiBound) return;
  uiBound = true;

  document.querySelectorAll(".nav-tab").forEach(button => {
    button.onclick = () => switchView(button.dataset.view);
  });

  document.querySelectorAll(".feed-tab").forEach(button => {
    button.onclick = () => {
      activeFeedTab = button.dataset.tab;
      document.querySelectorAll(".feed-tab").forEach(item => {
        item.classList.toggle("active", item === button);
      });
      renderMarket();
    };
  });

  $("market-search").oninput = renderMarket;

  $("btn-toggle-filters").onclick = () => {
    $("filter-panel").classList.toggle("collapsed");
  };

  $("btn-reset-filters").onclick = resetFilters;

  for (const id of FILTER_IDS) {
    const element = $(id);
    element.oninput = () => {
      saveFilters();
      renderMarket();
    };
    element.onchange = () => {
      saveFilters();
      renderMarket();
    };
  }

  $("market-rows").onclick = event => {
    const star = event.target.closest("[data-watch]");
    if (star) {
      event.stopPropagation();
      toggleWatch(star.dataset.watch);
      return;
    }

    const buy = event.target.closest("[data-paper-buy]");
    if (buy) {
      event.stopPropagation();
      openToken(buy.dataset.paperBuy);
      return;
    }

    const row = event.target.closest("tr[data-mint]");
    if (row) openToken(row.dataset.mint);
  };

  $("leaderboard").onclick = async event => {
    const button = event.target.closest("[data-follow]");
    if (!button) return;

    button.disabled = true;

    try {
      if (button.dataset.followed === "true") {
        await api(`/api/me/traders/${button.dataset.follow}`, {
          method: "DELETE",
        });
      } else {
        await api("/api/me/traders", {
          method: "POST",
          body: JSON.stringify({
            address: button.dataset.follow,
            name: button.dataset.name,
          }),
        });
      }

      await refreshState();
      renderLeaders();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  };

  $("btn-save-copy-top").onclick = saveCopyTop;

  $("open-positions").onclick = async event => {
    const button = event.target.closest("[data-paper-sell]");
    if (!button) return;

    button.disabled = true;

    try {
      await api(`/api/me/paper/sell/${button.dataset.paperSell}`, {
        method: "POST",
      });
      await refreshState();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  };

  $("btn-save-settings").onclick = saveSettings;
  $("btn-reset-settings").onclick = resetSettings;

  $("settings-grid").oninput = () => {
    settingsDirty = true;
  };

  document.querySelectorAll("[data-close-drawer]").forEach(element => {
    element.onclick = closeDrawer;
  });

  document.querySelectorAll(".chart-range").forEach(button => {
    button.onclick = () => {
      document.querySelectorAll(".chart-range").forEach(item => {
        item.classList.toggle("active", item === button);
      });

      chartTimeframe = button.dataset.timeframe;
      chartAggregate = Number(button.dataset.aggregate);
      loadChart();
    };
  });

  $("btn-paper-buy").onclick = paperBuySelected;

  window.addEventListener("resize", () => {
    if (chart) {
      chart.applyOptions({
        width: $("token-chart").clientWidth,
      });
    }
  });
}

function switchView(viewId) {
  activeView = viewId;

  document.querySelectorAll(".view").forEach(view => {
    view.classList.toggle("active", view.id === viewId);
  });

  document.querySelectorAll(".nav-tab").forEach(button => {
    button.classList.toggle("active", button.dataset.view === viewId);
  });
}

// ── Polling ───────────────────────────────────────────────────────────────
async function refreshAll() {
  try {
    const { data } = await supa.auth.getSession();
    if (data.session) session = data.session;

    const [nextState, nextMarket] = await Promise.all([
      api("/api/me/state"),
      api("/api/market/feed"),
    ]);

    state = nextState;
    marketState = nextMarket;

    renderHeader();
    renderMarket();
    renderCopyEvents();
    renderPortfolio();

    if (!settingsDirty) renderSettings();
    updateSelectedLivePrice();
  } catch (error) {
    $("market-clock").textContent = `engine error: ${error.message}`;
    $("market-clock").classList.add("error");
  }
}

async function refreshState() {
  state = await api("/api/me/state");
  renderHeader();
  renderCopyEvents();
  renderPortfolio();
  if (!settingsDirty) renderSettings();
}

async function loadLeaders() {
  try {
    leaderboard = await api("/api/kolscan/leaderboard");
    renderLeaders();
  } catch (error) {
    $("leaderboard").innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
  }
}

function renderHeader() {
  if (!state) return;

  $("plan-chip").textContent = String(state.plan || "fomo").toUpperCase();
  $("plan-chip").className = `chip ${state.plan || "fomo"}`;

  const paper = state.mode === "paper";
  $("mode-chip").textContent = paper
    ? "PAPER TRADING"
    : state.liveTrading
      ? "LIVE TRADING"
      : "LIVE BLOCKED";
  $("mode-chip").className = `chip ${paper ? "paper" : state.liveTrading ? "live" : "blocked"}`;

  $("market-clock").classList.remove("error");
  $("market-clock").textContent = marketState.refreshTs
    ? `market ${time(marketState.refreshTs)}`
    : "market warming up";

  $("rpc-dots").innerHTML = (state.rpc || [])
    .map(rpc => `<i class="rpc-dot ${rpc.healthy ? "up" : ""}" title="${esc(rpc.url)}"></i>`)
    .join("");

  $("copy-top-n").value = state.settings?.followKolscanTop ?? 0;
}

// ── Scanner filters ───────────────────────────────────────────────────────
function filterValue(id) {
  const value = $(id).value;
  return value === "" ? null : Number(value);
}

function marketFilters() {
  return {
    search: $("market-search").value.trim().toLowerCase(),
    ageMax: filterValue("filter-age-max"),
    liquidityMin: filterValue("filter-liq-min") ?? 0,
    liquidityMax: filterValue("filter-liq-max"),
    marketCapMin: filterValue("filter-mcap-min") ?? 0,
    marketCapMax: filterValue("filter-mcap-max"),
    volumeMin: filterValue("filter-volume-min") ?? 0,
    txnsMin: filterValue("filter-txns-min") ?? 0,
    ratioMin: filterValue("filter-ratio-min") ?? 0,
    changeMin: filterValue("filter-change-min"),
    top10Max: filterValue("filter-top10-max"),
    dex: $("filter-dex").value,
    sort: $("filter-sort").value,
    dexPaid: $("filter-dex-paid").checked,
    socials: $("filter-socials").checked,
    security: $("filter-security").checked,
  };
}

function passesTab(item) {
  if (activeFeedTab === "watchlist") return watchlist.has(item.mint);
  if (activeFeedTab === "boosted") {
    return item.dex_paid ||
      number(item.boosts_active) > 0 ||
      (item.sources || []).some(source => ["boosted", "top_boosted", "ad"].includes(source));
  }
  if (activeFeedTab === "new") {
    return item.age_minutes !== null && number(item.age_minutes) <= 60;
  }
  return true;
}

function sortMarkets(list, sort) {
  const sorted = [...list];

  const descending = key => sorted.sort(
    (left, right) => number(right[key]) - number(left[key])
  );

  if (activeFeedTab === "new" || sort === "age") {
    return sorted.sort(
      (left, right) => number(left.age_minutes, 999999) - number(right.age_minutes, 999999)
    );
  }

  if (sort === "volume") return descending("volume_5m");
  if (sort === "liquidity") return descending("liquidity_usd");
  if (sort === "mcap") return descending("market_cap");
  if (sort === "change") return descending("change_5m");
  if (sort === "txns") return descending("txns_5m");

  return descending("trend_score");
}

function filteredMarkets() {
  const filters = marketFilters();

  const result = (marketState.items || []).filter(item => {
    if (!passesTab(item)) return false;

    if (filters.search) {
      const haystack = `${item.name} ${item.symbol} ${item.mint}`.toLowerCase();
      if (!haystack.includes(filters.search)) return false;
    }

    if (filters.ageMax !== null && item.age_minutes !== null && number(item.age_minutes) > filters.ageMax) return false;
    if (number(item.liquidity_usd) < filters.liquidityMin) return false;
    if (filters.liquidityMax !== null && number(item.liquidity_usd) > filters.liquidityMax) return false;
    if (number(item.market_cap) < filters.marketCapMin) return false;
    if (filters.marketCapMax !== null && number(item.market_cap) > filters.marketCapMax) return false;
    if (number(item.volume_5m) < filters.volumeMin) return false;
    if (number(item.txns_5m) < filters.txnsMin) return false;
    if (number(item.buy_sell_ratio) < filters.ratioMin) return false;
    if (filters.changeMin !== null && number(item.change_5m) < filters.changeMin) return false;
    if (filters.dex && item.dex_id !== filters.dex) return false;
    if (filters.dexPaid && !item.dex_paid) return false;
    if (filters.socials && !(item.socials || []).length) return false;
    if (filters.security && item.security_pass !== true) return false;

    if (filters.top10Max !== null) {
      if (item.top10_pct === null || item.top10_pct === undefined) return false;
      if (number(item.top10_pct) > filters.top10Max) return false;
    }

    return true;
  });

  return sortMarkets(result, filters.sort);
}

function updateDexOptions() {
  const select = $("filter-dex");
  const current = select.value;
  const dexes = [...new Set(
    (marketState.items || []).map(item => item.dex_id).filter(Boolean)
  )].sort();

  select.innerHTML = '<option value="">All</option>' + dexes
    .map(dex => `<option value="${esc(dex)}">${esc(dex)}</option>`)
    .join("");

  if (dexes.includes(current)) select.value = current;
}

function riskBadge(item) {
  if (item.security_pass === true) {
    return `<span class="risk-badge pass" title="Security gate passed">PASS</span>`;
  }

  if (item.security_checked && item.security_pass === false) {
    return `<span class="risk-badge blocked" title="Security gate blocked">BLOCKED</span>`;
  }

  return `<span class="risk-badge pending" title="Security not checked yet">PENDING</span>`;
}

function changeCell(value) {
  return `<td class="right mono ${positiveClass(value)}">${number(value) >= 0 ? "+" : ""}${fmt(value, 1)}%</td>`;
}

function renderMarket() {
  updateDexOptions();

  const rows = filteredMarkets();

  $("feed-count").textContent = `${rows.length} markets`;
  const autoTrader = marketState.autoTrader || {};
  const autoNote = autoTrader.lastOpenedAt
    ? `AUTO PAPER opened ${autoTrader.lastOpenedSymbol || short(autoTrader.lastOpenedMint)} at ${time(autoTrader.lastOpenedAt)}`
    : autoTrader.lastRunAt
      ? `AUTO PAPER: ${autoTrader.lastDecision || "scanning"}`
      : "AUTO PAPER warming up";

  $("feed-source-note").textContent = marketState.refreshTs
    ? `Live ${time(marketState.refreshTs)} · ${autoNote}`
    : "Discovering live Solana pools…";

  if (!rows.length) {
    $("market-rows").innerHTML = '<tr><td colspan="15" class="empty-cell">No markets match these filters.</td></tr>';
    return;
  }

  $("market-rows").innerHTML = rows.slice(0, 150).map(item => {
    const watched = watchlist.has(item.mint);
    const image = item.image_url
      ? `<img class="token-image" src="${esc(item.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="token-image fallback">${esc((item.symbol || "?").slice(0, 1))}</span>`;

    const freshness = item.market_stale ? "stale" : "live";
    const sources = (item.sources || []).slice(0, 2).join(" · ");

    return `<tr data-mint="${esc(item.mint)}">
      <td class="star-col">
        <button class="star-button ${watched ? "active" : ""}" data-watch="${esc(item.mint)}" title="Watchlist">★</button>
      </td>
      <td>
        <div class="pair-cell">
          ${image}
          <div>
            <strong>${esc(item.symbol || "?")}</strong>
            <span>${esc(item.name || item.symbol || "Unknown")}</span>
            <small><i class="dot ${freshness}"></i>${esc(short(item.mint))} · ${esc(sources || "market")}</small>
          </div>
        </div>
      </td>
      <td class="mono">${age(item.age_minutes)}</td>
      <td class="right mono"><strong>${price(item.price_usd)}</strong></td>
      ${changeCell(item.change_5m)}
      ${changeCell(item.change_1h)}
      ${changeCell(item.change_6h)}
      ${changeCell(item.change_24h)}
      <td class="right mono">
        <strong>${compact(item.txns_5m)}</strong>
        <small class="buy-sell"><b>${compact(item.buys_5m)}</b>/<em>${compact(item.sells_5m)}</em></small>
      </td>
      <td class="right mono">$${compact(item.volume_5m)}</td>
      <td class="right mono">$${compact(item.liquidity_usd)}</td>
      <td class="right mono">$${compact(item.market_cap ?? item.fdv)}</td>
      <td><span class="dex-badge">${esc(item.dex_id || "—")}</span></td>
      <td>${riskBadge(item)}</td>
      <td><button class="row-action" data-paper-buy="${esc(item.mint)}">Chart</button></td>
    </tr>`;
  }).join("");
}

function toggleWatch(mint) {
  if (watchlist.has(mint)) watchlist.delete(mint);
  else watchlist.add(mint);

  localStorage.setItem("eg-watchlist", JSON.stringify([...watchlist]));
  renderMarket();
}

function saveFilters() {
  const values = {};

  for (const id of FILTER_IDS) {
    const element = $(id);
    values[id] = element.type === "checkbox"
      ? element.checked
      : element.value;
  }

  localStorage.setItem("eg-filters", JSON.stringify(values));
}

function restoreFilters() {
  const saved = JSON.parse(localStorage.getItem("eg-filters") || "{}");

  for (const [id, value] of Object.entries(saved)) {
    const element = $(id);
    if (!element) continue;

    if (element.type === "checkbox") element.checked = Boolean(value);
    else element.value = value;
  }
}

function resetFilters() {
  localStorage.removeItem("eg-filters");
  $("filter-age-max").value = 60;
  $("filter-liq-min").value = 0;
  $("filter-liq-max").value = "";
  $("filter-mcap-min").value = 0;
  $("filter-mcap-max").value = "";
  $("filter-volume-min").value = 0;
  $("filter-txns-min").value = 0;
  $("filter-ratio-min").value = 0;
  $("filter-change-min").value = "";
  $("filter-top10-max").value = "";
  $("filter-dex").value = "";
  $("filter-sort").value = "trend";
  $("filter-dex-paid").checked = false;
  $("filter-socials").checked = false;
  $("filter-security").checked = false;
  renderMarket();
}

// ── Token drawer and chart ────────────────────────────────────────────────
function marketItem(mint) {
  return (marketState.items || []).find(item => item.mint === mint) || null;
}

async function openToken(mint) {
  selectedMint = mint;
  selectedDetail = null;

  $("token-drawer").classList.remove("hidden");
  $("token-drawer").setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  $("drawer-message").textContent = "";
  $("drawer-security").textContent = "Loading live security checks…";
  $("btn-paper-buy").disabled = true;

  renderSelectedSummary(marketItem(mint));

  try {
    selectedDetail = await api(`/api/market/token/${mint}`);
    renderSelectedDetail();
    await loadChart();
  } catch (error) {
    $("drawer-message").textContent = error.message;
    $("drawer-security").textContent = "Unable to load security details.";
  }
}

function closeDrawer() {
  $("token-drawer").classList.add("hidden");
  $("token-drawer").setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  selectedMint = null;
  selectedDetail = null;

  if (chart) {
    chart.remove();
    chart = null;
    candleSeries = null;
  }
}

function renderSelectedSummary(item) {
  if (!item) return;

  $("drawer-token-name").textContent = `${item.symbol || "?"} · ${item.name || "Unknown"}`;
  $("drawer-token-meta").textContent = `${short(item.mint, 6)} · ${item.dex_id || "unknown DEX"} · ${age(item.age_minutes)}`;
  $("drawer-price").textContent = price(item.price_usd);
  $("drawer-change").textContent = `${number(item.change_5m) >= 0 ? "+" : ""}${fmt(item.change_5m, 1)}% · 5m`;
  $("drawer-change").className = `change-pill ${positiveClass(item.change_5m)}`;

  const image = $("drawer-token-image");
  image.src = item.image_url || "";
  image.classList.toggle("hidden", !item.image_url);

  $("drawer-metrics").innerHTML = [
    ["Liquidity", `$${compact(item.liquidity_usd)}`],
    ["Market cap", `$${compact(item.market_cap ?? item.fdv)}`],
    ["5m volume", `$${compact(item.volume_5m)}`],
    ["5m txns", compact(item.txns_5m)],
    ["Buy / sell", fmt(item.buy_sell_ratio, 2)],
    ["24h change", `${number(item.change_24h) >= 0 ? "+" : ""}${fmt(item.change_24h, 1)}%`],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");

  $("paper-buy-size").value = state?.settings?.buySizeSol ?? 0.1;

  if (item.dex_url) {
    $("drawer-dex-link").href = item.dex_url;
    $("drawer-dex-link").classList.remove("disabled");
  } else {
    $("drawer-dex-link").removeAttribute("href");
    $("drawer-dex-link").classList.add("disabled");
  }
}

function renderSelectedDetail() {
  if (!selectedDetail) return;

  const snapshot = selectedDetail.snapshot;
  const security = selectedDetail.security;
  const item = marketItem(selectedMint);

  if (snapshot && item) {
    renderSelectedSummary({
      ...item,
      name: snapshot.baseToken?.name || item.name,
      symbol: snapshot.baseToken?.symbol || item.symbol,
      price_usd: snapshot.priceUsd,
      liquidity_usd: snapshot.liquidityUsd,
      market_cap: snapshot.marketCap,
      fdv: snapshot.fdv,
      volume_5m: snapshot.volume5m,
      txns_5m: number(snapshot.txns5m?.buys) + number(snapshot.txns5m?.sells),
      buy_sell_ratio: snapshot.txns5m?.sells > 0
        ? snapshot.txns5m.buys / snapshot.txns5m.sells
        : snapshot.txns5m?.buys > 0 ? 999 : 0,
      change_5m: snapshot.priceChange5m,
      change_24h: snapshot.priceChange24h,
      dex_url: snapshot.url,
      pair_address: snapshot.pairAddress,
      image_url: snapshot.imageUrl || item.image_url,
    });
  }

  const checks = security?.checks || {};

  $("drawer-security").innerHTML = Object.entries(checks).length
    ? Object.entries(checks).map(([name, check]) => `<div class="security-row ${check.pass ? "pass" : "fail"}">
        <span>${check.pass ? "✓" : "×"}</span>
        <div><strong>${esc(name)}</strong><small>${esc(check.detail || "")}</small></div>
      </div>`).join("")
    : '<div class="empty-state">No checks returned.</div>';

  $("btn-paper-buy").disabled = !(security?.pass && state?.mode === "paper");
  $("btn-paper-buy").textContent = security?.pass
    ? "PAPER buy with live quote"
    : "Blocked by strategy";
}

async function loadChart() {
  if (!selectedDetail?.snapshot?.pairAddress) return;

  $("chart-source").textContent = "Loading candles…";

  try {
    const payload = await api(
      `/api/market/chart/${selectedDetail.snapshot.pairAddress}` +
      `?timeframe=${chartTimeframe}` +
      `&aggregate=${chartAggregate}` +
      "&limit=500"
    );

    currentCandles = payload.candles || [];
    drawChart(currentCandles);
    $("chart-source").textContent = `${payload.source} · ${currentCandles.length} candles`;
  } catch (error) {
    $("chart-source").textContent = error.message;
  }
}

function drawChart(candles) {
  const container = $("token-chart");

  if (chart) chart.remove();

  chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 390,
    layout: {
      background: { color: "#0b0e12" },
      textColor: "#8d98a8",
      fontFamily: "JetBrains Mono, monospace",
    },
    grid: {
      vertLines: { color: "#171d25" },
      horzLines: { color: "#171d25" },
    },
    rightPriceScale: {
      borderColor: "#232b36",
    },
    timeScale: {
      borderColor: "#232b36",
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: {
      mode: 1,
    },
  });

  candleSeries = chart.addCandlestickSeries
    ? chart.addCandlestickSeries({
        upColor: "#34d399",
        downColor: "#fb7185",
        borderUpColor: "#34d399",
        borderDownColor: "#fb7185",
        wickUpColor: "#34d399",
        wickDownColor: "#fb7185",
      })
    : chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor: "#34d399",
        downColor: "#fb7185",
        borderUpColor: "#34d399",
        borderDownColor: "#fb7185",
        wickUpColor: "#34d399",
        wickDownColor: "#fb7185",
      });

  candleSeries.setData(candles);
  chart.timeScale().fitContent();
}

function updateSelectedLivePrice() {
  if (!selectedMint) return;

  const item = marketItem(selectedMint);
  if (!item) return;

  renderSelectedSummary(item);

  if (!candleSeries || !item.price_usd) return;

  const seconds = chartTimeframe === "hour"
    ? 3600 * chartAggregate
    : 60 * chartAggregate;
  const candleTime = Math.floor(Date.now() / 1000 / seconds) * seconds;
  const last = currentCandles[currentCandles.length - 1];
  let candle;

  if (last?.time === candleTime) {
    candle = {
      ...last,
      high: Math.max(number(last.high), number(item.price_usd)),
      low: Math.min(number(last.low), number(item.price_usd)),
      close: number(item.price_usd),
    };
    currentCandles[currentCandles.length - 1] = candle;
  } else {
    candle = {
      time: candleTime,
      open: number(item.price_usd),
      high: number(item.price_usd),
      low: number(item.price_usd),
      close: number(item.price_usd),
      volume: 0,
    };
    currentCandles.push(candle);
  }

  candleSeries.update(candle);
}

async function paperBuySelected() {
  if (!selectedMint) return;

  $("btn-paper-buy").disabled = true;
  $("drawer-message").textContent = "Requesting live Jupiter entry quote…";

  try {
    await api("/api/me/paper/buy", {
      method: "POST",
      body: JSON.stringify({
        mint: selectedMint,
        sizeSol: Number($("paper-buy-size").value),
      }),
    });

    $("drawer-message").textContent = "PAPER position opened with a live quote.";
    await refreshState();
  } catch (error) {
    const failed = error.payload?.checks || error.payload?.security;
    $("drawer-message").textContent = failed
      ? `${error.message}. Open the security checks above for the reason.`
      : error.message;
  } finally {
    $("btn-paper-buy").disabled = !(selectedDetail?.security?.pass && state?.mode === "paper");
  }
}

// ── Copytrade leaders ─────────────────────────────────────────────────────
function renderLeaders() {
  if (!leaderboard.length) {
    $("leaderboard").innerHTML = '<div class="empty-state">Leaderboard is warming up.</div>';
    return;
  }

  const followed = new Set((state?.traders || []).map(trader => trader.address));
  const autoTop = number(state?.settings?.followKolscanTop);

  $("leaderboard").innerHTML = leaderboard.slice(0, 25).map(trader => {
    const isFollowed = followed.has(trader.address);
    const automatic = trader.rank <= autoTop;

    return `<div class="leader-row">
      <div class="rank">#${trader.rank}</div>
      <div class="leader-name">
        <strong>${esc(trader.name || short(trader.address))}</strong>
        <span>${esc(short(trader.address, 6))}</span>
      </div>
      <div class="leader-stat">
        <span>Daily PnL</span>
        <strong class="${positiveClass(trader.pnlSol)}">${trader.pnlSol === null ? "—" : `${number(trader.pnlSol) >= 0 ? "+" : ""}${fmt(trader.pnlSol, 2)} SOL`}</strong>
      </div>
      <div class="leader-stat">
        <span>W / L</span>
        <strong>${trader.wins ?? "—"} / ${trader.losses ?? "—"}</strong>
      </div>
      <div class="leader-stat">
        <span>Win rate</span>
        <strong>${trader.winRate === null ? "—" : `${fmt(trader.winRate, 0)}%`}</strong>
      </div>
      <div class="leader-tags">
        ${automatic ? '<span class="mini-chip auto">AUTO PAPER</span>' : ""}
      </div>
      <button
        class="button compact ${isFollowed ? "danger" : "secondary"}"
        data-follow="${esc(trader.address)}"
        data-name="${esc(trader.name || "")}" 
        data-followed="${isFollowed}"
      >${isFollowed ? "Unfollow" : "Follow"}</button>
    </div>`;
  }).join("");
}

async function saveCopyTop() {
  if (!state) return;

  const next = clone(state.settings);
  next.followKolscanTop = Math.max(0, Math.min(25, Number($("copy-top-n").value) || 0));
  next.tradingMode = "paper";

  try {
    await api("/api/me/settings", {
      method: "PUT",
      body: JSON.stringify(next),
    });
    await refreshState();
    renderLeaders();
  } catch (error) {
    alert(error.message);
  }
}

function renderCopyEvents() {
  const events = state?.copyEvents || [];

  if (!events.length) {
    $("copy-events").innerHTML = '<div class="empty-state">Waiting for verified KOL swaps.</div>';
    return;
  }

  $("copy-events").innerHTML = events.slice(0, 60).map(event => {
    const status = event.block_reason || (event.executed ? "executed" : "watched");
    const paper = /PAPER/i.test(status);

    return `<div class="copy-event">
      <div class="copy-event-time">${time(event.ts)}</div>
      <span class="side-chip ${esc(event.side)}">${esc(event.side)}</span>
      <div class="copy-event-main">
        <strong>${esc(short(event.mint, 6))}</strong>
        <span>from ${esc(short(event.trader_address, 6))}</span>
        <small>${esc(status)}</small>
      </div>
      ${paper ? '<span class="mini-chip auto">PAPER</span>' : ""}
      ${event.trader_signature ? `<a href="${solscan(event.trader_signature)}" target="_blank" rel="noopener noreferrer">source tx</a>` : ""}
      ${event.our_signature ? `<a href="${solscan(event.our_signature)}" target="_blank" rel="noopener noreferrer">bot tx</a>` : ""}
    </div>`;
  }).join("");
}

// ── Portfolio ─────────────────────────────────────────────────────────────
function renderPortfolio() {
  if (!state) return;

  const paper = state.paper || {};
  const realized = number(paper.realizedPnlSol);
  const unrealized = number(paper.unrealizedPnlSol);

  $("paper-equity").textContent = `${fmt(paper.equitySol, 4)} SOL`;
  $("paper-starting").textContent = `Starting ${fmt(paper.startingSol, 4)} SOL`;
  $("paper-cash").textContent = `${fmt(paper.cashSol, 4)} SOL`;
  $("paper-invested").textContent = `${fmt(paper.investedSol, 4)} SOL`;
  $("paper-unrealized").textContent = `${unrealized >= 0 ? "+" : ""}${fmt(unrealized, 4)} SOL`;
  $("paper-unrealized").className = positiveClass(unrealized);
  $("paper-realized").textContent = `${realized >= 0 ? "+" : ""}${fmt(realized, 4)} SOL`;
  $("paper-realized").className = positiveClass(realized);
  $("paper-winrate").textContent = state.stats.winRate === null
    ? "—"
    : `${fmt(state.stats.winRate, 0)}%`;

  const positions = state.positions || [];
  const open = positions.filter(position => position.status === "alert" || position.status === "open");
  const closed = positions.filter(position => position.status === "closed");

  $("open-positions").innerHTML = open.length
    ? open.map(position => `<tr>
        <td><strong>${esc(position.symbol || short(position.mint))}</strong><small>${esc(short(position.mint, 6))}</small></td>
        <td>${position.source === "copytrade" ? `copy · ${esc(short(position.copied_from, 5))}` : esc(position.source || "sniper")}</td>
        <td class="right mono">${fmt(position.entry_sol, 4)} SOL</td>
        <td class="right mono ${positiveClass(position.last_change_pct)}">${position.last_change_pct === null ? "—" : `${number(position.last_change_pct) >= 0 ? "+" : ""}${fmt(position.last_change_pct, 1)}%`}</td>
        <td><small>Peak ${price(position.peak_price_usd)}</small></td>
        <td>${position.status === "alert" ? `<button class="button compact danger" data-paper-sell="${esc(position.id)}">Close</button>` : "LIVE"}</td>
      </tr>`).join("")
    : '<tr><td colspan="6" class="empty-cell">No open PAPER positions.</td></tr>';

  $("closed-positions").innerHTML = closed.length
    ? closed.slice(0, 100).map(position => `<tr>
        <td><strong>${esc(position.symbol || short(position.mint))}</strong><small>${esc(short(position.mint, 6))}</small></td>
        <td>${position.source === "copytrade" ? `copy · ${esc(short(position.copied_from, 5))}` : esc(position.source || "sniper")}</td>
        <td class="right mono ${positiveClass(position.pnl_pct)}">${position.pnl_pct === null ? "—" : `${number(position.pnl_pct) >= 0 ? "+" : ""}${fmt(position.pnl_pct, 1)}%`}<small>${position.pnl_sol === null ? "" : `${number(position.pnl_sol) >= 0 ? "+" : ""}${fmt(position.pnl_sol, 4)} SOL`}</small></td>
        <td><small>${esc(position.exit_reason || "—")}</small></td>
        <td><small>${dateTime(position.closed_at)}</small></td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="empty-cell">No closed PAPER trades yet.</td></tr>';
}

// ── Settings ──────────────────────────────────────────────────────────────
const SETTINGS_FIELDS = [
  ["tradingMode", "Execution mode", "mode"],
  ["paperStartingSol", "Paper starting SOL", "number"],
  ["paperAutoTradeEnabled", "Auto PAPER scanner", "boolean"],
  ["paperAutoEntriesPerTick", "Auto entries per scan", "number"],
  ["paperReentryCooldownMin", "Re-entry cooldown min", "number"],
  ["sniperEnabled", "Scanner strategy", "boolean"],
  ["copytradeEnabled", "Copytrade", "boolean"],
  ["buySizeSol", "Sniper size SOL", "number"],
  ["copySizeSol", "Copy size SOL", "number"],
  ["maxOpenPositions", "Max positions", "number"],
  ["slippageBps", "Slippage bps", "number"],
  ["followKolscanTop", "Auto-copy top N", "number"],
  ["entry.minLiquiditySol", "Min liquidity SOL", "number"],
  ["entry.minTxns5m", "Min 5m txns", "number"],
  ["entry.minBuySellRatio", "Min buy/sell", "number"],
  ["entry.maxPairAgeMin", "Max pair age min", "number"],
  ["entry.requireDexPaid", "Require DEX paid", "boolean"],
  ["entry.requireSocials", "Require socials", "boolean"],
  ["exit.baseTpPct", "Take profit %", "number"],
  ["exit.trailArmPct", "Trail arm %", "number"],
  ["exit.trailDropPct", "Trail drop %", "number"],
  ["exit.hardSlPct", "Hard stop %", "number"],
  ["exit.maxHoldMinutes", "Max hold min", "number"],
  ["exit.volumeDryupPct", "Volume dry-up %", "number"],
];

function getPath(object, path) {
  return path.split(".").reduce((current, key) => current?.[key], object);
}

function setPath(object, path, value) {
  const keys = path.split(".");
  let current = object;

  for (const key of keys.slice(0, -1)) {
    current[key] = current[key] || {};
    current = current[key];
  }

  current[keys.at(-1)] = value;
}

function renderSettings() {
  if (!state?.settings) return;

  $("settings-grid").innerHTML = SETTINGS_FIELDS.map(([path, label, type]) => {
    const value = getPath(state.settings, path);

    if (type === "boolean") {
      return `<label><span>${label}</span><select data-setting="${path}" data-type="boolean">
        <option value="true" ${value ? "selected" : ""}>On</option>
        <option value="false" ${!value ? "selected" : ""}>Off</option>
      </select></label>`;
    }

    if (type === "mode") {
      return `<label><span>${label}</span><select data-setting="${path}" data-type="mode">
        <option value="paper" ${value !== "live" ? "selected" : ""}>PAPER · demo money</option>
        <option value="live" ${value === "live" ? "selected" : ""}>LIVE · real money</option>
      </select></label>`;
    }

    return `<label><span>${label}</span><input data-setting="${path}" data-type="number" type="number" step="any" value="${esc(value)}" /></label>`;
  }).join("");
}

async function saveSettings() {
  if (!state) return;

  const next = clone(state.settings);

  $("settings-grid").querySelectorAll("[data-setting]").forEach(element => {
    const type = element.dataset.type;
    const value = type === "boolean"
      ? element.value === "true"
      : type === "mode"
        ? element.value
        : Number(element.value);

    setPath(next, element.dataset.setting, value);
  });

  try {
    await api("/api/me/settings", {
      method: "PUT",
      body: JSON.stringify(next),
    });

    settingsDirty = false;
    $("settings-message").textContent = "Saved";
    await refreshState();
  } catch (error) {
    $("settings-message").textContent = error.message;
  }
}

async function resetSettings() {
  try {
    await api("/api/me/settings", {
      method: "PUT",
      body: JSON.stringify({}),
    });

    settingsDirty = false;
    $("settings-message").textContent = "Reset";
    await refreshState();
  } catch (error) {
    $("settings-message").textContent = error.message;
  }
}

})();
