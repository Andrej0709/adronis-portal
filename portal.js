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
  var PRICE = { counter: 89, storefront: 249, franchise: 690, free: 0 };
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
    trialDays: 7,
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

  function monthlyRate(plan, cycle) {
    var base = PRICE[plan] || 0;
    return cycle === "annual" ? base * (1 - ANNUAL_DISCOUNT) : base;
  }

  // What this account bills per month right now: zero unless it is actually
  // paying, and net of whatever discount was agreed. A comped account is
  // active and has the full plan, but it was given away - it bills nothing.
  function mrr(a) {
    if (a.comped) return 0;
    if (a.subscription_status !== "active") return 0;
    return monthlyRate(a.plan, a.billing_cycle) * (1 - (a.discount_percent || 0) / 100);
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

  // <input type="datetime-local"> wants a local wall-clock string with no zone.
  function toLocalInput(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
           "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function fromLocalInput(v) {
    if (!v) return "";
    var d = new Date(v);
    return isNaN(d) ? "" : d.toISOString();
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
    if (a.subscription_status === "trialing") {
      return p + " — on trial, ends " + fmtDate(a.trial_ends_at) + " (" + relDays(a.trial_ends_at) + ").";
    }
    if (a.subscription_status === "active") {
      if (!a.current_period_end) {
        return p + " — active with no renewal date on it. Nothing will charge " +
               "or cancel it, but it is not marked free forever either.";
      }
      return p + " · " + (a.billing_cycle || "monthly") + " — paying, " +
             (a.cancel_at_period_end ? "cancels " : "renews ") +
             fmtDate(a.current_period_end) + " (" + relDays(a.current_period_end) + ").";
    }
    if (a.subscription_status === "past_due") {
      return p + " — past due. The customer still has access; nothing has charged.";
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
    return state.trialDays || 7;
  }

  // What the next charge box opens on: the date it already has, or a first
  // period starting today.
  function payingDefaultEnd(a) {
    if (a.current_period_end) return a.current_period_end;
    return addMonths(a.billing_cycle === "annual" ? 12 : 1);
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
    $("who").textContent = session.user.email;
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
      db.from("portal_admins").select("*").order("added_at"),
      db.from("app_settings").select("*")
    ]);

    btn.disabled = false;
    btn.textContent = "Refresh";

    state.stats = r[1].data || null;
    state.audit = r[2].data || [];
    state.admins = r[3].data || [];

    // An admin's own Adronis login has a profiles row like anyone else's.
    // It is not a customer, so it stays out of the list — admin_stats leaves
    // it out of the numbers for the same reason.
    var staff = {};
    state.admins.forEach(function (m) { staff[m.user_id] = true; });
    state.accounts = (r[0].data || []).filter(function (a) { return !staff[a.id]; });

    var settings = r[4].data || [];
    settings.forEach(function (s) {
      if (s.key === "trial_days") state.trialDays = Number(s.value);
    });

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
      { k: "In trial", v: s.trialing, sub: euro(s.mrr_if_trials_convert) + " if they all convert" },
      { k: "Accounts", v: s.accounts, sub: s.onboarded + " finished the brief" },
      { k: "Free forever", v: s.comped || 0, sub: "given the plan, never charged" },
      { k: "Cancelling", v: s.cancelling, sub: "at the end of their period" },
      { k: "Past due", v: s.past_due, sub: s.canceled + " canceled" },
      { k: "On a discount", v: s.discounted, sub: "trial is " + s.trial_days + " days" }
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
      if (fl === "discount" && !(a.discount_percent > 0)) return false;
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
    if (key === "discount_percent") return a.discount_percent || 0;
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
        '<td class="num" data-label="Discount">' + (a.discount_percent ? esc(a.discount_percent) + "%" : "—") + "</td>" +
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

      '<div class="modes" id="dr-modes" role="group" aria-label="What this account should be">' +
        MODES.map(function (m) {
          return '<button type="button" class="mode' + (m.id === mode ? " is-on" : "") +
                 '" data-mode="' + m.id + '">' + esc(m.label) + "</button>";
        }).join("") +
      "</div>" +

      /* ---- trial ---- */
      '<div class="mode-body" data-for="trial"' + (mode === "trial" ? "" : " hidden") + ">" +
        '<div class="field-row">' +
          '<div class="field"><label for="dr-t-plan">PLAN</label><select id="dr-t-plan">' +
            planOptions(a.plan || "storefront") + "</select></div>" +
          '<div class="field"><label for="dr-t-cycle">PAYS AFTERWARDS</label><select id="dr-t-cycle">' +
            cycleOptions(a.billing_cycle) + "</select></div>" +
        "</div>" +
        '<div class="field" style="max-width:240px"><label for="dr-t-days">RUNS FOR, FROM TODAY</label>' +
          '<input id="dr-t-days" type="number" min="1" max="3650" value="' + trialDefaultDays(a) + '"></div>' +
        '<div class="quick">' +
          '<button type="button" class="btn-ghost btn-sm" data-add="7">+7 days</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-add="14">+14</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-add="30">+30</button>' +
        "</div>" +
      "</div>" +

      /* ---- paying ---- */
      '<div class="mode-body" data-for="paying"' + (mode === "paying" ? "" : " hidden") + ">" +
        '<div class="field-row">' +
          '<div class="field"><label for="dr-p-plan">PLAN</label><select id="dr-p-plan">' +
            planOptions(a.plan || "storefront") + "</select></div>" +
          '<div class="field"><label for="dr-p-cycle">BILLED</label><select id="dr-p-cycle">' +
            cycleOptions(a.billing_cycle) + "</select></div>" +
        "</div>" +
        '<div class="field" style="max-width:240px"><label for="dr-p-until">NEXT CHARGE</label>' +
          '<input id="dr-p-until" type="date" value="' + toDateInput(payingDefaultEnd(a)) + '"></div>' +
        '<div class="quick">' +
          '<button type="button" class="btn-ghost btn-sm" data-months="1">a month from today</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-months="12">a year from today</button>' +
        "</div>" +
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
      '<p class="field-hint">' +
        (a.comped
          ? "This account is free forever, so a percentage off changes nothing. " +
            "It already bills zero and is already out of the revenue figure."
          : "Nothing charges a card yet, so this figure is the agreement. " +
            "It comes straight off this account's monthly revenue on the overview.") +
      "</p>" +

      "<h4>Internal note</h4>" +
      '<div class="field"><textarea id="dr-notes" placeholder="Only ever seen here.">' +
        esc(a.admin_notes || "") + "</textarea></div>" +

      // Every column the portal may write, raw. Nothing here is needed for
      // normal work - it is for reading an odd state, and for fixing one that
      // no single choice above describes.
      "<details class=\"adv\"" + (state.advOpen ? " open" : "") + ">" +
        "<summary>Advanced — every field on its own</summary>" +
        '<p class="field-hint" style="margin-top:2px;margin-bottom:14px">' +
          "These are saved with <b>Save changes</b> at the bottom, not with " +
          "Apply. Setting them by hand can leave a state the site has no rule " +
          "for — the four choices above always leave a complete one." +
        "</p>" +
        '<div class="field-row">' +
          '<div class="field"><label for="dr-plan">PLAN</label><select id="dr-plan">' +
            '<option value="">— none —</option>' + planOptions(a.plan) + "</select></div>" +
          '<div class="field"><label for="dr-cycle">CYCLE</label><select id="dr-cycle">' +
            '<option value="">— none —</option>' +
            '<option value="monthly"' + (a.billing_cycle === "monthly" ? " selected" : "") + ">monthly</option>" +
            '<option value="annual"' + (a.billing_cycle === "annual" ? " selected" : "") + ">annual</option>" +
          "</select></div>" +
        "</div>" +
        '<div class="field"><label for="dr-status">SUBSCRIPTION STATUS</label><select id="dr-status">' +
          '<option value="">— none —</option>' +
          ["trialing", "active", "past_due", "canceled"].map(function (s) {
            return '<option value="' + s + '"' + (a.subscription_status === s ? " selected" : "") +
                   ">" + STATUS_LABEL[s] + "</option>";
          }).join("") +
        "</select></div>" +
        '<div class="field-row">' +
          '<div class="field"><label for="dr-trial-end">TRIAL ENDS</label>' +
            '<input id="dr-trial-end" type="datetime-local" value="' + toLocalInput(a.trial_ends_at) + '"></div>' +
          '<div class="field"><label for="dr-period-end">NEXT CHARGE</label>' +
            '<input id="dr-period-end" type="datetime-local" value="' + toLocalInput(a.current_period_end) + '"></div>' +
        "</div>" +
        '<div class="field-row">' +
          '<div class="field"><label for="dr-cancel">AT THE END OF THE PERIOD</label><select id="dr-cancel">' +
            '<option value="false"' + (a.cancel_at_period_end ? "" : " selected") + ">renew as normal</option>" +
            '<option value="true"' + (a.cancel_at_period_end ? " selected" : "") + ">cancel</option>" +
          "</select></div>" +
          '<div class="field"><label for="dr-comped">FREE FOREVER</label><select id="dr-comped">' +
            '<option value="false"' + (a.comped ? "" : " selected") + ">no</option>" +
            '<option value="true"' + (a.comped ? " selected" : "") + ">yes</option>" +
          "</select></div>" +
        "</div>" +
        '<div class="field"><label for="dr-comped-reason">WHY IT IS FREE FOREVER</label>' +
          '<input id="dr-comped-reason" type="text" value="' + esc(a.comped_reason || "") + '"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="dr-pending-plan">SCHEDULED PLAN SWITCH</label><select id="dr-pending-plan">' +
            '<option value="">— none —</option>' + planOptions(a.pending_plan) + "</select></div>" +
          '<div class="field"><label for="dr-pending-cycle">SCHEDULED CYCLE</label><select id="dr-pending-cycle">' +
            '<option value="">— none —</option>' +
            '<option value="monthly"' + (a.pending_billing_cycle === "monthly" ? " selected" : "") + ">monthly</option>" +
            '<option value="annual"' + (a.pending_billing_cycle === "annual" ? " selected" : "") + ">annual</option>" +
          "</select></div>" +
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
            return '<div><span class="k">' + esc(fmtDate(h.period_start)) + '</span><span class="v">' +
                   esc(planLabel(h.plan)) + " · " + esc(h.cycle) + "</span></div>";
          }).join("") + "</div>"
        : '<p class="panel-note">No period has closed yet.</p>') +

      "<h4>Changes to this account</h4>" +
      (function () {
        var mine = state.audit.filter(function (l) { return l.target_user === a.id; });
        return mine.length
          ? '<div class="log">' + mine.slice(0, 12).map(logRow).join("") + "</div>"
          : '<p class="panel-note">Nothing has been changed from the portal yet.</p>';
      })() +

      '<div class="drawer-actions">' +
        '<button class="btn" id="dr-save">Save changes</button>' +
        '<span class="field-hint">Discount, note and anything under Advanced.</span>' +
        '<button class="btn-ghost btn-sm" id="dr-cancel-btn">Close</button>' +
        '<span class="spacer"></span>' +
        '<span class="panel-note" id="dr-msg"></span>' +
      "</div>";

    // planOptions() only marks the value it is handed, and both of these carry
    // an extra "none" option in front of it, so set them after the fact.
    $("dr-plan").value = a.plan || "";
    $("dr-pending-plan").value = a.pending_plan || "";

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
    function previewText() {
      var m = mode();
      var off = 1 - (Number($("dr-disc").value) || 0) / 100;

      if (m === "trial") {
        var days = Number($("dr-t-days").value);
        if (!(days >= 1)) return "Pick how many days the trial runs.";
        var ends = new Date(Date.now() + days * 86400000).toISOString();
        return planLabel($("dr-t-plan").value) + " on trial until " + fmtDate(ends) +
               " (in " + days + "d). Nothing is charged. On that date the site " +
               "rolls it into a paying " + $("dr-t-cycle").value + " period by itself.";
      }

      if (m === "paying") {
        var until = fromDateInput($("dr-p-until").value);
        if (!until) return "Pick the date of the next charge.";
        var rate = monthlyRate($("dr-p-plan").value, $("dr-p-cycle").value) * off;
        return planLabel($("dr-p-plan").value) + " · " + $("dr-p-cycle").value +
               ", paying. Next charge " + fmtDate(until) + " (" + relDays(until) + "). " +
               "Counts " + euro(rate) + " a month towards revenue.";
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

    $("dr-apply").addEventListener("click", async function () {
      var btn = $("dr-apply");
      var m = mode();
      var args = { p_user: a.id, p_mode: m };

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

      // Ending a plan is the one choice here that takes something away, so it
      // is the one that asks first.
      if (m === "none" && !confirm(previewText() + "\n\nGo ahead?")) return;

      btn.disabled = true;
      var res = await db.rpc("admin_set_plan_state", args);
      btn.disabled = false;

      if (res.error) { planMsg(res.error.message, true); return; }
      state.mode = null;                  // the account is what it is again
      planMsg("Done.");
      await loadAll();
    });

    $("dr-save").addEventListener("click", async function () {
      var btn = $("dr-save");
      var patch = {};

      // Only send what actually differs, so the audit log stays readable and
      // an untouched field can never be cleared by accident.
      function put(key, value, current) {
        var now = current == null ? "" : String(current);
        if (String(value) !== now) patch[key] = value;
      }

      put("plan", $("dr-plan").value, a.plan);
      put("billing_cycle", $("dr-cycle").value, a.billing_cycle);
      put("subscription_status", $("dr-status").value, a.subscription_status);
      put("trial_ends_at", fromLocalInput($("dr-trial-end").value), a.trial_ends_at);
      put("current_period_end", fromLocalInput($("dr-period-end").value), a.current_period_end);
      put("pending_plan", $("dr-pending-plan").value, a.pending_plan);
      put("pending_billing_cycle", $("dr-pending-cycle").value, a.pending_billing_cycle);
      put("comped_reason", $("dr-comped-reason").value.trim(), a.comped_reason);
      put("discount_percent", $("dr-disc").value.trim(), a.discount_percent);
      put("discount_note", $("dr-disc-note").value.trim(), a.discount_note);
      put("admin_notes", $("dr-notes").value.trim(), a.admin_notes);

      var wantCancel = $("dr-cancel").value === "true";
      if (wantCancel !== !!a.cancel_at_period_end) patch.cancel_at_period_end = wantCancel;

      var wantComped = $("dr-comped").value === "true";
      if (wantComped !== !!a.comped) patch.comped = wantComped;

      // A datetime-local input rounds to the minute, so a value that was only
      // ever written by the database differs from what the input hands back by
      // the seconds it dropped. Drop those no-op edits.
      ["trial_ends_at", "current_period_end"].forEach(function (k) {
        if (patch[k] && a[k] && Math.abs(new Date(patch[k]) - new Date(a[k])) < 60000) {
          delete patch[k];
        }
      });

      if (!Object.keys(patch).length) { drawerMsg("Nothing changed."); return; }

      btn.disabled = true;
      var res = await db.rpc("admin_update_account", { p_user: a.id, p_patch: patch });
      btn.disabled = false;

      if (res.error) { drawerMsg(res.error.message, true); return; }
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

      what = "<b>" + esc(said) + "</b>  " + esc(planLabel(c.plan)) +
             (c.cycle ? " · " + esc(c.cycle) : "") +
             (c.runs_until ? "  →  " + esc(fmtDate(c.runs_until))
                           : (c.mode === "forever" ? "  →  no renewal date, ever" : "")) +
             (c.reason ? "\n" + esc(c.reason) : "");
    } else if (l.action === "extend_trial") {
      what = "<b>trial +" + esc(l.changes.days) + " days</b>  →  " + esc(fmtDate(l.changes.new_end));
    } else if (l.action === "set_setting") {
      what = "<b>" + esc(l.changes.key) + "</b>  " + esc(shortVal(l.changes.from)) +
             "  →  " + esc(shortVal(l.changes.to));
    } else {
      what = esc(JSON.stringify(l.changes));
    }

    return '<div class="log-row"><div class="log-top">' +
      '<span class="log-who">' + esc(l.actor_email || "unknown") + "</span>" +
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
    $("set-trial").value = state.trialDays;
    $("set-admins").innerHTML = state.admins.map(function (m) {
      return '<div><span class="k">' + esc(m.label || "admin") + '</span><span class="v">' +
             esc(m.email) + "</span></div>";
    }).join("");
  }

  $("set-trial-save").addEventListener("click", async function () {
    var btn = $("set-trial-save");
    var note = $("set-note");
    var days = Number($("set-trial").value);

    if (!(days >= 0 && days <= 365)) {
      note.textContent = "Pick a number between 0 and 365.";
      note.className = "notice notice-bad";
      note.hidden = false;
      return;
    }

    btn.disabled = true;
    var res = await db.rpc("admin_set_setting", { p_key: "trial_days", p_value: days });
    btn.disabled = false;

    note.hidden = false;
    if (res.error) {
      note.textContent = res.error.message;
      note.className = "notice notice-bad";
      return;
    }
    note.textContent = "New signups now get a " + days + "-day trial.";
    note.className = "notice notice-ok";
    await loadAll();
  });

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
