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
  // Beta has no price: it is only ever given from here, never sold.
  var PRICE = { counter: 59, storefront: 149, franchise: 490, free: 0, beta: 0 };
  var ANNUAL_DISCOUNT = 0.2;

  var PLAN_LABEL = {
    counter: "Counter", storefront: "Storefront",
    franchise: "Franchise", free: "Free", beta: "Beta"
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
    leads: [],            // the inbox: contact_requests and messages together
    creatives: [],        // the Ads tab: every ad of the last half year
    drops: [],
    accountById: {},
    adsView: "queue",     // To post, Posted or Weekly numbers
    adDrafts: {},         // a post link or time typed into a card, kept across re-renders
    week: null,           // the Monday the weekly numbers are showing
    sample: null,         // the Ads tab's made-up sample, while it's on (buildSample)
    view: "overview",
    sort: { key: "created_at", dir: -1 },
    open: null,           // the account id whose drawer is showing
    mode: null,           // the plan state picked in the drawer, once touched
    advOpen: false,       // the drawer's Advanced block, kept open across reloads
    flash: null,          // the last thing a write said, carried over a reload
    lastSeen: 0           // when somebody last touched the page
  };

  // The five states an account can be put into. Everything the portal writes
  // to the commercial side of an account is one of these - the raw fields are
  // still there under Advanced, but nothing routine needs them. Beta is the
  // Beta plan of a business picked for the beta: given for good like Free
  // forever, but on a plan of its own that has no price and isn't sold.
  var MODES = [
    { id: "trial",   label: "Trial" },
    { id: "paying",  label: "Paying" },
    { id: "beta",    label: "Beta" },
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
    if (a.comped && a.plan === "beta") return "beta";
    if (a.comped) return "forever";
    if (a.subscription_status === "trialing") return "trial";
    if (a.subscription_status === "active") return "paying";
    return "none";
  }

  // One plain sentence for the top of the plan editor. It says what the
  // account is, not which columns hold it.
  function stateLine(a) {
    var p = planLabel(a.plan);

    if (a.comped && a.plan === "beta") {
      return "Beta — a beta tester" +
             (a.comped_reason && a.comped_reason !== "Beta tester" ? " · " + a.comped_reason : "") +
             ". Nothing to pay and no renewal date. At launch, set No plan and " +
             "send them to checkout with the founder code.";
    }
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

    // Half a year of ads is plenty for the Ads tab: what's waiting to be
    // posted is never older than that, and the weekly numbers look back by week.
    var since = new Date(Date.now() - 183 * 86400000).toISOString();

    var r = await Promise.all([
      db.from("profiles").select("*").order("created_at", { ascending: false }),
      db.rpc("admin_stats"),
      db.from("admin_audit").select("*").order("at", { ascending: false }).limit(200),
      db.from("portal_admins").select("*").order("added_at"),
      db.from("contact_requests").select("*").order("created_at", { ascending: false }).limit(500),
      db.from("messages").select("*").order("created_at", { ascending: false }).limit(500),
      db.from("creatives").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(5000),
      db.from("drops").select("id, user_id, week_starting, status").gte("created_at", since).limit(2000)
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
    state.accountById = {};
    state.accounts.forEach(function (a) { state.accountById[a.id] = a; });

    // An admin's own test ads stay out of the Ads tab the same way.
    state.creatives = (r[6].data || []).filter(function (c) { return state.accountById[c.user_id]; });
    state.drops = r[7].data || [];

    state.leads = (r[4].data || []).map(function (l) { l.table = "contact_requests"; return l; })
      .concat((r[5].data || []).map(function (l) { l.table = "messages"; return l; }))
      .sort(function (x, y) { return new Date(y.created_at) - new Date(x.created_at); });

    renderOverview();
    renderAccounts();
    renderInbox();
    renderAds();
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
      { k: "Inbox", v: s.open_leads || 0, sub: "new, not answered yet" },
      // A beta tester is comped too, so it is taken out of Free forever.
      { k: "Beta testers", v: s.beta || 0, sub: "on the Beta plan, nothing to pay" },
      { k: "Free forever", v: (s.comped || 0) - (s.beta || 0), sub: "given the plan, never charged" },
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
      if (fl === "applied" && (!a.beta_applied_at || betaOn(a))) return false;
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
      else if (a.beta_applied_at && !a.subscription_status) flags += '<span class="cell-sub">applied for the beta ' + esc(relDays(a.beta_applied_at)) + "</span>";
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
            ? '<span class="pill pill-comped">' + (a.plan === "beta" ? "beta" : "free forever") + "</span>"
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

  // One listener for every table in the app — overview mini tables included —
  // and for the inbox's "Open account" buttons.
  document.addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-open], button[data-open]");
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

      /* ---- beta ---- */
      // Only for an account Paddle isn't billing: a beta tester never pays.
      '<div class="mode-body" data-for="beta"' + (mode === "beta" ? "" : " hidden") + ">" +
        (paddle
          ? '<p class="field-hint">This account pays through Paddle. A beta tester ' +
              "never pays, so set <b>No plan</b> first, then Beta.</p>"
          : '<div class="field"><label for="dr-b-reason">NOTE</label>' +
              '<input id="dr-b-reason" type="text" placeholder="Beta tester" value="' +
              esc(a.plan === "beta" && a.comped_reason !== "Beta tester" ? a.comped_reason || "" : "") + '"></div>' +
            '<p class="field-hint">The Beta plan has no price and is never sold — this ' +
              "is the only place it is given. It includes what the beta plan promises: " +
              "4 ads every Monday in two versions each, every image checked before the " +
              "owner sees it, the approved ads posted for them, holiday drops, reels from " +
              "approved ads once they're built, up to 4 channels, and 30% off a monthly " +
              "plan for the first 12 months after the beta (FOUNDER30). No renewal date, " +
              "so nothing charges or ends it until you set No plan at launch.</p>") +
      "</div>" +

      /* ---- free forever ---- */
      '<div class="mode-body" data-for="forever"' + (mode === "forever" ? "" : " hidden") + ">" +
        '<div class="field-row">' +
          '<div class="field"><label for="dr-f-plan">PLAN</label><select id="dr-f-plan">' +
            planOptions(a.plan && a.plan !== "beta" ? a.plan : "storefront") + "</select></div>" +
          '<div class="field"><label for="dr-f-cycle">RECORDED CYCLE</label><select id="dr-f-cycle">' +
            cycleOptions(a.billing_cycle) + "</select></div>" +
        "</div>" +
        '<div class="field"><label for="dr-f-reason">WHY THEY GET IT</label>' +
          '<input id="dr-f-reason" type="text" placeholder="Partner, first customer, staff…" value="' +
          esc(a.plan === "beta" ? "" : a.comped_reason || "") + '"></div>' +
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
      if (m === "beta") {
        return "A beta tester never pays — set No plan first, then Beta.";
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

      if (m === "beta") {
        return "Beta plan, nothing to pay. They can use Adronis straight away, with no " +
               "renewal date, €0 in the revenue figure, and the beta perks on their own " +
               "billing page.";
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
      } else if (m === "beta") {
        if (paddle) { planMsg("It pays through Paddle — set No plan first, then Beta.", true); return; }
        args.p_reason = $("dr-b-reason").value.trim();
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

  // ----------------------------------------------------------------- inbox
  //
  // Everything the site's public forms collect, newest first: beta
  // applications and contact requests (contact_requests), the Message us form
  // and beta testers' Feedback button (messages). Each row's status is moved
  // by admin_set_lead_status, which writes the audit log. The site emails a
  // notification for every new row (the site's supabase/notify.sql).

  // Where a business signs up during the beta. Signing up is applying, so a
  // beta application normally comes with its account already made; this is
  // for one sent before that (the old application form, or by email).
  // The live address until adronis.app is bought - then swap both, together
  // with the site's canonical links.
  var INVITE_URL = "https://adronis.vercel.app/signup.html";
  var LOGIN_URL = "https://adronis.vercel.app/login.html";

  var LEAD_STATUS_LABEL = { "new": "New", contacted: "Contacted", closed: "Done" };
  var LEAD_TABLE_LABEL = { contact_requests: "contact request", messages: "message" };
  var LEAD_KIND_LABEL = {
    beta: "Beta application", feedback: "Beta feedback",
    contact: "Contact request", message: "Message"
  };

  function leadKind(l) {
    if (l.table === "contact_requests") return l.plan_interest === "beta" ? "beta" : "contact";
    return /^Beta feedback/.test(l.message || "") ? "feedback" : "message";
  }

  function accountByEmail(email) {
    var key = String(email || "").trim().toLowerCase();
    return state.accounts.filter(function (a) {
      return String(a.email || "").trim().toLowerCase() === key;
    })[0] || null;
  }

  // A Gmail compose window in a new tab, already addressed. Not a mailto:
  // link - on a computer with no mail app set up, mailto: does nothing.
  // Both admins write from Gmail; it opens in the Gmail account the browser
  // is signed in to first.
  function compose(to, subject, body) {
    return "https://mail.google.com/mail/?view=cm&fs=1" +
      "&to=" + encodeURIComponent(to) +
      "&su=" + encodeURIComponent(subject) +
      (body ? "&body=" + encodeURIComponent(body) : "");
  }

  function inviteMail(l) {
    var hi = l.full_name ? "Zdravo " + l.full_name.split(" ")[0] + "," : "Zdravo,";
    return compose(l.email, "Tvoje mesto u Adronis beti",
      hi + "\n\n" +
      "hvala na prijavi za Adronis betu — " + (l.business_name || "tvoj biznis") + " je među izabranima.\n\n" +
      "Nalog otvaraš preko ovog linka:\n" + INVITE_URL + "\n\n" +
      "Kad popuniš kratak opis biznisa, uključujemo ti Beta plan i prvi oglasi stižu u ponedeljak.\n\n" +
      "Pozdrav,\nAdronis");
  }

  // For an applicant whose Beta plan was just switched on (Accounts -> Beta).
  function welcomeMail(l, acct) {
    return compose(l.email, "Primljen si u Adronis betu",
      "Zdravo,\n\n" +
      (acct.business_name || l.business_name || "Tvoj biznis") + " je primljen u Adronis betu — Beta plan ti je " +
      "uključen, besplatno do lansiranja.\n\n" +
      "Prijavi se ovde:\n" + LOGIN_URL + "\n\n" +
      "Prvi oglasi stižu u ponedeljak u Approvals, gde svaki odobriš ili odbiješ jednim potezom. " +
      "Ako ti nešto ne radi ili imaš ideju, dugme \"Utisak\" dole levo u aplikaciji stiže direktno do nas.\n\n" +
      "Pozdrav,\nAdronis");
  }

  function betaOn(a) {
    return !!a && a.comped && a.plan === "beta" && a.subscription_status === "active";
  }

  function inboxFiltered() {
    var q = $("in-search").value.trim().toLowerCase();
    var kind = $("in-kind").value;
    var st = $("in-status").value;
    return state.leads.filter(function (l) {
      if (kind && leadKind(l) !== kind) return false;
      if (st === "open" && l.status === "closed") return false;
      if (st && st !== "open" && l.status !== st) return false;
      if (q) {
        var hay = [l.full_name, l.business_name, l.email, l.message].join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function renderInbox() {
    var fresh = state.leads.filter(function (l) { return l.status === "new"; }).length;
    $("in-badge").textContent = fresh;
    $("in-badge").hidden = !fresh;

    var rows = inboxFiltered();
    $("in-count").textContent = rows.length + " of " + state.leads.length;
    $("in-empty").hidden = rows.length > 0;

    $("in-list").innerHTML = rows.map(function (l) {
      var kind = leadKind(l);
      var acct = accountByEmail(l.email);
      var who = l.business_name || l.full_name || l.email;
      var sub = [l.business_name && l.full_name ? l.full_name : "", l.email].filter(Boolean).join(" · ");
      // The site writes what kind of row it is as the first line; the pill says it already.
      var text = kind === "feedback" ? (l.message || "").replace(/^Beta feedback · /, "From: ")
               : kind === "beta" ? (l.message || "").replace(/^Beta application\n/, "")
               : l.message;

      return '<div class="lead-row' + (l.status === "new" ? " is-new" : "") + '">' +
        '<div class="lead-top">' +
          '<span class="pill' + (kind === "beta" ? " pill-acc" : kind === "feedback" ? " pill-active" : "") + '">' +
            esc(LEAD_KIND_LABEL[kind]) + "</span>" +
          '<span class="lead-who"><span class="cell-main">' + esc(who) + "</span>" +
            '<span class="cell-sub">' + esc(sub) + "</span></span>" +
          '<span class="log-when">' + esc(fmtDateTime(l.created_at)) + "</span>" +
        "</div>" +
        (text ? '<div class="lead-text">' + esc(text) + "</div>" : "") +
        '<div class="lead-actions">' +
          '<div class="lead-status" role="group" aria-label="Status">' +
            ["new", "contacted", "closed"].map(function (s) {
              return '<button type="button" class="mode' + (l.status === s ? " is-on" : "") +
                '" data-lead="' + esc(l.id) + '" data-table="' + l.table + '" data-status="' + s + '">' +
                esc(LEAD_STATUS_LABEL[s]) + "</button>";
            }).join("") +
          "</div>" +
          '<span class="spacer"></span>' +
          (acct
            ? '<button type="button" class="btn-ghost btn-sm" data-open="' + esc(acct.id) + '">Open account · ' +
                esc(betaOn(acct) ? "Beta on"
                    : acct.subscription_status ? planLabel(acct.plan) + " " + (STATUS_LABEL[acct.subscription_status] || "")
                    : "no plan on") + "</button>"
            : "") +
          (kind === "beta" && betaOn(acct)
            ? '<a class="btn-ghost btn-sm" href="' + esc(welcomeMail(l, acct)) + '" target="_blank" rel="noopener">Email: you\'re in</a>'
            : "") +
          (kind === "beta" && !acct
            ? '<a class="btn-ghost btn-sm" href="' + esc(inviteMail(l)) + '" target="_blank" rel="noopener">Email invite</a>' +
              '<button type="button" class="btn-ghost btn-sm" data-copy-invite>Copy invite link</button>'
            : "") +
          '<a class="btn-ghost btn-sm" href="' + esc(compose(l.email, "Re: Adronis")) + '" target="_blank" rel="noopener">Reply</a>' +
        "</div>" +
      "</div>";
    }).join("");
  }

  ["in-search", "in-kind", "in-status"].forEach(function (id) {
    $(id).addEventListener("input", renderInbox);
  });

  $("in-list").addEventListener("click", async function (e) {
    var copy = e.target.closest("[data-copy-invite]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(INVITE_URL);
        copy.textContent = "Copied";
      } catch (err) {
        window.prompt("Copy the invite link:", INVITE_URL);
      }
      return;
    }

    var b = e.target.closest("[data-lead]");
    if (!b || b.classList.contains("is-on")) return;
    var lead = state.leads.filter(function (l) { return l.id === b.dataset.lead; })[0];
    Array.prototype.forEach.call(b.parentNode.children, function (x) { x.disabled = true; });
    var res = await db.rpc("admin_set_lead_status", {
      p_table: b.dataset.table, p_id: b.dataset.lead, p_status: b.dataset.status
    });
    if (res.error) {
      Array.prototype.forEach.call(b.parentNode.children, function (x) { x.disabled = false; });
      alert(res.error.message);
      return;
    }
    if (lead) lead.status = b.dataset.status;
    renderInbox();
  });

  // ------------------------------------------------------------------- ads
  //
  // Until the channels are connected through their APIs, every approved ad is
  // posted by hand. To post: every approved ad, soonest first, with what the
  // poster needs - the image, the caption, where it goes - and a button that
  // records it as posted (admin_mark_published), which the customer then sees
  // under Already live. Posted: the last 30 days, with Undo for a mark made by
  // mistake. Weekly numbers: one drop week across every account.

  // Posted within this long of its slot still counts as on time.
  var ON_TIME_MS = 30 * 60 * 1000;
  var REASON_LABEL = { image: "The image", tone: "The tone", facts: "Wrong facts", timing: "Timing", other: "Other" };

  // What the tab shows: the real ads, or the made-up sample while it's on.
  function adList() { return state.sample ? state.sample.creatives : state.creatives; }
  function adDrops() { return state.sample ? state.sample.drops : state.drops; }
  function adAccount(id) {
    return (state.sample ? state.sample.accounts[id] : state.accountById[id]) || {};
  }

  // ---- the sample
  //
  // Made-up businesses and ads, so the tab can be seen working before any
  // real ad exists. It lives only in this page: nothing is read from or
  // written to the database, Mark posted and Undo change only the sample,
  // and leaving the sample puts the real ads back.

  var SAMPLE_IMG = "https://adronis.vercel.app/examples/";

  function buildSample() {
    var H = 3600000, now = Date.now();
    var at = function (hours) { return new Date(now + hours * H).toISOString(); };
    var thisWeek = ymd(mondayOf(new Date()));
    var lastWeek = ymd(addDays(mondayOf(new Date()), -7));

    var accounts = {
      s1: { id: "s1", business_name: "Kafeterija Dorćol", email: "kafeterija@primer.rs", website: "@kafeterija.dorcol" },
      s2: { id: "s2", business_name: "Salon Lepota", email: "salon.lepota@primer.rs", website: "salonlepota.rs" },
      s3: { id: "s3", business_name: "Picerija Bella", email: "bella@primer.rs", website: "@picerija.bella" },
      s4: { id: "s4", business_name: "Pekara Zrno", email: "zrno@primer.rs", website: "@pekarazrno" },
      s5: { id: "s5", business_name: "Fit Zona NS", email: "fitzona@primer.rs", website: "fitzona.rs" }
    };
    var drops = [
      { id: "sd1", user_id: "s1", week_starting: thisWeek }, { id: "sd2", user_id: "s2", week_starting: thisWeek },
      { id: "sd3", user_id: "s3", week_starting: thisWeek }, { id: "sd4", user_id: "s4", week_starting: thisWeek },
      { id: "sd5", user_id: "s5", week_starting: thisWeek },
      { id: "sd6", user_id: "s1", week_starting: lastWeek }, { id: "sd7", user_id: "s3", week_starting: lastWeek }
    ];

    var n = 0;
    function ad(o) {
      n++;
      return Object.assign({
        id: "sample-" + n, format: "4:5 post", status: "approved", headline: null, caption: null,
        image_url: null, scheduled_at: null, published_at: null, post_url: null, reject_reason: null,
        edited_at: null, rescheduled_at: null, created_at: at(-40)
      }, o);
    }

    var creatives = [
      // Waiting to be posted
      ad({ drop_id: "sd1", user_id: "s1", channel: "Instagram", scheduled_at: at(-1.5), image_url: SAMPLE_IMG + "cafe.jpg",
           headline: "Jutarnja gužva, rešena.",
           caption: "Kafa za poneti za 90 sekundi, i to prava. Svrati pre posla — Cara Dušana 12, od 7h. ☕ #dorćol #kafa" }),
      ad({ drop_id: "sd4", user_id: "s4", channel: "Instagram", format: "9:16 story", scheduled_at: at(2), image_url: SAMPLE_IMG + "bakery.jpg",
           headline: "Kifle iz peći u 7:30",
           caption: "Svako jutro sveže, dok traju. Zadrži mesto — dođi ranije. 🥐" }),
      ad({ drop_id: "sd2", user_id: "s2", channel: "Facebook", scheduled_at: at(5), image_url: SAMPLE_IMG + "salon.jpg",
           headline: "Keratin tretman ove nedelje −20%",
           caption: "Do subote, uz zakazivanje preko poruke ili na 021 555 123. Mesta su ograničena.",
           edited_at: at(-20), rescheduled_at: at(-19) }),
      ad({ drop_id: "sd3", user_id: "s3", channel: "Instagram", scheduled_at: at(27), image_url: SAMPLE_IMG + "pizza.jpg",
           headline: "Utorak = pica dana",
           caption: "Svaka velika pica 990 din. svakog utorka. Dostava na kućnu adresu do 23h. 🍕" }),
      ad({ drop_id: "sd5", user_id: "s5", channel: "Instagram", scheduled_at: at(52), image_url: SAMPLE_IMG + "fitness.jpg",
           headline: "Prvi trening je besplatan",
           caption: "Bez ugovora, bez obaveze. Dođi, probaj, pa odluči. Novi Sad, Bulevar oslobođenja 40." }),
      ad({ drop_id: "sd3", user_id: "s3", channel: "Google Business", scheduled_at: null, image_url: SAMPLE_IMG + "pizza.jpg",
           headline: "Novo na meniju: pica sa pršutom",
           caption: "Probaj je ovog vikenda." }),

      // Already posted
      ad({ drop_id: "sd1", user_id: "s1", channel: "Instagram", status: "published", scheduled_at: at(-30), published_at: at(-29.8),
           post_url: "https://www.instagram.com/", image_url: SAMPLE_IMG + "cafe.jpg",
           headline: "Ponedeljak bez žurbe", caption: "Kafa i kroasan 350 din. do 10h." }),
      ad({ drop_id: "sd2", user_id: "s2", channel: "Instagram", status: "published", scheduled_at: at(-50), published_at: at(-46),
           image_url: SAMPLE_IMG + "salon.jpg", headline: "Manikir + pedikir paket", caption: "Paket cena do kraja meseca." }),
      ad({ drop_id: "sd4", user_id: "s4", channel: "Facebook", status: "published", scheduled_at: at(-26), published_at: at(-26),
           post_url: "https://www.facebook.com/", image_url: SAMPLE_IMG + "bakery.jpg",
           headline: "Hleb sa kiselim testom", caption: "Petkom i subotom, od 8h." }),
      ad({ drop_id: "sd6", user_id: "s1", channel: "Instagram", status: "published", scheduled_at: at(-190), published_at: at(-189.9),
           image_url: SAMPLE_IMG + "cafe.jpg", headline: "Hladna kafa je stigla", caption: "Cold brew, 280 din.", created_at: at(-200) }),
      ad({ drop_id: "sd7", user_id: "s3", channel: "Instagram", status: "published", scheduled_at: at(-170), published_at: at(-166),
           image_url: SAMPLE_IMG + "pizza.jpg", headline: "Porodična pica", caption: "45 cm, za celu ekipu.", created_at: at(-200) }),

      // Still with the customer, or turned down
      ad({ drop_id: "sd5", user_id: "s5", channel: "Instagram", status: "pending", image_url: SAMPLE_IMG + "fitness.jpg", headline: "Jutarnji termini od 6h" }),
      ad({ drop_id: "sd2", user_id: "s2", channel: "Instagram", status: "pending", image_url: SAMPLE_IMG + "salon.jpg", headline: "Feniranje 1.200 din." }),
      ad({ drop_id: "sd3", user_id: "s3", channel: "Instagram", status: "rejected", reject_reason: "image", headline: "Pica sa četiri sira" }),
      ad({ drop_id: "sd5", user_id: "s5", channel: "Facebook", status: "rejected", reject_reason: "image", headline: "Leto je blizu" }),
      ad({ drop_id: "sd2", user_id: "s2", channel: "Instagram", status: "rejected", reject_reason: "tone", headline: "Budi najlepša verzija sebe" }),
      ad({ drop_id: "sd4", user_id: "s4", channel: "Instagram", status: "rejected", reject_reason: "facts", headline: "Otvoreno nedeljom" }),
      ad({ drop_id: "sd7", user_id: "s3", channel: "Instagram", status: "rejected", reject_reason: "timing", headline: "Novogodišnji meni", created_at: at(-200) })
    ];

    return { accounts: accounts, drops: drops, creatives: creatives };
  }

  function setSample(on) {
    state.sample = on ? buildSample() : null;
    state.adDrafts = {};
    state.week = null;
    renderAds();
    window.scrollTo(0, 0);
  }

  function isHttp(url) {
    return /^https?:\/\//i.test(String(url || ""));
  }

  function overdue(c) {
    return c.status === "approved" && !!c.scheduled_at && new Date(c.scheduled_at) < new Date();
  }

  // "40 min", "3h", "2d".
  function durText(ms) {
    var min = Math.round(Math.abs(ms) / 60000);
    return min < 60 ? min + " min" : min < 2880 ? Math.round(min / 60) + "h" : Math.round(min / 1440) + "d";
  }

  // "in 40 min", "in 3h", "2d late".
  function relTime(iso) {
    var ms = new Date(iso) - new Date();
    return ms >= 0 ? "in " + durText(ms) : durText(ms) + " late";
  }

  function fmtSlot(iso) {
    return new Date(iso).toLocaleString("en-GB", {
      weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
    });
  }

  // The heading an ad waiting to be posted sits under.
  function dayBucket(c) {
    if (!c.scheduled_at) return "No time yet";
    if (overdue(c)) return "Late";
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var days = Math.floor((new Date(c.scheduled_at) - today) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Tomorrow";
    return new Date(c.scheduled_at).toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "short" });
  }

  // How long after its slot a posted ad went out, in ms. No slot: 0.
  function postedAfter(c) {
    if (!c.scheduled_at || !c.published_at) return 0;
    return new Date(c.published_at) - new Date(c.scheduled_at);
  }

  function postedOnTime(c) {
    return postedAfter(c) <= ON_TIME_MS;
  }

  function adSearchHay(c) {
    var a = adAccount(c.user_id);
    return [a.business_name, a.email, c.channel, c.format, c.headline, c.caption].join(" ").toLowerCase();
  }

  // Due within a day, or already late - what the tab's badge counts. Always
  // the real ads, sample or not.
  function dueCount() {
    var soon = Date.now() + 86400000;
    return state.creatives.filter(function (c) {
      return c.status === "approved" && c.scheduled_at && new Date(c.scheduled_at).getTime() < soon;
    }).length;
  }

  function renderAds() {
    var due = dueCount();
    $("pq-badge").textContent = due;
    $("pq-badge").hidden = !due;

    $("pq-sample").hidden = !state.sample;
    $("pq-sample-btn").hidden = !!state.sample;

    Array.prototype.forEach.call(document.querySelectorAll("#pq-modes .mode"), function (b) {
      b.classList.toggle("is-on", b.dataset.pqView === state.adsView);
      b.setAttribute("aria-pressed", b.dataset.pqView === state.adsView ? "true" : "false");
    });
    $("pq-queue").hidden = state.adsView !== "queue";
    $("pq-posted").hidden = state.adsView !== "posted";
    $("pq-week").hidden = state.adsView !== "week";

    renderQueue();
    renderPosted();
    renderWeek();
  }

  function adMedia(c) {
    var a = adAccount(c.user_id);
    return '<div class="pq-media">' + (isHttp(c.image_url)
      ? '<img src="' + esc(c.image_url) + '" alt="' + esc(c.headline || (a.business_name || "") + " ad") + '" loading="lazy">'
      : '<span class="pq-media-none">NO IMAGE</span>') + "</div>";
  }

  function adWho(c) {
    var a = adAccount(c.user_id);
    // Where it goes: the website or Instagram the customer gave in the brief.
    var sub = [a.email, a.website].filter(Boolean).join(" · ");
    return '<div class="pq-top">' +
      '<span class="lead-who"><span class="cell-main">' + esc(a.business_name || "Unnamed business") + "</span>" +
        '<span class="cell-sub">' + esc(sub) + "</span></span>" +
      '<span class="pill pill-acc">' + esc([c.channel, c.format].filter(Boolean).join(" · ") || "no channel") + "</span>" +
    "</div>";
  }

  function adText(c) {
    return (c.headline ? '<div class="pq-headline">' + esc(c.headline) + "</div>" : "") +
      (c.caption ? '<div class="lead-text pq-caption">' + esc(c.caption) + "</div>" : "") +
      (c.edited_at ? '<span class="pq-note">The customer edited this text before approving it.</span>' : "");
  }

  function adTools(c) {
    return '<div class="lead-actions pq-tools">' +
      (c.caption ? '<button type="button" class="btn-ghost btn-sm" data-copy-caption>Copy caption</button>' : "") +
      (c.headline ? '<button type="button" class="btn-ghost btn-sm" data-copy-headline>Copy headline</button>' : "") +
      (isHttp(c.image_url) ? '<button type="button" class="btn-ghost btn-sm" data-download>Download image</button>' : "") +
      (state.sample ? "" : '<button type="button" class="btn-ghost btn-sm" data-open="' + esc(c.user_id) + '">Open account</button>') +
    "</div>";
  }

  function renderQueue() {
    // The channel menu offers only channels that have something waiting.
    var waiting = adList().filter(function (c) { return c.status === "approved"; });
    var channels = waiting.map(function (c) { return c.channel || ""; })
      .filter(function (ch, i, all) { return ch && all.indexOf(ch) === i; }).sort();
    var picked = $("aq-channel").value;
    $("aq-channel").innerHTML = '<option value="">Every channel</option>' + channels.map(function (ch) {
      return '<option value="' + esc(ch) + '"' + (ch === picked ? " selected" : "") + ">" + esc(ch) + "</option>";
    }).join("");

    var q = $("aq-search").value.trim().toLowerCase();
    var ch = $("aq-channel").value;
    var rows = waiting.filter(function (c) {
      if (ch && c.channel !== ch) return false;
      if (q && adSearchHay(c).indexOf(q) === -1) return false;
      return true;
    }).sort(function (x, y) {
      // Soonest first; an ad with no time yet goes last.
      var a = x.scheduled_at ? new Date(x.scheduled_at).getTime() : Infinity;
      var b = y.scheduled_at ? new Date(y.scheduled_at).getTime() : Infinity;
      return a - b;
    });

    var late = waiting.filter(overdue).length;
    $("aq-count").textContent = rows.length + " of " + waiting.length + (late ? " · " + late + " late" : "");
    $("aq-empty").hidden = rows.length > 0;

    var last = null;
    $("aq-list").innerHTML = rows.map(function (c) {
      var bucket = dayBucket(c);
      var head = bucket !== last
        ? '<h3 class="pq-day' + (bucket === "Late" ? " is-late" : "") + '">' + esc(bucket) + "</h3>"
        : "";
      last = bucket;
      var draft = state.adDrafts[c.id] || {};
      var isLate = overdue(c);

      return head +
        '<article class="pq-card' + (isLate ? " is-late" : "") + '" data-item="' + esc(c.id) + '">' +
          adMedia(c) +
          '<div class="pq-body">' +
            adWho(c) +
            '<div class="pq-when">' + (c.scheduled_at
              ? "<b>" + esc(fmtSlot(c.scheduled_at)) + '</b> <span class="pq-rel' + (isLate ? " is-late" : "") + '">' +
                esc(relTime(c.scheduled_at)) + "</span>" +
                (c.rescheduled_at ? '<span class="pq-note">The customer picked this time.</span>' : "")
              : '<span class="pq-rel">No posting time yet — post it when it suits the channel.</span>') +
            "</div>" +
            adText(c) +
          "</div>" +
          adTools(c) +
          '<div class="pq-post">' +
            '<div class="field"><label for="aq-url-' + esc(c.id) + '">LINK TO THE POST · OPTIONAL</label>' +
              '<input id="aq-url-' + esc(c.id) + '" type="url" inputmode="url" data-draft="url" ' +
                'placeholder="https://www.instagram.com/p/…" value="' + esc(draft.url || "") + '"></div>' +
            '<div class="field"><label for="aq-at-' + esc(c.id) + '">POSTED AT · EMPTY = NOW</label>' +
              '<input id="aq-at-' + esc(c.id) + '" type="datetime-local" data-draft="at" value="' + esc(draft.at || "") + '"></div>' +
            '<button type="button" class="btn btn-sm" data-mark>Mark posted</button>' +
          "</div>" +
        "</article>";
    }).join("");
  }

  function renderPosted() {
    var since = Date.now() - 30 * 86400000;
    var all = adList().filter(function (c) {
      return c.status === "published" && c.published_at && new Date(c.published_at).getTime() >= since;
    });
    var q = $("ap-search").value.trim().toLowerCase();
    var rows = all.filter(function (c) { return !q || adSearchHay(c).indexOf(q) !== -1; })
      .sort(function (x, y) { return new Date(y.published_at) - new Date(x.published_at); });

    var onTime = all.filter(postedOnTime).length;
    $("ap-count").textContent = rows.length + " of " + all.length + (all.length ? " · " + onTime + " on time" : "");
    $("ap-empty").hidden = rows.length > 0;

    $("ap-list").innerHTML = rows.map(function (c) {
      var late = !postedOnTime(c);
      var lateTxt = c.scheduled_at ? (late ? durText(postedAfter(c)) + " late" : "on time") : "no time was set";
      return '<article class="pq-card is-posted" data-item="' + esc(c.id) + '">' +
          adMedia(c) +
          '<div class="pq-body">' +
            adWho(c) +
            '<div class="pq-when">Posted <b>' + esc(fmtSlot(c.published_at)) + "</b> " +
              '<span class="pq-rel' + (late ? " is-late" : "") + '">' + esc(lateTxt) + "</span>" +
              (c.scheduled_at ? '<span class="pq-note">Slot was ' + esc(fmtSlot(c.scheduled_at)) + ".</span>" : "") +
            "</div>" +
            adText(c) +
          "</div>" +
          '<div class="lead-actions pq-tools">' +
            (isHttp(c.post_url)
              ? '<a class="btn-ghost btn-sm" href="' + esc(c.post_url) + '" target="_blank" rel="noopener noreferrer">See the post</a>'
              : '<span class="panel-note">No link saved.</span>') +
            (state.sample ? "" : '<button type="button" class="btn-ghost btn-sm" data-open="' + esc(c.user_id) + '">Open account</button>') +
            '<span class="spacer"></span>' +
            '<button type="button" class="btn-ghost btn-sm btn-danger" data-unmark>Undo</button>' +
          "</div>" +
        "</article>";
    }).join("");
  }

  // ---- weekly numbers

  function mondayOf(d) {
    var x = new Date(d);
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }

  function ymd(d) {
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function addDays(d, n) {
    var x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function weekLabel(mon) {
    var sun = addDays(mon, 6);
    var from = mon.toLocaleDateString("en-GB", { day: "numeric", month: mon.getMonth() === sun.getMonth() ? undefined : "short" });
    var to = sun.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    var now = mondayOf(new Date()).getTime();
    var tag = mon.getTime() === now ? " · this week" : mon.getTime() === addDays(new Date(now), -7).getTime() ? " · last week" : "";
    return from + " – " + to + tag;
  }

  // Everything the weekly numbers say, worked out once for the tiles, the
  // table and the copied text alike.
  function weekNumbers(mon) {
    var from = ymd(mon), to = ymd(addDays(mon, 7));
    var dropIds = {};
    adDrops().forEach(function (d) {
      if (d.week_starting >= from && d.week_starting < to) dropIds[d.id] = true;
    });
    var ads = adList().filter(function (c) { return dropIds[c.drop_id]; });

    function count(list) {
      var n = { delivered: list.length, approved: 0, rejected: 0, waiting: 0, posted: 0, onTime: 0, toPost: 0, overdue: 0, edited: 0 };
      list.forEach(function (c) {
        if (c.status === "approved" || c.status === "published") n.approved++;
        if (c.status === "rejected") n.rejected++;
        if (c.status === "pending") n.waiting++;
        if (c.status === "approved") n.toPost++;
        if (overdue(c)) n.overdue++;
        if (c.status === "published") {
          n.posted++;
          if (postedOnTime(c)) n.onTime++;
        }
        if (c.edited_at) n.edited++;
      });
      return n;
    }

    var byAccount = {};
    ads.forEach(function (c) { (byAccount[c.user_id] = byAccount[c.user_id] || []).push(c); });
    var rows = Object.keys(byAccount).map(function (id) {
      var a = adAccount(id);
      return { id: id, name: a.business_name || a.email || "Unnamed business", n: count(byAccount[id]) };
    }).sort(function (x, y) { return x.name.localeCompare(y.name); });

    var reasons = {};
    ads.forEach(function (c) {
      if (c.status === "rejected") {
        var k = c.reject_reason || "none";
        reasons[k] = (reasons[k] || 0) + 1;
      }
    });

    return { total: count(ads), rows: rows, reasons: reasons };
  }

  function pct(part, whole) {
    return whole ? Math.round((part / whole) * 100) + "%" : "—";
  }

  function reasonList(reasons) {
    return Object.keys(reasons).sort(function (a, b) { return reasons[b] - reasons[a]; })
      .map(function (k) { return { label: REASON_LABEL[k] || "No reason given", n: reasons[k] }; });
  }

  function renderWeek() {
    if (!state.week) state.week = mondayOf(new Date());
    var mon = state.week;
    $("wk-range").textContent = weekLabel(mon);
    $("wk-next").disabled = mon.getTime() >= mondayOf(new Date()).getTime();

    var w = weekNumbers(mon);
    var t = w.total;
    var decided = t.approved + t.rejected;
    var top = reasonList(w.reasons)[0];

    $("wk-tiles").innerHTML = [
      { k: "Delivered", v: t.delivered, sub: w.rows.length + " business" + (w.rows.length === 1 ? "" : "es") },
      { k: "Approved", v: t.approved, sub: pct(t.approved, decided) + " of the ones decided" },
      { k: "Rejected", v: t.rejected, sub: top ? "mostly: " + top.label.toLowerCase() : "none this week" },
      { k: "Waiting on customers", v: t.waiting, sub: "not approved or rejected yet" },
      { k: "Posted", v: t.posted, sub: t.toPost ? t.toPost + " still to post" + (t.overdue ? ", " + t.overdue + " late" : "") : "nothing left to post" },
      { k: "On time", v: pct(t.onTime, t.posted), sub: t.onTime + " of " + t.posted + " posted" }
    ].map(function (x) {
      return '<div class="tile"><div class="tile-k">' + esc(x.k) + '</div><div class="tile-v">' + esc(x.v) +
             '</div><div class="tile-sub">' + esc(x.sub) + "</div></div>";
    }).join("");

    var reasons = reasonList(w.reasons);
    $("wk-reasons-panel").hidden = !reasons.length;
    var max = Math.max.apply(null, reasons.map(function (r) { return r.n; }).concat([1]));
    $("wk-reasons").innerHTML = reasons.map(function (r) {
      return '<div class="mix-row"><span class="mix-name">' + esc(r.label) + "</span>" +
             '<span class="mix-track"><span class="mix-fill" style="width:' + ((r.n / max) * 100).toFixed(1) + '%"></span></span>' +
             '<span class="mix-n">' + esc(r.n) + "</span></div>";
    }).join("");

    $("wk-empty").hidden = w.rows.length > 0;
    $("wk-table").hidden = !w.rows.length;
    $("wk-body").innerHTML = w.rows.map(function (r) {
      var n = r.n;
      return (state.sample ? "<tr>" : '<tr data-open="' + esc(r.id) + '">') +
        '<td><span class="cell-main">' + esc(r.name) + "</span></td>" +
        '<td class="num" data-label="Delivered">' + n.delivered + "</td>" +
        '<td class="num" data-label="Approved">' + n.approved +
          (n.edited ? '<span class="cell-sub">' + n.edited + " text edit" + (n.edited === 1 ? "" : "s") + "</span>" : "") + "</td>" +
        '<td class="num" data-label="Rejected">' + n.rejected + "</td>" +
        '<td class="num" data-label="Waiting">' + n.waiting + "</td>" +
        '<td class="num" data-label="Posted">' + n.posted +
          (n.toPost ? '<span class="cell-sub">' + n.toPost + " to post" + (n.overdue ? ", " + n.overdue + " late" : "") + "</span>" : "") + "</td>" +
        '<td class="num" data-label="On time">' + (n.posted ? n.onTime + " of " + n.posted : "—") + "</td>" +
      "</tr>";
    }).join("");
  }

  // The week as plain text, for the weekly message or report.
  function weekText() {
    var w = weekNumbers(state.week);
    var t = w.total;
    var lines = [
      "Adronis — week of " + weekLabel(state.week).replace(/ · .*$/, ""),
      "Delivered " + t.delivered + " ads to " + w.rows.length + " business" + (w.rows.length === 1 ? "" : "es"),
      "Approved " + t.approved + " (" + pct(t.approved, t.approved + t.rejected) + " of the ones decided), rejected " +
        t.rejected + ", still waiting on customers " + t.waiting,
      "Posted " + t.posted + ", " + t.onTime + " of them on time" + (t.toPost ? "; " + t.toPost + " still to post" : "")
    ];
    var reasons = reasonList(w.reasons);
    if (reasons.length) {
      lines.push("Rejected for: " + reasons.map(function (r) { return r.label.toLowerCase() + " " + r.n; }).join(", "));
    }
    if (t.edited) lines.push("Text edited by the customer before approving: " + t.edited);
    if (w.rows.length) {
      lines.push("", "Per business:");
      w.rows.forEach(function (r) {
        var n = r.n;
        lines.push("- " + r.name + ": " + n.delivered + " delivered, " + n.approved + " approved, " + n.rejected +
          " rejected, " + n.waiting + " waiting, " + n.posted + " posted (" + n.onTime + " on time)");
      });
    }
    return lines.join("\n");
  }

  // ---- what the buttons do

  function adById(id) {
    return adList().filter(function (c) { return c.id === id; })[0] || null;
  }

  function replaceAd(row) {
    var swap = function (c) { return c.id === row.id ? row : c; };
    if (state.sample) state.sample.creatives = state.sample.creatives.map(swap);
    else state.creatives = state.creatives.map(swap);
  }

  function flashLabel(btn, text) {
    var was = btn.textContent;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = was; }, 1600);
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      flashLabel(btn, "Copied");
    } catch (e) {
      window.prompt("Copy this:", text);
    }
  }

  function slug(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ad";
  }

  // Saved under a name that says whose it is and where it goes. A host that
  // won't hand the file to this page gets the image opened in a new tab to
  // save from there instead.
  async function downloadImage(c, btn) {
    var a = adAccount(c.user_id);
    var name = [slug(a.business_name), slug(c.channel), (c.scheduled_at || c.created_at || "").slice(0, 10)]
      .filter(Boolean).join("-");
    btn.disabled = true;
    try {
      var res = await fetch(c.image_url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      var blob = await res.blob();
      var ext = ((blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg")).replace(/[^a-z0-9]/g, "");
      var href = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = href;
      link.download = name + "." + ext;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(href); }, 5000);
    } catch (e) {
      window.open(c.image_url, "_blank", "noopener");
    }
    btn.disabled = false;
  }

  // The Activity tab is read once per load; a write here adds a row to it.
  async function refreshAudit() {
    var res = await db.from("admin_audit").select("*").order("at", { ascending: false }).limit(200);
    if (!res.error) {
      state.audit = res.data || [];
      renderAudit();
    }
  }

  async function markPosted(c, card, btn) {
    var draft = state.adDrafts[c.id] || {};
    var at = draft.at ? new Date(draft.at) : null;
    if (at && isNaN(at)) at = null;
    var url = (draft.url || "").trim() || null;
    btn.disabled = true;
    btn.textContent = "Saving…";
    // The sample is marked in the page only - see buildSample().
    var res = state.sample
      ? { data: Object.assign({}, c, { status: "published", published_at: (at || new Date()).toISOString(), post_url: url }) }
      : await db.rpc("admin_mark_published", {
          p_creative: c.id,
          p_published: true,
          p_at: at ? at.toISOString() : null,
          p_url: url
        });
    if (res.error) {
      btn.disabled = false;
      btn.textContent = "Mark posted";
      alert(res.error.message);
      return;
    }
    delete state.adDrafts[c.id];
    replaceAd(res.data);
    renderAds();
    if (!state.sample) refreshAudit();
  }

  async function unmarkPosted(c, btn) {
    var a = adAccount(c.user_id);
    if (!confirm("Move this " + (c.channel || "") + " ad for " + (a.business_name || "this business") +
        " back to To post? Its posted time and link are cleared, and the customer no longer sees it as live.")) return;
    btn.disabled = true;
    var res = state.sample
      ? { data: Object.assign({}, c, { status: "approved", published_at: null, post_url: null }) }
      : await db.rpc("admin_mark_published", { p_creative: c.id, p_published: false });
    if (res.error) {
      btn.disabled = false;
      alert(res.error.message);
      return;
    }
    replaceAd(res.data);
    renderAds();
    if (!state.sample) refreshAudit();
  }

  ["aq-list", "ap-list"].forEach(function (listId) {
    $(listId).addEventListener("click", function (e) {
      var card = e.target.closest("[data-item]");
      var c = card && adById(card.dataset.item);
      if (!c) return;
      var btn;
      if ((btn = e.target.closest("[data-copy-caption]"))) copyText(c.caption || "", btn);
      else if ((btn = e.target.closest("[data-copy-headline]"))) copyText(c.headline || "", btn);
      else if ((btn = e.target.closest("[data-download]"))) downloadImage(c, btn);
      else if ((btn = e.target.closest("[data-mark]"))) markPosted(c, card, btn);
      else if ((btn = e.target.closest("[data-unmark]"))) unmarkPosted(c, btn);
    });
  });

  // A link or time typed into one card survives the list being drawn again
  // (another card marked, a refresh).
  $("aq-list").addEventListener("input", function (e) {
    var field = e.target.closest("[data-draft]");
    var card = e.target.closest("[data-item]");
    if (!field || !card) return;
    var d = state.adDrafts[card.dataset.item] = state.adDrafts[card.dataset.item] || {};
    d[field.dataset.draft] = field.value;
  });

  $("pq-sample-btn").addEventListener("click", function () { setSample(true); });
  $("pq-sample-exit").addEventListener("click", function () { setSample(false); });

  $("pq-modes").addEventListener("click", function (e) {
    var b = e.target.closest("[data-pq-view]");
    if (!b) return;
    state.adsView = b.dataset.pqView;
    renderAds();
  });

  ["aq-search", "aq-channel"].forEach(function (id) { $(id).addEventListener("input", renderQueue); });
  $("ap-search").addEventListener("input", renderPosted);

  $("wk-prev").addEventListener("click", function () {
    state.week = addDays(state.week, -7);
    renderWeek();
  });
  $("wk-next").addEventListener("click", function () {
    state.week = addDays(state.week, 7);
    renderWeek();
  });
  $("wk-copy").addEventListener("click", function () { copyText(weekText(), $("wk-copy")); });

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
        beta:    "made a beta tester",
        forever: "given the plan for good",
        none:    c.at_period_end ? "set to cancel at the end of the period" : "ended today"
      }[c.mode] || c.mode;

      if (c.via === "paddle") said += " in Paddle";

      what = "<b>" + esc(said) + "</b>  " + esc(planLabel(c.plan)) +
             (c.cycle ? " · " + esc(c.cycle) : "") +
             (c.runs_until ? "  →  " + esc(fmtDate(c.runs_until))
                           : (c.mode === "forever" || c.mode === "beta" ? "  →  no renewal date, ever" : "")) +
             (c.reason ? "\n" + esc(c.reason) : "");
    } else if (l.action === "set_discount") {
      var dc = l.changes;
      what = "<b>discount</b>  " + esc(dc.from ? dc.from + "%" : "none") + "  →  " +
             esc(dc.to ? dc.to + "%" : "none") + (dc.in_paddle ? "  (in Paddle)" : "") +
             (dc.note ? "\n" + esc(dc.note) : "");
    } else if (l.action === "extend_trial") {
      what = "<b>trial +" + esc(l.changes.days) + " days</b>  →  " + esc(fmtDate(l.changes.new_end));
    } else if (l.action === "set_lead_status") {
      what = "<b>" + esc(LEAD_TABLE_LABEL[l.changes.table] || l.changes.table) + "</b>  " +
             esc(LEAD_STATUS_LABEL[l.changes.from] || l.changes.from) + "  →  " +
             esc(LEAD_STATUS_LABEL[l.changes.to] || l.changes.to);
    } else if (l.action === "mark_published" || l.action === "unmark_published") {
      var pc = l.changes;
      what = "<b>" + (l.action === "mark_published" ? "marked posted" : "moved back to To post") + "</b>  " +
             esc(pc.channel || "") + (pc.headline ? " · " + esc(pc.headline) : "") +
             (pc.published_at ? "\nposted " + esc(fmtDateTime(pc.published_at)) : "") +
             (pc.scheduled_at ? " · slot " + esc(fmtDateTime(pc.scheduled_at)) : "") +
             (pc.url ? "\n" + esc(pc.url) : "");
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
      ["overview", "accounts", "posting", "inbox", "audit", "settings"].forEach(function (v) {
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
