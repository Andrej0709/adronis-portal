// Adronis Portal — reads the Adronis Supabase database and changes the
// commercial side of an account: plan, subscription status, trial dates,
// renewal date and discount.
//
// There is no secret key anywhere in this file. The portal signs in with the
// same Supabase Auth the customer site uses, and everything it is allowed to
// see or change is decided in the database by supabase/portal-admin.sql:
//   - reading is granted by RLS policies that check is_portal_admin()
//   - writing goes through admin_* functions that whitelist their fields
//     and write an audit row for every change
// A non-admin who signs in here sees an empty database and every write fails.

(function () {
  "use strict";

  var db = window.supabase.createClient(
    window.LB_SUPABASE_URL,
    window.LB_SUPABASE_ANON_KEY
  );

  // Mirrors plan_price() in portal-admin.sql and PLANS in the site's
  // checkout.js. Kept here only so the table can show a per-row figure
  // without a round trip per row.
  var PRICE = { counter: 59, storefront: 149, franchise: 490, free: 0 };
  var ANNUAL_DISCOUNT = 0.2;

  var PLAN_LABEL = {
    counter: "Counter", storefront: "Storefront",
    franchise: "Franchise", free: "Free"
  };
  var STATUS_LABEL = {
    trialing: "trialing", active: "active",
    past_due: "past due", canceled: "canceled"
  };

  var state = {
    user: null,
    accounts: [],
    stats: null,
    audit: [],
    admins: [],
    view: "overview",
    sort: { key: "created_at", dir: -1 },
    open: null,           // the account id whose drawer is showing
    mode: null,           // the plan state picked in the drawer, once touched
    advOpen: false,       // the drawer's Advanced block, kept open across reloads
    flash: null,          // the last thing a write said, carried over a reload
    lastSeen: 0           // when somebody last touched the page
  };

  // The four states an account can be put into. Everything the portal writes
  // to the commercial side of an account is one of these - the raw fields are
  // still there under Advanced, but nothing routine needs them.
  var MODES = [
    { id: "trial",   label: "Trial" },
    { id: "paying",  label: "Paying" },
    { id: "forever", label: "Free forever" },
    { id: "none",    label: "No plan" }
  ];

  var $ = function (id) { return document.getElementById(id); };

  // --------------------------------------------------------------- helpers

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function euro(n) {
    return "€" + Math.round(Number(n) || 0).toLocaleString("en-US");
  }

  // An invoice amount as Paddle charged it, in its own currency.
  function money(n, currency) {
    if (!currency || currency === "EUR") return "€" + Number(n).toFixed(2);
    return Number(n).toFixed(2) + " " + currency;
  }

  function monthlyRate(plan, cycle) {
    var base = PRICE[plan] || 0;
    return cycle === "annual" ? base * (1 - ANNUAL_DISCOUNT) : base;
  }

  // The discount Paddle takes off this account's charges - a promo code from
  // checkout or one agreed here - as the site's paddle Edge Function mirrors
  // it from the subscription. null once it has run out, or with no running
  // subscription to take it off.
  function paddleDiscount(a) {
    var d = a.paddle_discount;
    if (!d || !viaPaddle(a)) return null;
    if (d.ends_at && new Date(d.ends_at) <= new Date()) return null;
    return d;
  }

  // "20%" or "€10.00", and what it is: the promo code, or where it came from.
  function discountSize(d) {
    return d.type === "percentage" ? Number(d.amount) + "%" : money(Number(d.amount) / 100, d.currency);
  }

  function discountSource(d) {
    return d.code || (d.source === "portal" ? "agreed here" : "set in Paddle");
  }

  // A monthly figure with a discount taken off. A flat discount comes off
  // every charge, so on an annual plan it is a twelfth of it per month.
  function netMonthly(amount, d, cycle) {
    if (!d) return amount;
    if (d.type === "percentage") return amount * (1 - Number(d.amount) / 100);
    return Math.max(0, amount - Number(d.amount) / 100 / (cycle === "annual" ? 12 : 1));
  }

  // What this account bills per month right now: zero unless it is actually
  // paying, and net of the discount Paddle takes off. A comped account is
  // active and has the full plan, but it was given away - it bills nothing.
  function mrr(a) {
    if (a.comped) return 0;
    if (a.subscription_status !== "active") return 0;
    return netMonthly(monthlyRate(a.plan, a.billing_cycle), paddleDiscount(a), a.billing_cycle);
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return d.toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  function daysFromNow(iso) {
    if (!iso) return null;
    return Math.round((new Date(iso) - new Date()) / 86400000);
  }

  function relDays(iso) {
    var d = daysFromNow(iso);
    if (d === null) return "";
    if (d === 0) return "today";
    if (d > 0) return "in " + d + "d";
    return Math.abs(d) + "d ago";
  }

  function statusPill(s) {
    if (!s) return '<span class="pill pill-none">no subscription</span>';
    return '<span class="pill pill-' + esc(s) + '">' + esc(STATUS_LABEL[s] || s) + "</span>";
  }

  function planLabel(p) {
    return p ? (PLAN_LABEL[p] || p) : "—";
  }

  function cycleOptions(selected) {
    return ["monthly", "annual"].map(function (c) {
      return '<option value="' + c + '"' + (selected === c ? " selected" : "") + ">" + c + "</option>";
    }).join("");
  }

  // A <input type="date"> round trip. Noon local, so a renewal date can never
  // land on the day before through a timezone offset.
  function toDateInput(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function fromDateInput(v) {
    if (!v) return "";
    var d = new Date(v + "T12:00");
    return isNaN(d) ? "" : d.toISOString();
  }

  function addMonths(n) {
    var d = new Date();
    d.setMonth(d.getMonth() + n);
    return d.toISOString();
  }

  // ------------------------------------------------ what an account is now

  // Which of the four states the account is in today. This is what the plan
  // editor opens on, so opening an account and pressing Apply without touching
  // anything else is always a no-op in spirit.
  function currentMode(a) {
    if (a.comped) return "forever";
    if (a.subscription_status === "trialing") return "trial";
    if (a.subscription_status === "active") return "paying";
    return "none";
  }

  // One plain sentence for the top of the plan editor. It says what the
  // account is, not which columns hold it.
  function stateLine(a) {
    var p = planLabel(a.plan);

    if (a.comped) {
      return p + " — free forever" +
             (a.comped_reason ? " · " + a.comped_reason : "") +
             ". No renewal date, so it is never charged and never runs out.";
    }
    // A plan switch waits for the next charge, so say which one is coming.
    var switching = a.pending_plan && !a.cancel_at_period_end
      ? " Switches to " + planLabel(a.pending_plan) + " · " +
        (a.pending_billing_cycle || a.billing_cycle || "monthly") + " at the next charge."
      : "";

    // Only ever set by hand, before Paddle: nothing charges it, so it runs out.
    if (!a.paddle_subscription_id && a.current_period_end &&
        (a.subscription_status === "trialing" || a.subscription_status === "active")) {
      return p + " — set by hand before Paddle, and nothing charges it. It ends " +
             fmtDate(a.current_period_end) + " (" + relDays(a.current_period_end) + "); " +
             "to keep the plan, the customer checks out.";
    }
    if (a.subscription_status === "trialing") {
      var trialEnd = a.trial_ends_at || a.current_period_end;
      return p + " — on trial, " + (a.cancel_at_period_end ? "cancels " : "ends ") +
             fmtDate(trialEnd) + " (" + relDays(trialEnd) + ")." + switching;
    }
    if (a.subscription_status === "active") {
      if (!a.current_period_end) {
        return p + " — active with no renewal date on it. Nothing will charge " +
               "or cancel it, but it is not marked free forever either.";
      }
      return p + " · " + (a.billing_cycle || "monthly") + " — paying, " +
             (a.cancel_at_period_end ? "cancels " : "renews ") +
             fmtDate(a.current_period_end) + " (" + relDays(a.current_period_end) + ")." + switching;
    }
    if (a.subscription_status === "past_due") {
      return p + " — past due. " + (a.paddle_subscription_id
        ? "Paddle could not charge the card and is retrying; the customer still has access."
        : "The customer still has access; nothing has charged.");
    }
    if (a.subscription_status === "canceled") {
      return p + " — canceled. They are on the free allowance.";
    }
    return a.plan
      ? p + " picked at signup, but no plan ever started."
      : "No plan, and none picked yet.";
  }

  // What the trial box opens on: what is left of a running trial, otherwise
  // the site-wide trial length.
  function trialDefaultDays(a) {
    if (a.subscription_status === "trialing" && a.trial_ends_at) {
      var left = daysFromNow(a.trial_ends_at);
      if (left > 0) return left;
    }
    return 7;   // the trial on the Paddle trial prices
  }

  // What the next charge box opens on: the date it already has, or a first
  // period starting today.
  function payingDefaultEnd(a) {
    if (a.current_period_end) return a.current_period_end;
    return addMonths(a.billing_cycle === "annual" ? 12 : 1);
  }

  // Does this account pay through Paddle right now? Then Paddle holds the
  // truth about its plan: the editor changes it through the site's paddle
  // Edge Function, and the raw billing fields are not written by hand.
  function viaPaddle(a) {
    return !!a.paddle_subscription_id && !a.comped &&
      ["trialing", "active", "past_due"].indexOf(a.subscription_status) !== -1;
  }

  // Is there a period left that a cancellation could run out to?
  function canRunOut(a) {
    return !!(a.current_period_end &&
      (a.subscription_status === "trialing" || a.subscription_status === "active"));
  }

  // ------------------------------------------------------------- boot/auth

  async function boot() {
    var res = await db.auth.getSession();
    var session = res.data.session;

    if (!session) { showGate(); return; }

    // A session left open on a screen somebody else can reach is the whole
    // risk here, so a stale one is ended before anything is read, not after.
    if (idleFor() >= IDLE_MS) { await expire(); return; }

    var adm = await db.rpc("is_portal_admin");
    if (adm.error || !adm.data) {
      await db.auth.signOut();
      showGate("That account is signed in, but it is not on the admin list.");
      return;
    }

    state.user = session.user;
    $("gate").hidden = true;
    $("app").hidden = false;
    markSeen();
    await loadAll();
  }

  function showGate(msg) {
    $("app").hidden = true;
    $("gate").hidden = false;
    if (msg) {
      $("li-error").textContent = msg;
      $("li-error").hidden = false;
    }
  }

  // ------------------------------------------------------- idle sign-out
  //
  // Half an hour of nobody touching the portal ends the session. This runs in
  // the browser, so it is not a security boundary on its own - the database
  // still decides what a token may read, and Supabase expires the token in its
  // own time. It is here for the ordinary case: a portal left open on a
  // laptop, with every customer's email and every figure in the business on
  // the screen behind whoever walks past it.

  var IDLE_MS = 30 * 60 * 1000;
  var WARN_MS = 60 * 1000;          // the last minute is spent saying so
  var SEEN_KEY = "adronis-portal-last-seen";

  // Written where every tab can read it, so working in one tab keeps the
  // others alive rather than leaving them to expire behind it.
  function markSeen() {
    var now = Date.now();
    state.lastSeen = now;
    try { localStorage.setItem(SEEN_KEY, String(now)); } catch (e) { /* private mode */ }
    if (!$("idle-warn").hidden) $("idle-warn").hidden = true;
  }

  function idleFor() {
    var stored = 0;
    try { stored = Number(localStorage.getItem(SEEN_KEY)) || 0; } catch (e) { /* private mode */ }
    var seen = Math.max(stored, state.lastSeen || 0);
    if (!seen) return 0;                     // never seen: this visit is now
    return Date.now() - seen;
  }

  async function expire() {
    state.user = null;
    closeDrawer();
    try { localStorage.removeItem(SEEN_KEY); } catch (e) { /* private mode */ }
    $("idle-warn").hidden = true;
    await db.auth.signOut();
    showGate("Your session ended after 30 minutes without anybody touching it. Sign in again.");
  }

  // Wall-clock, not a timeout: a laptop that slept for an hour comes back to
  // an expired session, which a pending setTimeout would not have given.
  async function idleTick() {
    if (!state.user) return;

    var idle = idleFor();
    if (idle >= IDLE_MS) { await expire(); return; }

    var left = IDLE_MS - idle;
    if (left <= WARN_MS) {
      $("idle-warn").hidden = false;
      $("idle-left").textContent = Math.max(1, Math.ceil(left / 1000)) + "s";
    } else if (!$("idle-warn").hidden) {
      $("idle-warn").hidden = true;
    }
  }

  ["mousedown", "keydown", "wheel", "touchstart", "scroll"].forEach(function (ev) {
    document.addEventListener(ev, function () {
      if (state.user) markSeen();
    }, { passive: true, capture: true });
  });

  // Coming back to a tab that was in the background is the moment the check
  // matters most - the interval behind it may have been throttled to nothing.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) idleTick();
  });

  $("idle-stay").addEventListener("click", markSeen);

  setInterval(idleTick, 5000);

  $("login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var btn = $("li-btn");
    var err = $("li-error");
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Signing in…";

    var res = await db.auth.signInWithPassword({
      email: $("li-email").value.trim(),
      password: $("li-pass").value
    });

    btn.disabled = false;
    btn.textContent = "Sign in";

    if (res.error) {
      err.textContent = res.error.message || "That did not work.";
      err.hidden = false;
      return;
    }
    $("li-pass").value = "";
    await boot();
  });

  $("logout").addEventListener("click", async function () {
    await db.auth.signOut();
    location.reload();
  });

  $("refresh").addEventListener("click", function () { loadAll(); });

  // ------------------------------------------------------------- data load

  async function loadAll() {
    var btn = $("refresh");
    btn.disabled = true;
    btn.textContent = "Loading…";

    var r = await Promise.all([
      db.from("profiles").select("*").order("created_at", { ascending: false }),
      db.rpc("admin_stats"),
      db.from("admin_audit").select("*").order("at", { ascending: false }).limit(200),
      db.from("portal_admins").select("*").order("added_at")
    ]);

    btn.disabled = false;
    btn.textContent = "Refresh";

    state.stats = r[1].data || null;
    state.audit = r[2].data || [];
    state.admins = r[3].data || [];
    var me = state.admins.filter(function (m) { return m.user_id === state.user.id; })[0];
    $("who").textContent = (me && me.username) || state.user.email;

    // An admin's own Adronis login has a profiles row like anyone else's.
    // It is not a customer, so it stays out of the list — admin_stats leaves
    // it out of the numbers for the same reason.
    var staff = {};
    state.admins.forEach(function (m) { staff[m.user_id] = true; });
    state.accounts = (r[0].data || []).filter(function (a) { return !staff[a.id]; });

    renderOverview();
    renderAccounts();
    renderAudit();
    renderSettings();
    if (state.open) openDrawer(state.open);   // keep the drawer in step
  }

  // -------------------------------------------------------------- overview

  function renderOverview() {
    var s = state.stats;
    if (!s) return;

    $("ov-stamp").textContent = "as of " + new Date().toLocaleTimeString("en-GB",
      { hour: "2-digit", minute: "2-digit" });

    // s.paying is the active accounts that are not comped. A comped account
    // has the full plan and is 'active' like any other, so counting it here
    // would put revenue next to a figure that is zero by definition.
    var paying = s.paying == null ? s.active : s.paying;

    var tiles = [
      { k: "Monthly revenue", v: euro(s.mrr), sub: paying + " paying account" + (paying === 1 ? "" : "s") },
      // What Paddle actually took, as opposed to what the list prices add up to.
      { k: "Collected, 30 days", v: euro(s.collected_30d), sub: (s.invoices_30d || 0) + " paid invoice" +
          (s.invoices_30d === 1 ? "" : "s") + ", VAT included" },
      { k: "In trial", v: s.trialing, sub: euro(s.mrr_if_trials_convert) + " if they all convert" },
      { k: "Accounts", v: s.accounts, sub: s.onboarded + " finished the brief" },
      { k: "Free forever", v: s.comped || 0, sub: "given the plan, never charged" },
      { k: "Cancelling", v: s.cancelling, sub: "at the end of their period" },
      { k: "Card failed", v: s.past_due, sub: "Paddle is retrying · " + s.canceled + " canceled" },
      { k: "On a discount", v: s.discounted, sub: "agreed per account, charged by Paddle" }
    ];

    $("ov-tiles").innerHTML = tiles.map(function (t) {
      return '<div class="tile"><div class="tile-k">' + esc(t.k) + "</div>" +
             '<div class="tile-v">' + esc(t.v) + "</div>" +
             '<div class="tile-sub">' + esc(t.sub) + "</div></div>";
    }).join("");

    renderSignups(s.signups_30d || []);
    renderMix(s.by_plan || []);
    renderMini("ov-trials", s.trials_ending_7d || [], "trial_ends_at", "No trial ends this week.");
    renderMini("ov-renewals", s.renewals_7d || [], "current_period_end", "Nothing renews this week.");
  }

  // A plain SVG bar chart — 30 bars, one per day, zero-filled by the query so
  // a quiet day is a visible flat bar rather than a gap in the axis.
  //
  // It is drawn at the width it actually has, one unit to a pixel, so the date
  // labels stay the same size on a phone as on a desktop instead of being
  // squeezed to half of it. A hidden tab has no width yet; it is drawn again
  // when it is shown and whenever the window changes size.
  var signupRows = [];

  function signupTotal() {
    var total = signupRows.reduce(function (n, r) { return n + Number(r.n); }, 0);
    return total + " signup" + (total === 1 ? "" : "s");
  }

  function renderSignups(rows) {
    signupRows = rows;
    $("ov-signup-total").textContent = signupTotal();

    var W = Math.round($("ov-signups").clientWidth) || 620;
    var H = W < 480 ? 130 : 150, pad = 18;
    var max = Math.max(1, Math.max.apply(null, rows.map(function (r) { return Number(r.n); })));
    var bw = (W - pad * 2) / Math.max(rows.length, 1);

    var bars = rows.map(function (r, i) {
      var n = Number(r.n);
      var h = n === 0 ? 2 : Math.max(3, (n / max) * (H - pad * 2));
      var x = pad + i * bw;
      var y = H - pad - h;
      return '<rect data-i="' + i + '" class="bar' + (n === 0 ? " bar-empty" : "") + '" x="' + (x + 1).toFixed(1) +
             '" y="' + y.toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) +
             '" height="' + h.toFixed(1) + '" rx="2"><title>' +
             esc(fmtDate(r.day)) + ": " + n + "</title></rect>";
    }).join("");

    var first = rows.length ? fmtDate(rows[0].day) : "";
    var last = rows.length ? fmtDate(rows[rows.length - 1].day) : "";

    $("ov-signups").innerHTML =
      '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" ' +
      'aria-label="Signups per day over the last 30 days">' +
      bars +
      '<line class="axis" x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '"/>' +
      '<text class="lbl" x="' + pad + '" y="' + (H - 5) + '">' + esc(first) + "</text>" +
      '<text class="lbl" x="' + (W - pad) + '" y="' + (H - 5) + '" text-anchor="end">' + esc(last) + "</text>" +
      "</svg>";
  }

  // A bar's <title> only shows on a mouse hover, so the day under the pointer
  // or the finger is written into the panel head instead. Sliding a finger
  // along the chart reads it day by day; the page still scrolls up and down.
  function readSignupAt(e) {
    var svg = $("ov-signups").querySelector("svg");
    if (!svg || !signupRows.length) return;
    var box = svg.getBoundingClientRect();
    var pad = 18 * (box.width / svg.viewBox.baseVal.width);
    var i = Math.floor((e.clientX - box.left - pad) / ((box.width - pad * 2) / signupRows.length));
    i = Math.max(0, Math.min(signupRows.length - 1, i));

    var r = signupRows[i];
    $("ov-signup-total").textContent = fmtDate(r.day) + " · " + r.n +
      " signup" + (Number(r.n) === 1 ? "" : "s");
    Array.prototype.forEach.call(svg.querySelectorAll(".bar"), function (b) {
      b.classList.toggle("is-on", Number(b.dataset.i) === i);
    });
  }

  function clearSignupRead() {
    $("ov-signup-total").textContent = signupTotal();
    Array.prototype.forEach.call($("ov-signups").querySelectorAll(".bar.is-on"), function (b) {
      b.classList.remove("is-on");
    });
  }

  $("ov-signups").addEventListener("pointerdown", readSignupAt);
  $("ov-signups").addEventListener("pointermove", function (e) {
    if (e.pointerType === "mouse" || e.buttons) readSignupAt(e);
  });
  $("ov-signups").addEventListener("pointerleave", function (e) {
    if (e.pointerType === "mouse") clearSignupRead();
  });
  // A tap anywhere else on the page puts the total back.
  document.addEventListener("pointerdown", function (e) {
    if (!e.target.closest || !e.target.closest("#ov-signups")) clearSignupRead();
  });

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (state.view === "overview" && signupRows.length) renderSignups(signupRows);
    }, 120);
  });

  function renderMix(rows) {
    var max = Math.max.apply(null, rows.map(function (r) { return Number(r.n); }).concat([1]));
    $("ov-mix").innerHTML = rows.map(function (r) {
      var name = r.plan === "none" ? "No plan" : planLabel(r.plan);
      return '<div class="mix-row"><span class="mix-name">' + esc(name) + "</span>" +
             '<span class="mix-track"><span class="mix-fill" style="width:' +
             ((Number(r.n) / max) * 100).toFixed(1) + '%"></span></span>' +
             '<span class="mix-n">' + esc(r.n) + "</span></div>";
    }).join("") || '<p class="panel-note">No accounts yet.</p>';
  }

  function renderMini(elId, rows, dateKey, emptyText) {
    if (!rows.length) {
      $(elId).innerHTML = '<p class="panel-note">' + esc(emptyText) + "</p>";
      return;
    }
    $(elId).innerHTML =
      '<div class="table-wrap" style="border:none"><table class="mini"><tbody>' +
      rows.map(function (r) {
        return '<tr data-open="' + esc(r.id) + '">' +
          '<td><span class="cell-main">' + esc(r.business_name || "—") + "</span>" +
          '<span class="cell-sub">' + esc(r.email) + "</span></td>" +
          '<td><span class="pill pill-acc">' + esc(planLabel(r.plan)) + "</span></td>" +
          '<td class="num">' + esc(fmtDate(r[dateKey])) +
          '<span class="cell-sub">' + esc(relDays(r[dateKey])) + "</span></td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  // -------------------------------------------------------------- accounts

  function filtered() {
    var q = $("ac-search").value.trim().toLowerCase();
    var st = $("ac-status").value;
    var pl = $("ac-plan").value;
    var fl = $("ac-flag").value;

    return state.accounts.filter(function (a) {
      if (q) {
        var hay = [a.email, a.business_name, a.city, a.country, a.vertical, a.website]
          .join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      if (st === "none" && a.subscription_status) return false;
      if (st && st !== "none" && a.subscription_status !== st) return false;
      if (pl === "none" && a.plan) return false;
      if (pl && pl !== "none" && a.plan !== pl) return false;
      if (fl === "discount" && !paddleDiscount(a) && !(a.discount_percent > 0)) return false;
      if (fl === "comped" && !a.comped) return false;
      if (fl === "cancelling" && !a.cancel_at_period_end) return false;
      if (fl === "pending" && !a.pending_plan && !a.pending_billing_cycle) return false;
      if (fl === "brief" && a.onboarded_at) return false;
      return true;
    });
  }

  function sortValue(a, key) {
    if (key === "mrr") return mrr(a);
    if (key === "renews") return new Date(a.trial_ends_at || a.current_period_end || 0).getTime();
    if (key === "created_at") return new Date(a.created_at || 0).getTime();
    if (key === "discount_percent") {
      var d = paddleDiscount(a);
      return d ? (d.type === "percentage" ? Number(d.amount) : 0.5) : (a.discount_percent || 0);
    }
    return (a[key] || "").toString().toLowerCase();
  }

  function renderAccounts() {
    var rows = filtered();
    var key = state.sort.key, dir = state.sort.dir;

    rows.sort(function (x, y) {
      var a = sortValue(x, key), b = sortValue(y, key);
      if (a < b) return -1 * dir;
      if (a > b) return 1 * dir;
      return 0;
    });

    $("ac-count").textContent = rows.length + " of " + state.accounts.length;
    $("ac-empty").hidden = rows.length > 0;

    Array.prototype.forEach.call(document.querySelectorAll("#ac-table th"), function (th) {
      th.classList.toggle("sorted", th.dataset.sort === key);
    });

    // Keep the phone's sort menu on the order the table is actually in. A
    // header click can pick an order the menu has no line for; it then shows
    // blank rather than naming an order that is not the one on screen.
    $("ac-sort").value = key + ":" + dir;
    if ($("ac-sort").selectedIndex === -1) $("ac-sort").value = "";

    $("ac-body").innerHTML = rows.map(function (a) {
      var when = a.subscription_status === "trialing" ? a.trial_ends_at : a.current_period_end;
      var whenLabel = a.subscription_status === "trialing" ? "trial ends " : "renews ";
      var m = mrr(a);

      var flags = "";
      if (a.comped && a.comped_reason) flags += '<span class="cell-sub">' + esc(a.comped_reason) + "</span>";
      else if (a.cancel_at_period_end) flags += '<span class="cell-sub">cancels at period end</span>';
      else if (a.pending_plan) flags += '<span class="cell-sub">switching to ' + esc(planLabel(a.pending_plan)) + "</span>";
      var place = [a.city, a.country].filter(Boolean).join(", ");
      var pd = paddleDiscount(a);

      // data-label is what a cell is called when the row is a card on a phone
      // and there is no header row above it to say so.
      return '<tr data-open="' + esc(a.id) + '"' + (state.open === a.id ? ' class="is-open"' : "") + ">" +
        '<td><span class="cell-main">' + esc(a.business_name || "—") + "</span>" +
          '<span class="cell-sub">' + esc(a.email) + (place ? " · " + esc(place) : "") + "</span></td>" +
        '<td data-label="Plan">' + esc(planLabel(a.plan)) +
          (a.billing_cycle ? '<span class="cell-sub">' + esc(a.billing_cycle) + "</span>" : "") + "</td>" +
        "<td>" + (a.comped
            ? '<span class="pill pill-comped">free forever</span>'
            : statusPill(a.subscription_status)) + flags + "</td>" +
        '<td class="num" data-label="Discount">' + (pd
            ? esc(discountSize(pd)) + '<span class="cell-sub">' + esc(discountSource(pd)) + "</span>"
            : a.discount_percent
              ? esc(a.discount_percent) + '%<span class="cell-sub">agreed, not in Paddle yet</span>'
              : "—") + "</td>" +
        '<td class="num" data-label="MRR">' + (m ? euro(m) : "—") + "</td>" +
        '<td class="num" data-label="Trial / renews">' + (a.comped
            ? '∞<span class="cell-sub">no renewal</span>'
            : (when ? esc(fmtDate(when)) +
                '<span class="cell-sub">' + whenLabel + esc(relDays(when)) + "</span>" : "—")) + "</td>" +
        '<td class="num" data-label="Signed up">' + esc(fmtDate(a.created_at)) +
          (a.onboarded_at ? "" : '<span class="cell-sub">no brief</span>') + "</td>" +
        "</tr>";
    }).join("");
  }

  ["ac-search", "ac-status", "ac-plan", "ac-flag"].forEach(function (id) {
    $(id).addEventListener("input", renderAccounts);
  });

  document.querySelector("#ac-table thead").addEventListener("click", function (e) {
    var th = e.target.closest("th");
    if (!th || !th.dataset.sort) return;
    if (state.sort.key === th.dataset.sort) state.sort.dir *= -1;
    else state.sort = { key: th.dataset.sort, dir: th.dataset.sort === "business_name" ? 1 : -1 };
    renderAccounts();
  });

  $("ac-sort").addEventListener("change", function () {
    var v = $("ac-sort").value.split(":");
    if (!v[0]) return;
    state.sort = { key: v[0], dir: Number(v[1]) };
    renderAccounts();
  });

  // One listener for every table in the app — overview mini tables included.
  document.addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-open]");
    if (tr) openDrawer(tr.dataset.open);
  });

  // ---------------------------------------------------------------- drawer

  function account(id) {
    return state.accounts.filter(function (a) { return a.id === id; })[0] || null;
  }

  function openDrawer(id) {
    var a = account(id);
    if (!a) return;

    // A different account means a fresh editor: the state picked for the last
    // one must not carry over into this one.
    if (state.open !== id) state.mode = null;
    state.open = id;

    var mode = state.mode || currentMode(a);

    var brief = [
      ["Country", a.country], ["City", a.city], ["Business type", a.vertical], ["Website", a.website],
      ["Sells", a.what_you_sell], ["Typical customer", a.typical_customer],
      ["Differentiator", a.differentiator], ["Why us", a.why_us],
      ["Brand vibe", a.brand_vibe], ["Brand colors", a.brand_colors],
      ["Avoid", a.avoid_notes],
      ["Channels", (a.channels || []).join(", ")],
      ["Brief finished", a.onboarded_at ? fmtDate(a.onboarded_at) : "not yet"],
      ["Terms accepted", a.terms_accepted_at
        ? fmtDate(a.terms_accepted_at) + (a.terms_version ? " (" + a.terms_version + ")" : "")
        : "no record"]
    ];

    var history = (a.billing_history || []).slice().reverse();
    var paddle = viaPaddle(a);
    var paddleTrial = paddle && a.subscription_status === "trialing";
    // Paddle already bills the plan a switch is waiting on, so the editor
    // opens on that one: Apply without touching the plan keeps the switch.
    var nextPlan = (paddle && a.pending_plan) || a.plan || "storefront";
    var nextCycle = (paddle && a.pending_plan && a.pending_billing_cycle) || a.billing_cycle;
    // Every trial and paid plan is a Paddle subscription, and one only starts
    // where Paddle takes the card. The portal can't start one for them.
    var checkoutOnly = '<p class="field-hint">Trials and paid plans start at checkout, where ' +
      "Paddle takes the card — the portal can't start one. Send the customer to " +
      "<b>adronis.app/checkout.html</b>; one trial per account still applies there." +
      (a.comped ? " Set <b>No plan</b> first: a free-forever account can't check out." : "") +
      "</p>";

    $("drawer").innerHTML =
      '<div class="drawer-head">' +
        "<div><h3>" + esc(a.business_name || "Unnamed business") + "</h3></div>" +
        '<span class="spacer"></span>' +
        '<button class="x-btn" id="dr-close" aria-label="Close">×</button>' +
      "</div>" +
      '<p class="drawer-mail">' + esc(a.email) + "</p>" +

      // ---------------------------------------------------------- the plan
      // One block for the whole commercial state of the account. You pick
      // what it should BE, and the function behind it writes every field
      // that state implies. Everything raw lives under "Advanced" below.
      "<h4>Plan</h4>" +
      '<p class="state-now">' + esc(stateLine(a)) + "</p>" +
      (paddle
        ? '<p class="field-hint" style="margin:-4px 0 12px">Pays through Paddle — ' +
            esc(a.paddle_subscription_id) + (a.paddle_customer_id ? ", customer " + esc(a.paddle_customer_id) : "") +
            ". Apply makes the change in Paddle itself, and the account follows " +
            "from what Paddle says.</p>"
        : "") +

      '<div class="modes" id="dr-modes" role="group" aria-label="What this account should be">' +
        MODES.map(function (m) {
          return '<button type="button" class="mode' + (m.id === mode ? " is-on" : "") +
                 '" data-mode="' + m.id + '">' + esc(m.label) + "</button>";
        }).join("") +
      "</div>" +

      /* ---- trial ---- */
      '<div class="mode-body" data-for="trial"' + (mode === "trial" ? "" : " hidden") + ">" +
        (paddle && !paddleTrial
          ? '<p class="field-hint">This account already pays through Paddle, so it ' +
              "can't go back on a trial. To give it free days, use <b>Paying</b> and " +
              "move the next charge date.</p>"
          : "") +
        (paddle ? "" : checkoutOnly) +
        '<div class="field-row"' + (paddleTrial ? "" : " hidden") + ">" +
          '<div class="field"><label for="dr-t-plan">PLAN</label><select id="dr-t-plan">' +
            planOptions(nextPlan) + "</select></div>" +
          '<div class="field"><label for="dr-t-cycle">PAYS AFTERWARDS</label><select id="dr-t-cycle">' +
            cycleOptions(nextCycle) + "</select></div>" +
        "</div>" +
        '<div class="field" style="max-width:240px"' + (paddleTrial ? "" : " hidden") + ">" +
          '<label for="dr-t-days">RUNS FOR, FROM TODAY</label>' +
          '<input id="dr-t-days" type="number" min="1" max="3650" value="' + trialDefaultDays(a) + '"></div>' +
        '<div class="quick"' + (paddleTrial ? "" : " hidden") + ">" +
          '<button type="button" class="btn-ghost btn-sm" data-add="7">+7 days</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-add="14">+14</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-add="30">+30</button>' +
        "</div>" +
      "</div>" +

      /* ---- paying ---- */
      '<div class="mode-body" data-for="paying"' + (mode === "paying" ? "" : " hidden") + ">" +
        (paddle ? "" : checkoutOnly) +
        '<div class="field-row"' + (paddle ? "" : " hidden") + ">" +
          '<div class="field"><label for="dr-p-plan">PLAN</label><select id="dr-p-plan">' +
            planOptions(nextPlan) + "</select></div>" +
          '<div class="field"><label for="dr-p-cycle">BILLED</label><select id="dr-p-cycle">' +
            cycleOptions(nextCycle) + "</select></div>" +
        "</div>" +
        // A Paddle trial turns paying by ending now and charging the card, so
        // there is no date to pick - the next charge follows one period later.
        (paddleTrial
          ? '<p class="field-hint">Ends the trial today and Paddle charges the card ' +
              "on file straight away. The next charge follows one billing period later.</p>"
          : "") +
        '<div class="field" style="max-width:240px"' + (paddle && !paddleTrial ? "" : " hidden") + ">" +
          '<label for="dr-p-until">NEXT CHARGE</label>' +
          '<input id="dr-p-until" type="date" value="' + toDateInput(payingDefaultEnd(a)) + '"></div>' +
        '<div class="quick"' + (paddle && !paddleTrial ? "" : " hidden") + ">" +
          '<button type="button" class="btn-ghost btn-sm" data-months="1">a month from today</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-months="12">a year from today</button>' +
        "</div>" +
        (paddle && !paddleTrial
          ? '<p class="field-hint">A later date gives the days in between for free; ' +
              "an earlier one charges sooner. A plan or cycle switch is billed from the " +
              "next charge, the same as when the customer switches.</p>"
          : "") +
      "</div>" +

      /* ---- free forever ---- */
      '<div class="mode-body" data-for="forever"' + (mode === "forever" ? "" : " hidden") + ">" +
        '<div class="field-row">' +
          '<div class="field"><label for="dr-f-plan">PLAN</label><select id="dr-f-plan">' +
            planOptions(a.plan || "storefront") + "</select></div>" +
          '<div class="field"><label for="dr-f-cycle">RECORDED CYCLE</label><select id="dr-f-cycle">' +
            cycleOptions(a.billing_cycle) + "</select></div>" +
        "</div>" +
        '<div class="field"><label for="dr-f-reason">WHY THEY GET IT</label>' +
          '<input id="dr-f-reason" type="text" placeholder="Partner, first customer, staff…" value="' +
          esc(a.comped_reason || "") + '"></div>' +
        '<p class="field-hint">' +
          (paddle
            ? "Cancels the Paddle subscription today, so the card is never charged " +
              "again. "
            : "") +
          "No renewal date is written at all, so nothing on the site can ever " +
          "roll this account over or cancel it. It has the full plan and it " +
          "stays out of the revenue figure on the overview." +
        "</p>" +
      "</div>" +

      /* ---- no plan ---- */
      '<div class="mode-body" data-for="none"' + (mode === "none" ? "" : " hidden") + ">" +
        (canRunOut(a)
          ? '<div class="field"><label for="dr-n-when">WHEN</label><select id="dr-n-when">' +
              '<option value="end">let it run to ' + esc(fmtDate(a.current_period_end)) + ', cancel then</option>' +
              '<option value="now">end it today</option>' +
            "</select></div>"
          : '<p class="field-hint" style="margin:0">' +
              "There is no period left to run out, so this ends the plan today." +
            "</p>") +
      "</div>" +

      '<p class="preview" id="dr-preview"></p>' +
      '<div class="plan-actions">' +
        '<button class="btn btn-sm" id="dr-apply">Apply</button>' +
        '<span class="panel-note" id="dr-plan-msg"></span>' +
      "</div>" +

      "<h4>Discount</h4>" +
      '<div class="field-row">' +
        '<div class="field"><label for="dr-disc">PERCENT OFF</label>' +
          '<input id="dr-disc" type="number" min="0" max="100" step="1" value="' +
          (a.discount_percent == null ? "" : esc(a.discount_percent)) + '"></div>' +
        '<div class="field"><label for="dr-disc-note">WHAT WAS AGREED</label>' +
          '<input id="dr-disc-note" type="text" value="' + esc(a.discount_note || "") + '"></div>' +
      "</div>" +
      // What Paddle actually takes off, which is not always what was agreed
      // here: a promo code from checkout shows up only on this line.
      (paddle
        ? '<p class="state-now" style="margin-bottom:10px">' + (function () {
            var d = paddleDiscount(a);
            if (!d) return "Paddle takes nothing off this subscription's charges.";
            var from = d.starts_at && new Date(d.starts_at) > new Date() ? ", from " + fmtDate(d.starts_at) : "";
            var until = d.ends_at ? ", until " + fmtDate(d.ends_at) : "";
            return esc("Paddle takes " + discountSize(d) + " off every charge" + from + until + " — " +
                   (d.code ? "promo code " + d.code + " from checkout." :
                    d.source === "portal" ? "the discount agreed here." : "a discount set in Paddle."));
          })() + "</p>"
        : "") +
      '<p class="field-hint">' +
        (a.comped
          ? "This account is free forever, so a percentage off changes nothing. " +
            "It already bills zero and is already out of the revenue figure."
          : paddle
            ? "Saved into Paddle: every charge from the next one on is this much " +
              "lower, until you clear it. It takes the place of a promo code the " +
              "customer used at checkout."
            : "Recorded now, and put on the Paddle subscription the moment the " +
              "customer checks out, unless they use a promo code there.") +
      "</p>" +

      "<h4>Internal note</h4>" +
      '<div class="field"><textarea id="dr-notes" placeholder="Only ever seen here.">' +
        esc(a.admin_notes || "") + "</textarea></div>" +

      // Every billing column, raw and read only. Paddle writes them for a paying
      // account and the choices above write them for the rest, so nothing here
      // is typed by hand - it is for reading an odd state, and for finding the
      // account in the Paddle dashboard.
      "<details class=\"adv\"" + (state.advOpen ? " open" : "") + ">" +
        "<summary>Advanced — every billing field, read only</summary>" +
        '<div class="readout">' +
        [
          ["Plan", planLabel(a.plan) + (a.billing_cycle ? " · " + a.billing_cycle : "")],
          ["Status", a.subscription_status ? (STATUS_LABEL[a.subscription_status] || a.subscription_status) : "none"],
          ["Trial started", fmtDateTime(a.trial_started_at)],
          ["Trial ends", fmtDateTime(a.trial_ends_at)],
          ["Next charge", fmtDateTime(a.current_period_end)],
          ["At the end of the period", a.cancel_at_period_end ? "cancel" : "renew as normal"],
          ["Scheduled switch", a.pending_plan
            ? planLabel(a.pending_plan) + " · " + (a.pending_billing_cycle || a.billing_cycle || "monthly") : "—"],
          ["Free forever", a.comped ? "yes" + (a.comped_reason ? " — " + a.comped_reason : "") : "no"],
          ["Paddle subscription", a.paddle_subscription_id || "—"],
          ["Paddle customer", a.paddle_customer_id || "—"],
          ["Paddle period started", fmtDateTime(a.paddle_period_start)],
          ["Last Paddle update", fmtDateTime(a.paddle_updated_at)]
        ].map(function (p) {
          return '<div><span class="k">' + esc(p[0]) + '</span><span class="v">' +
                 esc(p[1] || "—") + "</span></div>";
        }).join("") +
        "</div>" +
      "</details>" +

      "<h4>The business brief — read only</h4>" +
      '<div class="readout">' +
        brief.map(function (p) {
          return '<div><span class="k">' + esc(p[0]) + '</span><span class="v">' +
                 esc(p[1] || "—") + "</span></div>";
        }).join("") +
      "</div>" +

      "<h4>Billing history</h4>" +
      (history.length
        ? '<div class="readout">' + history.map(function (h) {
            // Paddle invoices carry what was actually charged, VAT and promo
            // codes included; entries from before Paddle only name the plan.
            var paid = typeof h.amount === "number"
              ? " · " + money(h.amount, h.currency) + (h.transaction_id ? " · " + h.transaction_id : "")
              : "";
            return '<div><span class="k">' + esc(fmtDate(h.period_start)) + '</span><span class="v">' +
                   esc(planLabel(h.plan)) + " · " + esc(h.cycle) + esc(paid) + "</span></div>";
          }).join("") + "</div>"
        : '<p class="panel-note">Nothing has been charged yet.</p>') +

      "<h4>Changes to this account</h4>" +
      (function () {
        var mine = state.audit.filter(function (l) { return l.target_user === a.id; });
        return mine.length
          ? '<div class="log">' + mine.slice(0, 12).map(logRow).join("") + "</div>"
          : '<p class="panel-note">Nothing has been changed from the portal yet.</p>';
      })() +

      '<div class="drawer-actions">' +
        '<button class="btn" id="dr-save">Save changes</button>' +
        '<span class="field-hint">Discount and internal note.</span>' +
        '<button class="btn-ghost btn-sm" id="dr-cancel-btn">Close</button>' +
        '<span class="spacer"></span>' +
        '<span class="panel-note" id="dr-msg"></span>' +
      "</div>";

    $("drawer").hidden = false;
    $("scrim").hidden = false;
    setMenu(false);
    // The table must not scroll behind it. On iOS that takes the root element
    // too, not only the body.
    document.documentElement.classList.add("locked");
    wireDrawer(a);

    // Put back whatever the last write said, now that the element it was
    // written into has been replaced.
    if (state.flash && $(state.flash.el)) {
      $(state.flash.el).textContent = state.flash.text;
      $(state.flash.el).style.color = state.flash.bad ? "var(--bad)" : "var(--ok)";
    }

    renderAccounts();
  }

  function planOptions(selected) {
    return ["counter", "storefront", "franchise", "free"].map(function (p) {
      return '<option value="' + p + '"' + (selected === p ? " selected" : "") +
             ">" + PLAN_LABEL[p] + "</option>";
    }).join("");
  }

  function closeDrawer() {
    state.open = null;
    state.mode = null;
    state.flash = null;
    $("drawer").hidden = true;
    $("scrim").hidden = true;
    $("drawer").innerHTML = "";
    document.documentElement.classList.remove("locked");
    renderAccounts();
  }

  $("scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (state.open) closeDrawer();
    else setMenu(false);
  });

  function drawerMsg(text, bad) {
    say("dr-msg", text, bad);
  }

  function planMsg(text, bad) {
    say("dr-plan-msg", text, bad);
  }

  // A write is followed by a reload, and the reload rebuilds the drawer from
  // scratch - so the word "Done." has to be remembered, not just printed.
  function say(elId, text, bad) {
    state.flash = { el: elId, text: text, bad: !!bad };
    var el = $(elId);
    if (!el) return;
    el.textContent = text;
    el.style.color = bad ? "var(--bad)" : "var(--ok)";
  }

  function wireDrawer(a) {
    $("dr-close").addEventListener("click", closeDrawer);
    $("dr-cancel-btn").addEventListener("click", closeDrawer);

    var adv = $("drawer").querySelector("details.adv");
    adv.addEventListener("toggle", function () { state.advOpen = adv.open; });

    // ---------------------------------------------------- the plan editor

    function mode() { return state.mode || currentMode(a); }

    function showMode(id) {
      state.mode = id;
      Array.prototype.forEach.call($("dr-modes").children, function (b) {
        b.classList.toggle("is-on", b.dataset.mode === id);
      });
      Array.prototype.forEach.call($("drawer").querySelectorAll(".mode-body"), function (d) {
        d.hidden = d.dataset.for !== id;
      });
      preview();
    }

    // The one sentence under the editor: what pressing Apply will leave behind.
    // It is written from the inputs as they stand, so it moves as they do.
    var paddle = viaPaddle(a);
    var paddleTrial = paddle && a.subscription_status === "trialing";

    // Was a plan picked other than the one Paddle is billing? It is billed
    // from the next charge on, so the sentence has to say so.
    function switchNote(plan, cycle) {
      if (plan === a.plan && cycle === a.billing_cycle) return "";
      return " Switches to " + planLabel(plan) + " · " + cycle + " at the next charge.";
    }

    function paddlePreview(m) {
      if (m === "trial") {
        if (!paddleTrial) return "This account already pays, so it can't go back on a trial.";
        var days = Number($("dr-t-days").value);
        if (!(days >= 1)) return "Pick how many days the trial runs.";
        var ends = new Date(Date.now() + days * 86400000).toISOString();
        return "The trial runs until " + fmtDate(ends) + " (in " + days + "d). Paddle charges " +
               "nothing until then, and on that date charges the card on file." +
               switchNote($("dr-t-plan").value, $("dr-t-cycle").value);
      }
      if (m === "paying") {
        var plan = $("dr-p-plan").value, cycle = $("dr-p-cycle").value;
        if (paddleTrial) {
          return "Ends the trial today and Paddle charges the card for " + planLabel(plan) +
                 " · " + cycle + " right away.";
        }
        var until = fromDateInput($("dr-p-until").value);
        if (!until) return "Pick the date of the next charge.";
        return "Paddle charges the card next on " + fmtDate(until) + " (" + relDays(until) + ")." +
               switchNote(plan, cycle);
      }
      if (m === "forever") {
        return "Cancels the Paddle subscription today — the card is never charged again — " +
               "and gives " + planLabel($("dr-f-plan").value) + " for good. Full access, " +
               "no renewal date, €0 in the revenue figure.";
      }
      var atEnd = $("dr-n-when") && $("dr-n-when").value === "end";
      if (atEnd) {
        return "Paddle cancels the subscription on " + fmtDate(a.current_period_end) + " (" +
               relDays(a.current_period_end) + ") and never charges again. Everything stays " +
               "until then — the same thing a customer cancelling gets.";
      }
      return "Paddle cancels the subscription today and never charges again. They keep " +
             "the account and drop to the free monthly allowance straight away.";
    }

    function previewText() {
      var m = mode();

      if (paddle) return paddlePreview(m);

      if (m === "trial" || m === "paying") {
        return "Nothing to apply here — this one starts when the customer checks out.";
      }

      if (m === "forever") {
        return planLabel($("dr-f-plan").value) + ", free forever. Full access, no " +
               "renewal date, nothing to cancel, and €0 in the revenue figure. " +
               "The customer's own billing page shows it as active with no charge due.";
      }

      var atEnd = $("dr-n-when") && $("dr-n-when").value === "end";
      if (atEnd) {
        return "Keeps everything until " + fmtDate(a.current_period_end) + " (" +
               relDays(a.current_period_end) + "), then becomes canceled by itself — " +
               "the same thing a customer cancelling gets.";
      }
      return "Ends the plan today. They keep the account and drop to the free " +
             "monthly allowance straight away.";
    }

    function preview() {
      $("dr-preview").textContent = previewText();
    }

    Array.prototype.forEach.call($("dr-modes").children, function (b) {
      b.addEventListener("click", function () { showMode(b.dataset.mode); });
    });

    // Every control inside the editor re-writes the sentence.
    Array.prototype.forEach.call(
      $("drawer").querySelectorAll(".mode-body input, .mode-body select"),
      function (el) { el.addEventListener("input", preview); }
    );
    $("dr-disc").addEventListener("input", preview);

    Array.prototype.forEach.call($("drawer").querySelectorAll("[data-add]"), function (b) {
      b.addEventListener("click", function () {
        $("dr-t-days").value = (Number($("dr-t-days").value) || 0) + Number(b.dataset.add);
        preview();
      });
    });

    Array.prototype.forEach.call($("drawer").querySelectorAll("[data-months]"), function (b) {
      b.addEventListener("click", function () {
        $("dr-p-until").value = toDateInput(addMonths(Number(b.dataset.months)));
        preview();
      });
    });

    preview();

    // The same choice, made in Paddle by the site's paddle Edge Function. A
    // date the admin left alone is not sent, so pressing Apply to switch a
    // plan does not also nudge the next charge by the hours a date input drops.
    async function applyViaPaddle(m, args) {
      return callPaddle({
        action: "admin_set_plan",
        user_id: a.id,
        mode: m,
        plan: args.p_plan || null,
        cycle: args.p_cycle || null,
        reason: args.p_reason || null,
        at_period_end: !!args.p_at_period_end,
        days: m === "trial" && args.p_days !== trialDefaultDays(a) ? args.p_days : undefined,
        until: m === "paying" && $("dr-p-until").value !== toDateInput(payingDefaultEnd(a))
          ? args.p_until : undefined
      });
    }

    // The site's paddle Edge Function: null when it worked, otherwise an
    // error carrying what the function (or Paddle, through it) said.
    async function callPaddle(body) {
      var res = await db.functions.invoke("paddle", { body: body });
      if (!res.error) return null;
      var message = "Could not reach the paddle function. Reload to see where the account stands.";
      try {
        var detail = await res.error.context.json();
        if (detail && detail.error) message = detail.error;
      } catch (e) {}
      return { message: message };
    }

    $("dr-apply").addEventListener("click", async function () {
      var btn = $("dr-apply");
      var m = mode();
      var args = { p_user: a.id, p_mode: m };

      if (!paddle && (m === "trial" || m === "paying")) {
        planMsg("That starts at checkout, where Paddle takes the card.", true);
        return;
      }

      if (m === "trial") {
        var days = Number($("dr-t-days").value);
        if (!(days >= 1 && days <= 3650)) { planMsg("A trial runs between 1 and 3650 days.", true); return; }
        args.p_plan = $("dr-t-plan").value;
        args.p_cycle = $("dr-t-cycle").value;
        args.p_days = days;
      } else if (m === "paying") {
        var until = fromDateInput($("dr-p-until").value);
        if (!until) { planMsg("Pick the date of the next charge.", true); return; }
        args.p_plan = $("dr-p-plan").value;
        args.p_cycle = $("dr-p-cycle").value;
        args.p_until = until;
      } else if (m === "forever") {
        args.p_plan = $("dr-f-plan").value;
        args.p_cycle = $("dr-f-cycle").value;
        args.p_reason = $("dr-f-reason").value.trim();
      } else {
        args.p_at_period_end = !!($("dr-n-when") && $("dr-n-when").value === "end");
      }

      if (paddle && m === "trial" && !paddleTrial) {
        planMsg("It already pays through Paddle — use Paying to move the next charge.", true);
        return;
      }

      // Ending a plan takes something away, and on a Paddle account so do
      // charging the card today and cancelling it for good - those ask first.
      var asks = m === "none" || (paddle && (m === "forever" || (m === "paying" && paddleTrial)));
      if (asks && !confirm(previewText() + "\n\nGo ahead?")) return;

      btn.disabled = true;
      var error = paddle ? await applyViaPaddle(m, args) : (await db.rpc("admin_set_plan_state", args)).error;
      btn.disabled = false;

      if (error) { planMsg(error.message, true); return; }
      state.mode = null;                  // the account is what it is again
      planMsg("Done.");
      await loadAll();
    });

    $("dr-save").addEventListener("click", async function () {
      var btn = $("dr-save");
      var patch = {};

      var disc = $("dr-disc").value.trim();
      var discNote = $("dr-disc-note").value.trim();
      var notes = $("dr-notes").value.trim();

      // Only send what actually differs, so the audit log stays readable and
      // an untouched field can never be cleared by accident.
      var discChanged = disc !== (a.discount_percent == null ? "" : String(a.discount_percent)) ||
                        discNote !== (a.discount_note || "");
      var notesChanged = notes !== (a.admin_notes || "");

      if (!discChanged && !notesChanged) { drawerMsg("Nothing changed."); return; }

      btn.disabled = true;
      var error = null;
      // The discount goes through Paddle, so it is what the card is charged.
      if (discChanged) {
        error = await callPaddle({
          action: "admin_set_discount", user_id: a.id,
          percent: disc === "" ? null : Number(disc), note: discNote
        });
      }
      if (!error && notesChanged) {
        error = (await db.rpc("admin_update_account",
          { p_user: a.id, p_patch: { admin_notes: notes } })).error;
      }
      btn.disabled = false;

      if (error) { drawerMsg(error.message, true); return; }
      drawerMsg("Saved.");
      await loadAll();
    });
  }

  // -------------------------------------------------------------- activity

  function logRow(l) {
    var what;
    if (l.action === "update_account") {
      what = Object.keys(l.changes).map(function (k) {
        var c = l.changes[k];
        return "<b>" + esc(k) + "</b>  " + esc(shortVal(c.from)) + "  →  " + esc(shortVal(c.to));
      }).join("\n");
    } else if (l.action === "grant_plan") {
      what = "<b>granted</b>  " + esc(planLabel(l.changes.plan)) + " · " +
             esc(l.changes.cycle) + " · " + esc(l.changes.days) + " days" +
             (l.changes.as_trial ? " (as a trial)" : "");
    } else if (l.action === "set_plan_state") {
      var c = l.changes;
      var said = {
        trial:   "put on a trial",
        paying:  "set to paying",
        forever: "given the plan for good",
        none:    c.at_period_end ? "set to cancel at the end of the period" : "ended today"
      }[c.mode] || c.mode;

      if (c.via === "paddle") said += " in Paddle";

      what = "<b>" + esc(said) + "</b>  " + esc(planLabel(c.plan)) +
             (c.cycle ? " · " + esc(c.cycle) : "") +
             (c.runs_until ? "  →  " + esc(fmtDate(c.runs_until))
                           : (c.mode === "forever" ? "  →  no renewal date, ever" : "")) +
             (c.reason ? "\n" + esc(c.reason) : "");
    } else if (l.action === "set_discount") {
      var dc = l.changes;
      what = "<b>discount</b>  " + esc(dc.from ? dc.from + "%" : "none") + "  →  " +
             esc(dc.to ? dc.to + "%" : "none") + (dc.in_paddle ? "  (in Paddle)" : "") +
             (dc.note ? "\n" + esc(dc.note) : "");
    } else if (l.action === "extend_trial") {
      what = "<b>trial +" + esc(l.changes.days) + " days</b>  →  " + esc(fmtDate(l.changes.new_end));
    } else if (l.action === "set_setting") {
      what = "<b>" + esc(l.changes.key) + "</b>  " + esc(shortVal(l.changes.from)) +
             "  →  " + esc(shortVal(l.changes.to));
    } else {
      what = esc(JSON.stringify(l.changes));
    }

    return '<div class="log-row"><div class="log-top">' +
      '<span class="log-who">' + esc(l.actor_email ? adminName(l.actor_email) : "unknown") + "</span>" +
      '<span class="pill">' + esc(l.action.replace(/_/g, " ")) + "</span>" +
      (l.target_email ? "<span>" + esc(l.target_email) + "</span>" : "") +
      '<span class="log-when">' + esc(fmtDateTime(l.at)) + "</span>" +
      '</div><div class="log-what">' + what + "</div></div>";
  }

  function shortVal(v) {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDate(v);
    return String(v);
  }

  function renderAudit() {
    $("au-log").innerHTML = state.audit.length
      ? state.audit.map(logRow).join("")
      : '<p class="panel-note">Nothing has been changed from the portal yet.</p>';
  }

  // -------------------------------------------------------------- settings

  function renderSettings() {
    $("set-admins").innerHTML = state.admins.map(function (m) {
      return '<div><span class="k">' + esc(m.username || m.label || "admin") + '</span><span class="v">' +
             esc(m.email) + "</span></div>";
    }).join("");
  }

  // What the portal calls an admin: their username, or their email until
  // they have one. The audit log keeps emails, so it is looked up by email.
  function adminName(email) {
    var key = String(email).trim().toLowerCase();
    var m = state.admins.filter(function (x) {
      return String(x.email).trim().toLowerCase() === key;
    })[0];
    return (m && m.username) || email;
  }

  // ------------------------------------------------------------------ tabs

  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
    tab.addEventListener("click", function () {
      var changed = state.view !== tab.dataset.view;
      state.view = tab.dataset.view;
      Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
        t.classList.toggle("is-on", t === tab);
        if (t === tab) t.setAttribute("aria-current", "page");
        else t.removeAttribute("aria-current");
      });
      ["overview", "accounts", "audit", "settings"].forEach(function (v) {
        $("view-" + v).hidden = v !== state.view;
      });
      setMenu(false);
      // A new tab starts at its top, not wherever the last one was scrolled to
      // - on a phone that can be a whole screen below its heading.
      if (changed) window.scrollTo(0, 0);
      if (state.view === "overview" && signupRows.length) renderSignups(signupRows);
    });
  });

  // ------------------------------------------------------ the phone's menu
  //
  // Under 860px the email, Refresh and Sign out fold behind one button, the
  // same way the nav on adronis.app folds. Above it the button is not shown
  // and the menu is the plain row it always was.

  function setMenu(open) {
    $("top-right").classList.toggle("open", open);
    $("burger").setAttribute("aria-expanded", open ? "true" : "false");
    $("burger").textContent = open ? "✕" : "≡";
  }

  $("burger").addEventListener("click", function () {
    setMenu(!$("top-right").classList.contains("open"));
  });

  // Refresh leaves the menu open, so "Loading…" is seen turning back into
  // "Refresh". A tap anywhere outside the menu only closes it: it must not
  // also land on the account row that happened to be under the finger.
  $("logout").addEventListener("click", function () { setMenu(false); });
  document.addEventListener("click", function (e) {
    if (!$("top-right").classList.contains("open")) return;
    if ($("top-right").contains(e.target) || $("burger").contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu(false);
  }, true);
  window.addEventListener("resize", function () {
    if (window.innerWidth > 860) setMenu(false);
  });

  boot();
})();
