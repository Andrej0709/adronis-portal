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
    assets: null,         // brand material uploaded, per account: { logo, photos, menu }
    contacts: {},         // the Beta tab's emails, per account and kind: { at, by }
    betaView: "ready",    // Ready for Monday, Health, Gone quiet, Launch list, Applications, Updates, Local events or Costs
    prospects: [],        // the Sales tab's businesses (null: table not there yet)
    demoEvents: [],       // the public demo's counts, last 30 days (null: same)
    opens: {},            // what each prospect did with its own links, by code (indexOpens)
    updates: [],          // notes to testers' control rooms (null: table not there yet)
    ratings: [],          // customers' stars and words, newest first (null: table not there yet)
    errors: [],           // what broke in visitors' browsers, last 30 days (null: table not there yet)
    costs: [],            // what making ads cost, per account (null: SQL not re-run yet)
    budget: null,         // the beta budget from app_settings: { eur, usd_eur, tester_week_eur }
    seats: null,          // how many beta places there are (app_settings 'beta_seats'); null: no limit
    editing: null,        // the prospect id open in the Sales form, or "new"
    drops: [],
    accountById: {},
    adsView: "queue",     // To post, Posted or Weekly numbers
    adDrafts: {},         // a post link or time typed into a card, kept across re-renders
    week: null,           // the Monday the weekly numbers are showing
    sample: null,         // the Ads tab's made-up sample, while it's on (buildSample)
    view: "today",
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
      db.from("drops").select("id, user_id, week_starting, status").gte("created_at", since).limit(2000),
      db.rpc("admin_brand_asset_counts"),
      db.from("admin_audit").select("target_user, changes, at, actor_email").eq("action", "emailed")
        .order("at", { ascending: false }).limit(1000),
      db.from("prospects").select("*").order("created_at", { ascending: false }).limit(2000),
      db.from("demo_events").select("*")
        .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString()).limit(20000),
      db.from("updates").select("*").order("created_at", { ascending: false }).limit(200),
      db.from("ratings").select("*").order("created_at", { ascending: false }).limit(2000),
      db.from("client_errors").select("*")
        .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString())
        .order("created_at", { ascending: false }).limit(3000),
      db.rpc("admin_generation_costs"),
      db.from("app_settings").select("key, value").in("key", ["beta_budget", "beta_seats"]),
      db.from("local_events").select("*").order("starts_on").limit(500)
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

    // The Beta tab's brand material counts. null until portal-admin.sql has
    // been re-run with admin_brand_asset_counts - the tab says so.
    state.assets = r[8].error ? null : {};
    (r[8].data || []).forEach(function (x) {
      var row = state.assets[x.user_id] = state.assets[x.user_id] || { logo: 0, photos: 0, menu: 0 };
      row[x.kind] = x.n;
    });
    // When each kind of email was last opened for each account, newest first.
    state.contacts = {};
    (r[9].data || []).forEach(function (x) {
      var c = state.contacts[x.target_user] = state.contacts[x.target_user] || {};
      var kind = x.changes && x.changes.kind;
      if (kind && !c[kind]) c[kind] = { at: x.at, by: x.actor_email };
    });

    // The Sales tab. null when its tables aren't there yet (the SQL files
    // haven't been re-run) - the tab says so.
    state.prospects = r[10].error ? null : (r[10].data || []);
    state.demoEvents = r[11].error ? null : (r[11].data || []);
    state.opens = indexOpens(state.demoEvents);
    state.updates = r[12].error ? null : (r[12].data || []);
    state.ratings = r[13].error ? null : (r[13].data || []);
    state.errors = r[14].error ? null : (r[14].data || []);
    state.events = r[17].error ? null : (r[17].data || []);
    // The Beta tab's Costs, added up per account. An admin's own test ads
    // count too - the money was spent all the same.
    state.costs = r[15].error ? null : (r[15].data || []).map(function (x) {
      return {
        user_id: x.user_id, usd: Number(x.usd), usd_7d: Number(x.usd_7d), usd_28d: Number(x.usd_28d),
        claude: Number(x.claude), higgsfield: Number(x.higgsfield), ads: Number(x.ads), last_at: x.last_at
      };
    });
    var settings = {};
    (r[16].data || []).forEach(function (x) { settings[x.key] = x.value; });
    var bud = settings.beta_budget;
    state.budget = bud && Number(bud.eur) >= 0 && Number(bud.usd_eur) > 0
      ? { eur: Number(bud.eur), usd_eur: Number(bud.usd_eur),
          tester_week_eur: Number(bud.tester_week_eur) > 0 ? Number(bud.tester_week_eur) : null } : null;
    // How many beta places there are (null: no limit set).
    state.seats = settings.beta_seats && Number(settings.beta_seats.seats) >= 0
      ? Number(settings.beta_seats.seats) : null;

    state.leads = (r[4].data || []).map(function (l) { l.table = "contact_requests"; return l; })
      .concat((r[5].data || []).map(function (l) { l.table = "messages"; return l; }))
      .sort(function (x, y) { return new Date(y.created_at) - new Date(x.created_at); });

    renderOverview();
    renderFunnel();
    renderOutcomes();
    renderAccounts();
    renderBeta();
    renderSales();
    renderInbox();
    renderAds();
    renderAudit();
    renderSettings();
    renderRatings();
    renderErrors();
    renderToday();
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

  // A page of the site showing this account exactly as its owner sees it,
  // read only (the site's auth.js, ?as=). It opens in the browser's own
  // Adronis session, so sign in there once with your admin login.
  function viewAsUrl(id, page) {
    return SITE_URL + "/" + page + "?as=" + encodeURIComponent(id);
  }

  // The quick "never in my ads" picks (the site's control-room.js, AVOID_TAGS)
  // and the customer's own words.
  var AVOID_TAG_LABEL = {
    no_emoji: "no emojis", no_prices: "no prices", no_discounts: "no sales or discounts",
    no_faces: "no faces", no_alcohol: "no alcohol", no_jokes: "no jokes", no_slang: "no slang",
    no_english: "no English words", no_competitors: "no other businesses", no_urgency: "no pressure lines"
  };
  function avoidText(a) {
    var tags = (a.avoid_tags || []).map(function (k) { return AVOID_TAG_LABEL[k] || k; });
    return [tags.join(", "), a.avoid_notes].filter(Boolean).join(" · ");
  }

  // The days the business told us it's closed (the site's closed-days.js),
  // still to come or going on now.
  function closedRanges(a) {
    var today = ymd(new Date());
    return (Array.isArray(a && a.closed_days) ? a.closed_days : [])
      .filter(function (r) { return r && r.from && r.to && r.to >= today; })
      .sort(function (x, y) { return x.from < y.from ? -1 : 1; });
  }
  function closedText(a) {
    return closedRanges(a).map(function (r) {
      var from = new Date(r.from + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      var to = new Date(r.to + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      return (r.from === r.to ? from : from + " – " + to) + (r.note ? " (" + r.note + ")" : "");
    }).join(", ");
  }
  // The closed stretch a moment falls in, by the calendar day here - the
  // portal and the businesses are on the same clock.
  function closedOn(a, iso) {
    if (!iso) return null;
    var day = ymd(new Date(iso));
    return closedRanges(a).filter(function (r) { return r.from <= day && day <= r.to; })[0] || null;
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
      ["Country", a.country], ["City", a.city], ["Address", a.address], ["Opening hours", a.opening_hours],
      ["Phone", a.phone], ["Business type", a.vertical], ["Website", a.website],
      ["Sells", a.what_you_sell], ["Typical customer", a.typical_customer],
      ["Differentiator", a.differentiator], ["Why us", a.why_us],
      ["Brand vibe", a.brand_vibe], ["Brand colors", a.brand_colors],
      ["Alphabet", a.ad_script === "cyrillic" ? "Cyrillic" : a.ad_script === "latin" ? "Latin" : ""],
      ["Weather", a.weather_ads === false ? "off — ads ignore the forecast" : a.weather_ads ? "ads fit the forecast" : ""],
      ["Avoid", avoidText(a)],
      ["Closed", closedText(a)],
      ["Ad engine", a.engine_paused_at
        ? "paused since " + fmtDate(a.engine_paused_at) + (a.engine_pause_note ? " — " + a.engine_pause_note : "") + " (Beta → Costs)"
        : "running"],
      ["Channels", (a.channels || []).join(", ")],
      ["Auto-approve", a.auto_approve ? "on since " + fmtDate(a.auto_approve_at) + " — ads waiting 48 hours are approved for them" : "off"],
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
      // The site's own pages, as this account sees them - read only. Needs
      // you signed in on the site with your admin login (auth.js: ?as=).
      '<p class="drawer-view"><a class="btn-ghost btn-sm" href="' + esc(viewAsUrl(a.id, "control-room.html")) +
        '" target="_blank" rel="noopener">View as tester: control room ↗</a> ' +
        '<a class="btn-ghost btn-sm" href="' + esc(viewAsUrl(a.id, "approvals.html")) +
        '" target="_blank" rel="noopener">Approvals ↗</a></p>' +

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
  // The live address until adronis.app is bought - then swap it, together
  // with the site's canonical links. Every link in a ready-written email
  // starts here.
  var SITE_URL = "https://adronis.vercel.app";
  var INVITE_URL = SITE_URL + "/signup.html";
  var LOGIN_URL = SITE_URL + "/login.html";

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

  // Ready-made replies for the Inbox's Reply menu, in Serbian like the rest of
  // what we send. Each opens in Gmail with the greeting filled in, to be read
  // over and changed before it goes. Worded so they fit anyone, whoever wrote.
  var REPLIES = [
    { id: "blank", label: "Empty reply", subject: "Re: Adronis", body: function () { return ""; } },
    { id: "thanks", label: "Thanks for the feedback", subject: "Hvala na utisku",
      body: function (l, hi) {
        return hi + "\n\nhvala na poruci — baš ovakvi utisci nam u beti najviše znače. " +
          "Pogledaćemo to ove nedelje i javiti ti šta smo uradili.\n\nPozdrav,\nAdronis";
      } },
    { id: "fixed", label: "It's fixed", subject: "Sređeno",
      body: function (l, hi) {
        return hi + "\n\nproblem iz tvoje poruke je rešen — sada bi trebalo da radi kako treba. " +
          "Ako se ponovi, samo odgovori na ovaj mejl.\n\nHvala na poruci — tako Adronis postaje bolji.\n\nPozdrav,\nAdronis";
      } },
    { id: "photos", label: "Add your logo and photos", subject: "Logo i fotografije za tvoje oglase",
      body: function (l, hi, acct) {
        return hi + "\n\nda bi oglasi za " + ((acct && acct.business_name) || l.business_name || "tvoj lokal") +
          " što više ličili na tebe, u kontrolnoj sobi pod „Snaga profila“ dodaj logo i nekoliko fotografija " +
          "lokala i onoga što prodaješ. Fotografije sa telefona su sasvim u redu.\n\n" +
          SITE_URL + "/control-room.html\n\nPozdrav,\nAdronis";
      } },
    { id: "week", label: "How's the first week?", subject: "Kako ide prva nedelja?",
      body: function (l, hi) {
        return hi + "\n\nprošla je prva nedelja sa Adronisom — kako ti se čine oglasi? Da li liče na tvoj lokal, " +
          "i da li ti je odobravanje jednostavno?\n\nAko bilo šta treba da bude drugačije, samo odgovori na ovaj mejl. " +
          "U beti menjamo stvari baš po onome što nam napišete.\n\nPozdrav,\nAdronis";
      } },
    { id: "full", label: "Beta is full", subject: "Tvoja prijava za Adronis betu",
      body: function (l, hi) {
        return hi + "\n\nhvala na prijavi za Adronis betu. Trenutno su sva mesta popunjena, ali tvoju prijavu čuvamo — " +
          "javićemo ti se čim se otvori mesto, najkasnije pre lansiranja početkom 2027.\n\nPozdrav,\nAdronis";
      } },
    { id: "more", label: "Tell us more", subject: "Još par pitanja o tvom biznisu",
      body: function (l, hi, acct) {
        return hi + "\n\nhvala na prijavi. Pre nego što odlučimo, zanima nas još par stvari o " +
          ((acct && acct.business_name) || l.business_name || "tvom biznisu") + ":\n\n– \n– \n\n" +
          "Dovoljno je da odgovoriš na ovaj mejl.\n\nPozdrav,\nAdronis";
      } }
  ];

  function replyHref(l, id) {
    var r = REPLIES.filter(function (x) { return x.id === id; })[0];
    if (!r) return null;
    var first = l.full_name ? String(l.full_name).trim().split(/\s+/)[0] : "";
    var hi = first ? "Zdravo " + first + "," : "Zdravo,";
    return compose(l.email, r.subject, r.body(l, hi, accountByEmail(l.email)));
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
          '<select class="in-reply" data-reply="' + esc(l.id) + '" aria-label="Reply with a ready-made email">' +
            '<option value="">Reply…</option>' +
            REPLIES.map(function (r) { return '<option value="' + r.id + '">' + esc(r.label) + "</option>"; }).join("") +
          "</select>" +
        "</div>" +
      "</div>";
    }).join("");
  }

  ["in-search", "in-kind", "in-status"].forEach(function (id) {
    $(id).addEventListener("input", renderInbox);
  });

  // Reply…: the picked email opens in Gmail, and the menu goes back to Reply….
  $("in-list").addEventListener("change", function (e) {
    var sel = e.target.closest("select[data-reply]");
    if (!sel || !sel.value) return;
    var lead = state.leads.filter(function (l) { return String(l.id) === sel.dataset.reply; })[0];
    var href = lead && replyHref(lead, sel.value);
    sel.value = "";
    if (href) window.open(href, "_blank", "noopener");
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

  // ------------------------------------------------------------ beta funnel
  //
  // On the Overview: how far the people who sign up get, step by step.

  function renderFunnel() {
    var all = state.accounts;
    var approvedAd = {}, postedAd = {};
    state.creatives.forEach(function (c) {
      if (c.status === "approved" || c.status === "published") approvedAd[c.user_id] = true;
      if (c.status === "published") postedAd[c.user_id] = true;
    });
    var inBeta = all.filter(betaOn);
    var steps = [
      { label: "Signed up", n: all.length },
      { label: "Applied for the beta", n: all.filter(function (a) { return a.beta_applied_at || betaOn(a); }).length },
      { label: "Let in", n: inBeta.length },
      { label: "Approved an ad", n: inBeta.filter(function (a) { return approvedAd[a.id]; }).length },
      { label: "Had an ad posted", n: inBeta.filter(function (a) { return postedAd[a.id]; }).length },
      { label: "Back in the last 7 days", n: inBeta.filter(function (a) {
          var d = daysSince(a.last_seen_at);
          return d !== null && d < 7;
        }).length }
    ];
    var top = Math.max(steps[0].n, 1);
    $("ov-funnel").innerHTML = steps.map(function (s, i) {
      var prev = i ? steps[i - 1].n : null;
      return '<div class="funnel-row"><span class="funnel-name">' + esc(s.label) + "</span>" +
        '<span class="mix-track"><span class="mix-fill" style="width:' + ((s.n / top) * 100).toFixed(1) + '%"></span></span>' +
        '<span class="funnel-n">' + s.n + "</span>" +
        '<span class="funnel-pct">' + (prev === null ? "" : prev ? Math.round((s.n / prev) * 100) + "%" : "—") + "</span></div>";
    }).join("");
  }

  // ------------------------------------------------- did ads bring people in
  //
  // On the Overview: what testers answered in their control room when asked,
  // a couple of days after an ad went out, whether anyone came in or
  // mentioned it (creatives.outcome). The beta's real question.

  var OUTCOMES = [
    { id: "yes", label: "Yes, someone came or mentioned it" },
    { id: "unsure", label: "Can't tell" },
    { id: "no", label: "No" }
  ];

  function renderOutcomes() {
    var live = state.creatives.filter(function (c) { return c.status === "published"; });
    var counts = { yes: 0, unsure: 0, no: 0 };
    live.forEach(function (c) { if (counts[c.outcome] !== undefined) counts[c.outcome]++; });
    var answered = counts.yes + counts.unsure + counts.no;
    var max = Math.max(answered, 1);
    $("ov-outcomes").innerHTML = OUTCOMES.map(function (o) {
      var n = counts[o.id];
      return '<div class="funnel-row"><span class="funnel-name">' + esc(o.label) + "</span>" +
        '<span class="mix-track"><span class="mix-fill" style="width:' + ((n / max) * 100).toFixed(1) + '%"></span></span>' +
        '<span class="funnel-n">' + n + "</span>" +
        '<span class="funnel-pct">' + (answered ? Math.round((n / answered) * 100) + "%" : "—") + "</span></div>";
    }).join("");
    var missing = live.length && !("outcome" in live[0]);
    $("ov-outcomes-note").textContent = missing
      ? "Answers appear once the site's schema.sql has been re-run."
      : answered + " of " + live.length + " posted ads answered. Testers are asked two days after an ad goes out.";
  }

  // ------------------------------------------------------------------ beta
  //
  // The beta testers - accounts with the Beta plan on. Ready for Monday:
  // what each still hasn't given the engine, scored the way their own
  // control room scores it, with a reminder ready to send. Gone quiet: who
  // hasn't been back, or has ads waiting on them for days. Launch list: who
  // is most likely to pay once the beta ends, with the founder offer ready.
  // Every Email button opens the email in Gmail and notes that it did
  // (admin_note_contact), so two admins don't both write.

  // Mirrors EXTRAS in the site's control-room.js - the same weights, so the
  // percentage here is the Profile strength the customer sees.
  var STRENGTH = [
    { key: "differentiator", weight: 15, label: "What makes them different", sr: "po čemu se razlikuješ od drugih" },
    { key: "photos", asset: "photos", weight: 20, label: "Photos", sr: "fotografije lokala i onoga što prodaješ" },
    { key: "next_week_note", weight: 15, label: "Note for next week", sr: "šta se dešava sledeće nedelje (akcija, novitet, radno vreme)" },
    { key: "logo", asset: "logo", weight: 10, label: "Logo", sr: "logo" },
    { key: "opening_hours", weight: 10, label: "Opening hours", sr: "radno vreme" },
    { key: "brand_colors", weight: 5, label: "Brand colors", sr: "boje brenda" },
    { key: "avoid_notes", weight: 5, label: "Anything to avoid", sr: "šta nikad ne sme da se pojavi u oglasima" },
    { key: "website", weight: 5, label: "Website or Instagram", sr: "sajt ili Instagram" },
    { key: "address", weight: 5, label: "Street address", sr: "adresa radnje" },
    { key: "menu", asset: "menu", weight: 5, label: "Menu or price list", sr: "meni ili cenovnik" },
    { key: "channels", weight: 5, label: "Channels", sr: "kanali na koje idu oglasi (na stranici Nalog)" }
  ];
  var NOTE_FRESH_MS = 7 * 86400000;   // the control room's own rule for the weekly note
  var QUIET_DAYS = 5;                 // not back for this long: gone quiet
  var WAITING_HOURS = 48;             // ads waiting on them this long: gone quiet
  // The launch offer. The code lives in Paddle, limited to FOUNDER_USES
  // checkouts; first charges start on the launch day.
  var FOUNDER_CODE = "FOUNDER30";
  var FOUNDER_USES = 8;
  var LAUNCH_DAY_SR = "1. februara";

  function daysSince(iso) {
    return iso ? Math.floor((Date.now() - new Date(iso)) / 86400000) : null;
  }

  function seenText(a) {
    var d = daysSince(a.last_seen_at);
    if (d === null) return "not seen yet";
    if (d === 0) return "seen today";
    if (d === 1) return "seen yesterday";
    return "seen " + d + " days ago";
  }

  function nextMonday() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    return d;
  }

  // "done", "stale" (a weekly note gone out of date), "missing", or
  // "unknown" (a file count the database couldn't give).
  function strengthState(x, a) {
    if (x.asset) {
      if (!state.assets) return "unknown";
      return ((state.assets[a.id] || {})[x.asset] || 0) > 0 ? "done" : "missing";
    }
    // Anything to avoid counts with the quick picks alone, as it does for them.
    var v = x.key === "avoid_notes" ? avoidText(a) : a[x.key];
    if (Array.isArray(v) ? !v.length : !v) return "missing";
    if (x.key === "next_week_note" &&
        (!a.next_week_note_at || Date.now() - new Date(a.next_week_note_at) > NOTE_FRESH_MS)) return "stale";
    return "done";
  }

  function strength(a) {
    var score = 0, gaps = [];
    STRENGTH.forEach(function (x) {
      var st = strengthState(x, a);
      if (st === "done") score += x.weight;
      else if (st !== "unknown") gaps.push({ item: x, state: st });
    });
    return { score: score, gaps: gaps };
  }

  function adsOfAccount(id) {
    return state.creatives.filter(function (c) { return c.user_id === id; });
  }

  function feedbackCount(a) {
    var mail = String(a.email || "").toLowerCase();
    return state.leads.filter(function (l) {
      return l.table === "messages" && /^Beta feedback/.test(l.message || "") &&
        String(l.email || "").toLowerCase() === mail;
    }).length;
  }

  // Why a tester counts as gone quiet, or null when they don't.
  function quietness(a) {
    var waiting = adsOfAccount(a.id).filter(function (c) { return c.status === "pending"; });
    var oldest = waiting.reduce(function (min, c) {
      return !min || new Date(c.created_at) < new Date(min) ? c.created_at : min;
    }, null);
    var waitingMs = oldest ? Date.now() - new Date(oldest) : 0;
    var seen = daysSince(a.last_seen_at);
    var reasons = [];
    if (seen !== null && seen >= QUIET_DAYS) reasons.push("hasn't been back for " + seen + " days");
    if (waitingMs >= WAITING_HOURS * 3600000) {
      reasons.push(waiting.length + " ad" + (waiting.length === 1 ? "" : "s") + " waiting on them for " + durText(waitingMs));
    }
    if (!reasons.length) return null;
    return { reasons: reasons, waiting: waiting.length, rank: Math.max((seen || 0) * 24, waitingMs / 3600000) };
  }

  // How likely a tester is to pay at launch, out of 100, from what they did
  // in the beta: answering their ads, telling us more, coming back, filling
  // in their profile, and having ads actually go out.
  function launchScore(a) {
    var ads = adsOfAccount(a.id);
    // An ad that expired was never answered, so it doesn't count as decided.
    var decided = ads.filter(function (c) { return c.status !== "pending" && c.status !== "expired"; }).length;
    var posted = ads.filter(function (c) { return c.status === "published"; }).length;
    var brought = ads.filter(function (c) { return c.outcome === "yes"; }).length;
    var said = ads.filter(function (c) { return c.status === "rejected" && c.reject_reason; }).length +
      ads.filter(function (c) { return c.edited_at; }).length + feedbackCount(a) + (a.next_week_note_at ? 1 : 0) +
      ads.filter(function (c) { return c.outcome; }).length;
    var seen = daysSince(a.last_seen_at);
    var profile = strength(a).score;
    // An ad that brought people in is the best reason there is to pay.
    var total =
      (ads.length ? Math.round((35 * decided) / ads.length) : 0) +
      Math.min(said, 5) * 4 +
      (seen === null ? 0 : seen <= 3 ? 20 : seen <= 7 ? 12 : seen <= 14 ? 5 : 0) +
      Math.round(profile * 0.15) +
      (posted ? 5 : 0) + (brought ? 5 : 0);
    return { total: total, decided: decided, delivered: ads.length, posted: posted, brought: brought,
             said: said, profile: profile };
  }

  // How a tester is doing right now, out of 100, from the last two weeks:
  // coming back, answering their own ads (not leaving them to expire or to
  // auto-approval), what they last rated us, and how much the engine knows.
  // Green 70+, yellow 45+, red below. Unlike the launch score, which adds up
  // the whole beta, this one moves week to week - a red is someone to call.
  var HEALTH_DAYS = 14;

  function latestRating(a) {
    return (state.ratings || []).filter(function (x) { return x.user_id === a.id; })[0] || null;
  }

  function health(a) {
    var since = Date.now() - HEALTH_DAYS * 86400000;
    var ads = adsOfAccount(a.id).filter(function (c) { return new Date(c.created_at).getTime() >= since; });
    var mine = ads.filter(function (c) {
      return ["approved", "published", "rejected"].indexOf(c.status) > -1 && !c.auto_approved_at;
    }).length;
    var expired = ads.filter(function (c) { return c.status === "expired"; }).length;
    var auto = ads.filter(function (c) { return c.auto_approved_at; }).length;
    var waiting = ads.filter(function (c) { return c.status === "pending"; }).length;
    var seen = daysSince(a.last_seen_at);
    var rating = latestRating(a);
    var profile = strength(a).score;

    var visit = seen === null ? 0 : seen <= 2 ? 35 : seen <= 5 ? 25 : seen <= 9 ? 12 : 0;
    // Ads still waiting aren't held against them yet; with nothing delivered
    // in two weeks there is nothing to answer, so it counts as half.
    var due = ads.length - waiting;
    var answer = due > 0 ? Math.round((35 * mine) / due) : 18;
    var stars = rating ? Math.round(rating.stars * 3) : 9;
    var total = visit + answer + stars + Math.round(profile * 0.15);

    var why = [];
    why.push(seen === null ? "never seen on the site" : seen === 0 ? "here today" : "last here " + seen + " day" + (seen === 1 ? "" : "s") + " ago");
    if (due > 0) why.push("answered " + mine + " of " + due + " ads themselves");
    else why.push(ads.length ? waiting + " ad" + (waiting === 1 ? "" : "s") + " still waiting" : "no ads in the last " + HEALTH_DAYS + " days");
    if (expired) why.push(expired + " expired unanswered");
    if (auto) why.push(auto + " auto-approved");
    why.push(rating ? "rated " + rating.stars + "/5 " + relDays(rating.created_at) : "hasn't rated yet");
    why.push("profile " + profile + "%");
    if (a.engine_paused_at) why.push("ad engine paused");

    return {
      total: Math.max(0, Math.min(100, total)),
      tier: total >= 70 ? "green" : total >= 45 ? "yellow" : "red",
      why: why
    };
  }

  // Serbian counts: 1 novi oglas, 2-4 nova oglasa, 5+ novih oglasa.
  function srNewAds(n) {
    var ten = n % 10, hundred = n % 100;
    if (ten === 1 && hundred !== 11) return n + " novi oglas";
    if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return n + " nova oglasa";
    return n + " novih oglasa";
  }

  function readyMail(a, gaps) {
    var m = nextMonday();
    return compose(a.email, "Za ponedeljak: još par stvari za tvoje oglase",
      "Zdravo,\n\n" +
      "u ponedeljak (" + m.getDate() + ". " + (m.getMonth() + 1) + ".) stižu novi oglasi za " +
      (a.business_name || "tvoj biznis") + ". Da što više liče na tvoj lokal, u kontrolnoj sobi pod " +
      "„Snaga profila“ još fali:\n\n" +
      gaps.map(function (g) {
        return "– " + g.item.sr + (g.state === "stale" ? " (stara beleška je istekla)" : "");
      }).join("\n") +
      "\n\nTreba ti par minuta: " + SITE_URL + "/control-room.html\n\n" +
      "Ako nešto nije jasno, samo odgovori na ovaj mejl.\n\nPozdrav,\nAdronis");
  }

  function quietMail(a, q) {
    if (q.waiting) {
      return compose(a.email, "Čekaju te novi oglasi",
        "Zdravo,\n\n" +
        "u Odobravanjima te čeka " + srNewAds(q.waiting) + " za " + (a.business_name || "tvoj biznis") + ". " +
        "Pregledaš ih za minut — odobriš šta valja, odbaciš šta ne valja, i izlaze samo odobreni:\n" +
        SITE_URL + "/approvals.html\n\n" +
        "Ako ti nešto ne odgovara, u oglasima ili u načinu rada, odgovori na ovaj mejl — " +
        "baš to nam u beti najviše znači.\n\nPozdrav,\nAdronis");
    }
    return compose(a.email, "Kako ide sa Adronisom?",
      "Zdravo,\n\n" +
      "nismo te videli par dana, pa da proverimo — je l' sve u redu sa oglasima? Ako nešto ne valja, " +
      "ne radi ili ti oduzima previše vremena, napiši nam u odgovoru na ovaj mejl.\n\n" +
      "Tvoja kontrolna soba: " + SITE_URL + "/control-room.html\n\nPozdrav,\nAdronis");
  }

  function launchMail(a) {
    return compose(a.email, "Adronis izlazi iz bete — tvoj popust za osnivače",
      "Zdravo,\n\n" +
      "hvala na svemu u beti. Od " + LAUNCH_DAY_SR + " Adronis izlazi iz bete i Beta plan se završava.\n\n" +
      "Za " + (a.business_name || "tvoj biznis") + " važi popust za osnivače: 30% na mesečni Counter ili " +
      "Storefront plan prvih 12 meseci, uz kod " + FOUNDER_CODE + " na plaćanju. Kod važi za ograničen " +
      "broj lokala.\n\n" +
      "Planovi i cene: " + SITE_URL + "/#pricing\n\n" +
      "Ako imaš pitanja pre nego što odlučiš, samo odgovori na ovaj mejl.\n\nPozdrav,\nAdronis");
  }

  function contactLine(a, kind) {
    var c = (state.contacts[a.id] || {})[kind];
    if (!c) return "";
    return '<span class="panel-note">Emailed ' + esc(relDays(c.at)) + " by " + esc(adminName(c.by || "")) + "</span>";
  }

  function betaRow(a, body, mailHref, mailKind, mailLabel) {
    var place = [a.city, a.country].filter(Boolean).join(", ");
    return '<div class="lead-row">' +
      '<div class="lead-top">' +
        '<span class="lead-who"><span class="cell-main">' + esc(a.business_name || "Unnamed business") + "</span>" +
          '<span class="cell-sub">' + esc([a.email, place, seenText(a)].filter(Boolean).join(" · ")) + "</span></span>" +
        body.top +
      "</div>" +
      body.main +
      '<div class="lead-actions">' +
        contactLine(a, mailKind) +
        '<span class="spacer"></span>' +
        (mailHref
          ? '<a class="btn-ghost btn-sm" href="' + esc(mailHref) + '" target="_blank" rel="noopener" ' +
              'data-contact="' + mailKind + '" data-user="' + esc(a.id) + '">' + esc(mailLabel) + "</a>"
          : "") +
        '<button type="button" class="btn-ghost btn-sm" data-open="' + esc(a.id) + '">Open account</button>' +
      "</div>" +
    "</div>";
  }

  function renderBeta() {
    var list = state.accounts.filter(betaOn);
    var quiet = list.map(function (a) { return { a: a, q: quietness(a) }; })
      .filter(function (x) { return x.q; })
      .sort(function (x, y) { return y.q.rank - x.q.rank; });

    $("bv-badge").textContent = quiet.length;
    $("bv-badge").hidden = !quiet.length;

    Array.prototype.forEach.call(document.querySelectorAll("#bv-modes .mode"), function (b) {
      b.classList.toggle("is-on", b.dataset.bv === state.betaView);
      b.setAttribute("aria-pressed", b.dataset.bv === state.betaView ? "true" : "false");
    });

    var note = "", rows = "", empty = "";
    var noSeen = list.every(function (a) { return !a.last_seen_at; });

    if (state.betaView === "ready") {
      var scored = list.map(function (a) { return { a: a, s: strength(a) }; })
        .sort(function (x, y) { return x.s.score - y.s.score; });
      var full = scored.filter(function (x) { return x.s.score >= 100; }).length;
      var m = nextMonday();
      note = "Next drop: " + m.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" }) +
        ". Profile strength is scored the way each tester sees it in their control room — " +
        full + " of " + list.length + " at 100%." +
        (state.assets ? "" : " Logo, photo and menu counts appear once portal-admin.sql has been re-run.");
      rows = scored.map(function (x) {
        var s = x.s;
        var checks = STRENGTH.map(function (item) {
          var st = strengthState(item, x.a);
          var label = item.label;
          if (item.asset === "photos" && st === "done") label += " (" + state.assets[x.a.id].photos + ")";
          if (st === "stale") label += " — out of date";
          return '<li class="bv-check is-' + st + '">' + esc(label) + "</li>";
        }).join("");
        return betaRow(x.a, {
          top: '<span class="bv-score"><b>' + s.score + "%</b> profile strength</span>",
          main: '<div class="bv-bar" aria-hidden="true"><span style="width:' + s.score + '%"></span></div>' +
                '<ul class="bv-checks">' + checks + "</ul>"
        }, s.gaps.length ? readyMail(x.a, s.gaps) : null, "ready", "Email a reminder");
      }).join("");
      empty = "No beta testers yet. Switch the Beta plan on for an account from Accounts.";

    } else if (state.betaView === "health") {
      var checked = list.map(function (a) { return { a: a, h: health(a), q: quietness(a) }; })
        .sort(function (x, y) { return x.h.total - y.h.total; });
      var tally = { green: 0, yellow: 0, red: 0 };
      checked.forEach(function (x) { tally[x.h.tier]++; });
      note = "How each tester is doing over the last " + HEALTH_DAYS + " days, worst first: " +
        tally.red + " red, " + tally.yellow + " yellow, " + tally.green + " green. " +
        "Coming back counts 35, answering their own ads 35, their last rating 15, their profile 15.";
      var TIER = { green: ["doing well", "pill-active"], yellow: ["watch", "pill-trialing"], red: ["call them", "pill-past_due"] };
      rows = checked.map(function (x) {
        var t = TIER[x.h.tier];
        return betaRow(x.a, {
          top: '<span class="pill ' + t[1] + '">' + t[0] + "</span>" +
               '<span class="bv-score"><b>' + x.h.total + "</b> / 100</span>",
          main: '<div class="bv-bar bv-health is-' + x.h.tier + '" aria-hidden="true"><span style="width:' + x.h.total + '%"></span></div>' +
                '<div class="bv-why">' + esc(x.h.why.join(" · ")) + "</div>" +
                '<div class="lead-actions"><a class="btn-ghost btn-sm" href="' + esc(viewAsUrl(x.a.id, "control-room.html")) +
                  '" target="_blank" rel="noopener">View as tester ↗</a></div>'
        }, x.h.tier !== "green" ? quietMail(x.a, x.q || { waiting: 0 }) : null, "quiet",
           x.q && x.q.waiting ? "Email: ads are waiting" : "Email: how's it going?");
      }).join("");
      empty = "No beta testers yet.";

    } else if (state.betaView === "quiet") {
      note = "Not back for " + QUIET_DAYS + "+ days, or ads waiting on them for " + (WAITING_HOURS / 24) + "+ days. " +
        (list.length - quiet.length) + " of " + list.length + " testers are fine." +
        (noSeen && list.length ? " Visits are counted from when the site's schema.sql was re-run, so \"not seen yet\" may only mean that." : "");
      rows = quiet.map(function (x) {
        return betaRow(x.a, {
          top: '<span class="pill pill-past_due">gone quiet</span>',
          main: '<div class="lead-text">' + esc(x.q.reasons.join("; ")) + ".</div>"
        }, quietMail(x.a, x.q), "quiet", x.q.waiting ? "Email: ads are waiting" : "Email: how's it going?");
      }).join("");
      empty = list.length ? "Nobody has gone quiet. Every tester has been back in the last " + QUIET_DAYS +
        " days and nothing has waited on them for long." : "No beta testers yet.";

    } else {
      var ranked = list.map(function (a) { return { a: a, s: launchScore(a) }; })
        .sort(function (x, y) { return y.s.total - x.s.total; });
      note = "Most likely to pay first. " + FOUNDER_CODE + " works " + FOUNDER_USES + " times, so the top " +
        FOUNDER_USES + " are marked. At launch, set each one to No plan in Accounts, then send the email.";
      rows = ranked.map(function (x, i) {
        var s = x.s;
        var tier = s.total >= 70 ? ["likely", "pill-active"] : s.total >= 40 ? ["maybe", "pill-trialing"] : ["unlikely", "pill-canceled"];
        var why = [
          s.delivered ? "answered " + s.decided + " of " + s.delivered + " ads" : "no ads yet",
          s.said + " time" + (s.said === 1 ? "" : "s") + " told us more",
          seenText(x.a),
          "profile " + s.profile + "%",
          s.posted + " posted"
        ].concat(s.brought ? [s.brought + " brought people in"] : []).join(" · ");
        return betaRow(x.a, {
          top: (i < FOUNDER_USES ? '<span class="pill pill-acc">' + esc(FOUNDER_CODE) + "</span>" : "") +
               '<span class="pill ' + tier[1] + '">' + tier[0] + "</span>" +
               '<span class="bv-score"><b>' + s.total + "</b> / 100</span>",
          main: '<div class="bv-why">' + esc(why) + "</div>"
        }, launchMail(x.a), "launch", "Email the launch offer");
      }).join("");
      empty = "No beta testers yet.";
    }

    if (state.betaView === "applications") {
      var applied = state.accounts.filter(function (a) { return a.beta_applied_at && !betaOn(a); })
        .map(function (a) { return { a: a, s: appScore(a) }; })
        .sort(function (x, y) { return y.s.total - x.s.total || new Date(x.a.beta_applied_at) - new Date(y.a.beta_applied_at); });
      note = "Waiting to be let in, best fit first. The score only sorts the list — every point says where it came from, " +
        "and it can't tell whether what they wrote is true: open their Instagram before you decide.";
      rows = applied.map(function (x) {
        var a = x.a, s = x.s;
        var by = referrer(a);
        var site = /^@|instagram\.com/i.test(a.website || "")
          ? "https://instagram.com/" + handle(a.website)
          : /^https?:\/\//i.test(a.website || "") ? a.website : null;
        return '<div class="lead-row">' +
          '<div class="lead-top">' +
            '<span class="lead-who"><span class="cell-main">' + esc(a.business_name || "Unnamed business") + "</span>" +
              '<span class="cell-sub">' + esc([a.email, [a.city, a.country].filter(Boolean).join(", "), a.vertical,
                "applied " + relDays(a.beta_applied_at)].filter(Boolean).join(" · ")) + "</span></span>" +
            (by ? '<span class="pill pill-acc">referred by ' + esc(by.business_name || by.email) + "</span>" : "") +
            '<span class="bv-score"><b>' + s.total + "</b> / 100</span>" +
          "</div>" +
          '<div class="bv-why">' + esc(s.parts.map(function (p) { return p[0] + " +" + p[1]; }).join(" · ") || "nothing filled in") + "</div>" +
          (a.why_us ? '<div class="lead-text">' + esc(a.why_us) + "</div>" : "") +
          '<div class="lead-actions"><span class="spacer"></span>' +
            (site ? '<a class="btn-ghost btn-sm" href="' + esc(site) + '" target="_blank" rel="noopener">Open their Instagram or site</a>' : "") +
            '<button type="button" class="btn-ghost btn-sm" data-open="' + esc(a.id) + '">Open account</button>' +
          "</div>" +
        "</div>";
      }).join("");
      empty = "No applications waiting.";
    }

    $("bv-updates").hidden = state.betaView !== "updates";
    if (state.betaView === "updates") {
      renderUpdates(list);
      note = "A short note in testers' control rooms — for one tester (\"On your suggestion: …\") or for every tester. " +
        "Each tester sees it until they close it.";
      rows = "";
      empty = "";
    }

    $("bv-events").hidden = state.betaView !== "events";
    if (state.betaView === "events") {
      renderEvents();
      note = "Dates worth an ad that belong to one town, or that move every year: a festival, a town's day, a match of the national team. " +
        "Every business in that town sees it as \"coming up\" in its control room.";
      rows = "";
      empty = "";
    }

    $("bv-seats").hidden = state.betaView !== "applications";
    if (state.betaView === "applications") renderSeats(list.length);

    $("bv-costs").hidden = state.betaView !== "costs";
    if (state.betaView === "costs") {
      var co = renderCosts(list);
      note = co.note;
      rows = co.rows;
      empty = co.empty;
    }

    $("bv-note").textContent = note;
    $("bv-list").innerHTML = rows;
    $("bv-empty").textContent = empty;
    $("bv-empty").hidden = !!rows || !empty;
  }

  // ----------------------------------------------------------- beta places
  //
  // How many businesses the beta takes (app_settings 'beta_seats'). Taken is
  // every account with the Beta plan on - the same count as the site's
  // beta_seats(). Once they're all taken, the site's signup and beta pages
  // say the beta is full and apply_for_beta takes no more applications;
  // raise the number, or end a tester's plan, and they open again.

  function renderSeats(taken) {
    var seats = state.seats;
    if (document.activeElement !== $("se-seats")) $("se-seats").value = seats === null ? "" : seats;
    var waiting = state.accounts.filter(function (a) { return a.beta_applied_at && !betaOn(a); }).length;
    if (seats === null) {
      $("se-taken").innerHTML = "<b>" + taken + "</b> taken · no limit";
      $("se-bar").style.width = "0%";
      $("se-note").textContent = "No number set, so the site keeps taking applications. Set one and it stops once they're all taken.";
    } else {
      var left = Math.max(seats - taken, 0);
      $("se-taken").innerHTML = "<b>" + taken + "</b> of " + esc(seats) + " taken · " + left + " left";
      $("se-bar").style.width = (seats ? Math.min(100, (taken / seats) * 100) : 100) + "%";
      $("se-bar").parentNode.classList.toggle("is-over", left === 0);
      $("se-note").textContent = left === 0
        ? "Full: the signup and beta pages say so and take no applications. " +
          (waiting ? waiting + " already waiting below can still be let in, past the number." : "")
        : left + " place" + (left === 1 ? "" : "s") + " left — applications stay open until they're taken.";
    }
  }

  $("se-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var raw = $("se-seats").value.trim();
    var seats = raw === "" ? null : Math.floor(Number(raw));
    if (seats !== null && !(seats >= 0)) return;
    $("se-save").disabled = true;
    $("se-msg").textContent = "Saving…";
    var res = await db.rpc("admin_set_setting", { p_key: "beta_seats", p_value: { seats: seats } });
    $("se-save").disabled = false;
    if (res.error) {
      $("se-msg").textContent = "Couldn't save: " + res.error.message;
      return;
    }
    state.seats = seats;
    $("se-msg").textContent = "Saved.";
    renderBeta();
    refreshAudit();
  });

  // ----------------------------------------------------------- beta costs
  //
  // What making the ads cost, from the rows the ad engine writes into
  // generation_costs (one per paid Claude or Higgsfield call), measured
  // against the beta budget in app_settings. Providers bill in dollars;
  // the budget is in euros, at the rate saved next to it.

  var DEFAULT_BUDGET = { eur: 47, usd_eur: 0.86 };

  function usd(n) {
    return "$" + (Number(n) || 0).toFixed(2);
  }

  function renderCosts(testers) {
    var b = state.budget || DEFAULT_BUDGET;
    if (document.activeElement !== $("co-eur")) $("co-eur").value = b.eur;
    if (document.activeElement !== $("co-rate")) $("co-rate").value = b.usd_eur;
    if (document.activeElement !== $("co-cap")) $("co-cap").value = b.tester_week_eur || "";
    var cap = b.tester_week_eur || null;

    var off = state.costs === null;
    var rows = state.costs || [];
    function sum(k) { return rows.reduce(function (n, x) { return n + x[k]; }, 0); }
    var spentUsd = sum("usd");
    var spentEur = spentUsd * b.usd_eur;
    var pct = b.eur > 0 ? (spentEur / b.eur) * 100 : 0;
    var adCount = sum("ads");

    // The pace: what the last 28 days cost, carried forward.
    var perDayEur = (sum("usd_28d") * b.usd_eur) / 28;
    var pace;
    if (off) {
      pace = "Costs appear once the site's schema.sql and then portal-admin.sql have been re-run.";
    } else if (!rows.length) {
      pace = "Nothing logged yet — the ad engine writes a row for every Claude and Higgsfield call it makes.";
    } else if (spentEur >= b.eur) {
      pace = "The budget is spent. Raise it below, or slow the drops down.";
    } else if (perDayEur > 0) {
      var left = new Date(Date.now() + ((b.eur - spentEur) / perDayEur) * 86400000);
      pace = "At the last 4 weeks' pace (€" + (perDayEur * 7).toFixed(2) + " a week), what's left lasts until " +
        left.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) + ".";
    } else {
      pace = "Nothing spent in the last 4 weeks.";
    }

    $("co-spent").innerHTML = "<b>€" + spentEur.toFixed(2) + "</b> of €" + esc(b.eur) + " · " + Math.round(pct) + "%";
    $("co-bar").style.width = Math.min(100, pct) + "%";
    $("co-bar").parentNode.classList.toggle("is-over", pct >= 100);
    $("co-pace").textContent = pace;

    $("co-tiles").innerHTML = [
      { k: "Spent", v: "€" + spentEur.toFixed(2), sub: usd(spentUsd) + " billed" },
      { k: "Per ad", v: adCount ? "€" + (spentEur / adCount).toFixed(2) : "—",
        sub: adCount + " ad" + (adCount === 1 ? "" : "s") + " made, retries included" },
      { k: "Claude", v: usd(sum("claude")), sub: "copy and image checks" },
      { k: "Higgsfield", v: usd(sum("higgsfield")), sub: "images and reels" }
    ].map(function (x) {
      return '<div class="tile"><div class="tile-k">' + esc(x.k) + '</div><div class="tile-v">' + esc(x.v) +
             '</div><div class="tile-sub">' + esc(x.sub) + "</div></div>";
    }).join("");

    // Per account, biggest spender first. Testers with nothing yet are
    // listed too; our own test runs and deleted accounts keep their line.
    var staff = {};
    state.admins.forEach(function (m) { staff[m.user_id] = true; });
    var by = {};
    testers.forEach(function (a) { by[a.id] = { a: a, usd: 0, ads: 0, week: 0, last: null }; });
    rows.forEach(function (x) {
      var id = x.user_id || "gone";
      var t = by[id] = by[id] || { a: state.accountById[id] || null, staff: !!staff[id], usd: 0, ads: 0, week: 0, last: null };
      t.usd = x.usd; t.ads = x.ads; t.week = x.usd_7d; t.last = x.last_at;
    });
    var list = Object.keys(by).map(function (id) { return by[id]; })
      .sort(function (x, y) { return y.usd - x.usd; });
    var top = list.length ? list[0].usd : 0;
    var over = list.filter(function (t) { return t.a && cap && t.week * b.usd_eur > cap; }).length;

    var html = list.map(function (t) {
      var n = t.ads;
      var eur = t.usd * b.usd_eur;
      var weekEur = t.week * b.usd_eur;
      var isOver = !!(t.a && cap && weekEur > cap);
      var paused = !!(t.a && t.a.engine_paused_at);
      var name = t.a ? (t.a.business_name || "Unnamed business") : t.staff ? "Our own test runs" : "Deleted account";
      var sub = t.a ? [t.a.email, [t.a.city, t.a.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ") : "";
      var why = [
        n + " ad" + (n === 1 ? "" : "s"),
        n ? "€" + (eur / n).toFixed(2) + " per ad" : null,
        "€" + weekEur.toFixed(2) + " in the last 7 days" + (cap ? " (cap €" + cap + ")" : ""),
        t.last ? "last " + relDays(t.last) : "nothing made yet",
        paused ? "paused " + relDays(t.a.engine_paused_at) + (t.a.engine_pause_note ? " — " + t.a.engine_pause_note : "") : null
      ].filter(Boolean).join(" · ");
      return '<div class="lead-row' + (isOver && !paused ? " is-new" : "") + '">' +
        '<div class="lead-top">' +
          '<span class="lead-who"><span class="cell-main">' + esc(name) + "</span>" +
            (sub ? '<span class="cell-sub">' + esc(sub) + "</span>" : "") + "</span>" +
          (paused ? '<span class="pill pill-canceled">paused</span>' : "") +
          (isOver ? '<span class="pill pill-past_due">over the weekly cap</span>' : "") +
          '<span class="bv-score"><b>€' + eur.toFixed(2) + "</b> " + esc(usd(t.usd)) + "</span>" +
        "</div>" +
        '<div class="bv-bar' + (isOver ? " is-over" : "") + '" aria-hidden="true"><span style="width:' + (top ? (t.usd / top) * 100 : 0) + '%"></span></div>' +
        '<div class="bv-why">' + esc(why) + "</div>" +
        (t.a ? '<div class="lead-actions"><span class="spacer"></span>' +
          '<button type="button" class="btn-ghost btn-sm' + (paused ? "" : " btn-danger") + '" data-pause="' + esc(t.a.id) +
            '" data-on="' + (paused ? "0" : "1") + '">' + (paused ? "Resume ads" : "Pause ads") + "</button>" +
          '<button type="button" class="btn-ghost btn-sm" data-open="' + esc(t.a.id) + '">Open account</button></div>' : "") +
      "</div>";
    }).join("");

    return {
      note: "Every Claude and Higgsfield call the ad engine pays for, retries and thrown-away images included. " +
        "Bars compare testers with the biggest spender." +
        (cap ? " " + (over ? over + " tester" + (over === 1 ? " is" : "s are") + " over the €" + cap + " weekly cap — only we see this." :
          "Nobody is over the €" + cap + " weekly cap.") : " Set a weekly cap per tester below to be told when one costs too much.") +
        " Pause stops new ads for one account until you resume it; the customer isn't told, so write to them.",
      rows: off ? "" : html,
      empty: off ? "" : "No beta testers yet."
    };
  }

  $("co-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var eur = Number($("co-eur").value), rate = Number($("co-rate").value);
    var cap = $("co-cap").value.trim() === "" ? null : Number($("co-cap").value);
    if (!(eur >= 0) || !(rate > 0) || (cap !== null && !(cap > 0))) return;
    $("co-save").disabled = true;
    $("co-msg").textContent = "Saving…";
    var value = { eur: eur, usd_eur: rate };
    if (cap) value.tester_week_eur = cap;
    var res = await db.rpc("admin_set_setting", { p_key: "beta_budget", p_value: value });
    $("co-save").disabled = false;
    if (res.error) {
      $("co-msg").textContent = "Couldn't save: " + res.error.message;
      return;
    }
    state.budget = { eur: eur, usd_eur: rate, tester_week_eur: cap || null };
    renderToday();
    $("co-msg").textContent = "Saved.";
    renderBeta();
    refreshAudit();
  });

  // The same stars the tester picks in the control room: small outlines,
  // filled with the brand blue up to the rating.
  var STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 2.9l2.8 5.7 6.3.9-4.55 4.45 1.07 6.27L12 17.25l-5.62 2.97 1.07-6.27L2.9 9.5l6.3-.9z"/></svg>';

  function stars(n) {
    var out = "";
    for (var i = 1; i <= 5; i++) out += '<span class="star' + (i <= n ? " is-on" : "") + '">' + STAR_SVG + "</span>";
    return '<span class="stars" role="img" aria-label="' + n + ' of 5">' + out + "</span>";
  }

  // Which tester's invite brought this account (profiles.referred_by is the
  // first 8 characters of the tester's id).
  function referrer(a) {
    if (!a.referred_by) return null;
    return state.accounts.filter(function (x) { return String(x.id).slice(0, 8) === a.referred_by; })[0] || null;
  }

  // --- Sorting applications: fixed points for what the application says.
  // The rules, and the most each can give (100 in all):
  //   where: Belgrade or Novi Sad 25, elsewhere in Serbia 10
  //   kind: a café, restaurant, pizzeria, bakery or wine bar 20, any other 10
  //   an Instagram or website given 15
  //   the brief (what they sell, who comes, what's different) up to 20
  //   why they want Adronis, in more than a few words 10 (a few words 4)
  //   at least one channel picked 10
  var HOSPITALITY = ["Café", "Restaurant", "Pizzeria", "Bakery", "Wine bar"];

  function plain(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "dj");
  }

  function appScore(a) {
    var parts = [];
    var city = plain(a.city);
    if (/beograd|belgrade|novi sad/.test(city)) parts.push([a.city, 25]);
    else if (a.country === "Serbia") parts.push(["Serbia, not BG/NS", 10]);
    if (HOSPITALITY.indexOf(a.vertical) > -1) parts.push([a.vertical, 20]);
    else if (a.vertical) parts.push([a.vertical, 10]);
    if (String(a.website || "").trim()) parts.push(["Instagram or site", 15]);
    var brief = ["what_you_sell", "typical_customer", "differentiator"].filter(function (k) {
      return String(a[k] || "").trim().length >= 3;
    }).length;
    if (brief) parts.push(["brief " + brief + " of 3", Math.round((20 * brief) / 3)]);
    var why = String(a.why_us || "").trim().length;
    if (why >= 30) parts.push(["said why", 10]);
    else if (why) parts.push(["said why, briefly", 4]);
    if ((a.channels || []).length) parts.push(["channels", 10]);
    return { total: parts.reduce(function (n, p) { return n + p[1]; }, 0), parts: parts };
  }

  // --------------------------------------------------------------- ratings
  //
  // What customers say when their control room asks "would you recommend
  // Adronis?" - after three weeks of ads, then every six months, in the beta
  // and after it. Every answer is kept: the list shows each customer's
  // latest, with the ones before it, so a view that changes shows.

  function ratingsByCustomer() {
    var by = {};
    (state.ratings || []).forEach(function (x) {
      if (!state.accountById[x.user_id]) return;   // an admin's own test
      (by[x.user_id] = by[x.user_id] || []).push(x);   // newest first, as loaded
    });
    return by;
  }

  function renderRatings() {
    var off = state.ratings === null;
    var by = ratingsByCustomer();
    var who = $("rt-who").value;
    var latest = Object.keys(by).map(function (id) {
      return { a: state.accountById[id], all: by[id], last: by[id][0] };
    }).filter(function (x) {
      if (who === "beta") return betaOn(x.a);
      if (who === "paying") return !betaOn(x.a) && ["trialing", "active", "past_due"].indexOf(x.a.subscription_status) > -1;
      return true;
    }).sort(function (x, y) { return new Date(y.last.created_at) - new Date(x.last.created_at); });

    var avg = latest.length ? latest.reduce(function (n, x) { return n + x.last.stars; }, 0) / latest.length : 0;
    var recent = latest.filter(function (x) { return Date.now() - new Date(x.last.created_at) < 30 * 86400000; }).length;
    var publish = latest.filter(function (x) { return x.last.may_publish && x.last.comment; }).length;
    $("rt-tiles").innerHTML = off ? "" : [
      { k: "Average", v: latest.length ? avg.toFixed(1) : "—", sub: "their latest answer, out of 5" },
      { k: "Rated", v: latest.length, sub: "customers who answered" },
      { k: "Last 30 days", v: recent, sub: "new answers" },
      { k: "May publish", v: publish, sub: "with their words and name" }
    ].map(function (x) {
      return '<div class="tile"><div class="tile-k">' + esc(x.k) + '</div><div class="tile-v">' + esc(x.v) +
             '</div><div class="tile-sub">' + esc(x.sub) + "</div></div>";
    }).join("");

    $("rt-note").textContent = off
      ? "Ratings appear once the site's schema.sql and then portal-admin.sql have been re-run."
      : "Asked in the control room after three weeks of ads, then every six months — beta testers and paying customers alike.";
    $("rt-list").innerHTML = latest.map(function (x) {
      var a = x.a, r = x.last;
      var plan = betaOn(a) ? "Beta" : PLAN_LABEL[a.plan] || "";
      var before = x.all.slice(1, 4).map(function (p) {
        return stars(p.stars) + ' <span class="rt-when">' + esc(fmtDate(p.created_at)) + "</span>";
      }).join('<span class="rt-sep">·</span>');
      return '<div class="lead-row" data-rating="' + esc(r.id) + '">' +
        '<div class="lead-top">' +
          '<span class="lead-who"><span class="cell-main">' + esc(a.business_name || a.email) + "</span>" +
            '<span class="cell-sub">' + esc([a.city, plan, relDays(r.created_at)].filter(Boolean).join(" · ")) + "</span></span>" +
          stars(r.stars) +
          '<span class="pill' + (r.may_publish ? " pill-active" : "") + '">' + (r.may_publish ? "may publish" : "private") + "</span>" +
        "</div>" +
        (r.comment ? '<div class="lead-text">“' + esc(r.comment) + "”</div>" : "") +
        (before ? '<div class="rt-before"><span class="mono">BEFORE</span> ' + before + "</div>" : "") +
        '<div class="lead-actions"><span class="spacer"></span>' +
          (r.may_publish && r.comment ? '<button type="button" class="btn-ghost btn-sm" data-quote>Copy as a quote</button>' : "") +
          '<button type="button" class="btn-ghost btn-sm" data-open="' + esc(a.id) + '">Open account</button>' +
        "</div>" +
      "</div>";
    }).join("");
    $("rt-empty").textContent = off ? "" : Object.keys(by).length ? "Nobody here with that filter." : "No ratings yet.";
    $("rt-empty").hidden = off || latest.length > 0;
  }

  $("rt-who").addEventListener("input", renderRatings);

  $("rt-list").addEventListener("click", function (e) {
    var b = e.target.closest("[data-quote]");
    if (!b) return;
    var row = (state.ratings || []).filter(function (x) { return x.id === b.closest("[data-rating]").dataset.rating; })[0];
    var a = row && state.accountById[row.user_id];
    if (!a) return;
    copyText("“" + row.comment + "” — " + [a.business_name, a.city].filter(Boolean).join(", "), b);
  });

  // ---------------------------------------------------------------- errors
  //
  // What broke in visitors' browsers (client_errors, sent by the site's
  // errors.js). The same error from the same spot in the code is one row,
  // with how often, on which pages and browsers, and whose account it hit.
  // "Copy for fixing" puts everything about it in one block to paste into a
  // chat with Claude; "Fixed" clears its reports once the fix is live.

  // "Chrome on Android", "Instagram app on iPhone" - the in-app browsers
  // matter, since owners open links from DMs.
  function browserOf(ua) {
    ua = ua || "";
    var os = /iPhone|iPad|iPod/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
      : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "another system";
    var br = /Instagram/.test(ua) ? "Instagram app" : /FBAN|FBAV|FB_IAB/.test(ua) ? "Facebook app"
      : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /EdgA?\/|EdgiOS/.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera"
      : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "a browser";
    return br + " on " + os;
  }

  function errorKey(x) {
    return [x.message, x.source || x.page || "", x.line || ""].join("|");
  }

  function errorGroups(days) {
    var since = Date.now() - days * 86400000;
    var groups = {};
    (state.errors || []).forEach(function (x) {
      if (new Date(x.created_at).getTime() < since) return;
      var k = errorKey(x);
      var g = groups[k] = groups[k] || { key: k, rows: [], pages: {}, browsers: {}, users: {} };
      g.rows.push(x);
      if (x.page) g.pages[x.page] = (g.pages[x.page] || 0) + 1;
      var b = browserOf(x.user_agent);
      g.browsers[b] = (g.browsers[b] || 0) + 1;
      if (x.user_id) g.users[x.user_id] = true;
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      g.last = g.rows[0];     // rows arrive newest first
      g.first = g.rows[g.rows.length - 1];
      return g;
    }).sort(function (x, y) { return new Date(y.last.created_at) - new Date(x.last.created_at); });
  }

  function topOf(counts, n) {
    return Object.keys(counts).sort(function (x, y) { return counts[y] - counts[x]; }).slice(0, n)
      .map(function (k) { return counts[k] > 1 ? k + " (" + counts[k] + ")" : k; });
  }

  function errorWhere(x) {
    return x.source ? x.source + (x.line ? ":" + x.line + (x.col ? ":" + x.col : "") : "") : "";
  }

  function renderErrors() {
    var off = state.errors === null;
    var day = errorGroups(1);
    $("er-badge").textContent = day.length;
    $("er-badge").hidden = !day.length;

    var all = off ? [] : state.errors;
    var since7 = Date.now() - 7 * 86400000;
    var week = all.filter(function (x) { return new Date(x.created_at).getTime() >= since7; });
    var hitUsers = {};
    week.forEach(function (x) { if (x.user_id) hitUsers[x.user_id] = true; });
    var weekPages = {};
    week.forEach(function (x) { if (x.page) weekPages[x.page] = true; });
    $("er-tiles").innerHTML = off ? "" : [
      { k: "Last 24 hours", v: day.reduce(function (n, g) { return n + g.rows.length; }, 0), sub: day.length + " different error" + (day.length === 1 ? "" : "s") },
      { k: "Last 7 days", v: week.length, sub: "reports" },
      { k: "Pages", v: Object.keys(weekPages).length, sub: "hit in the last 7 days" },
      { k: "Customers", v: Object.keys(hitUsers).length, sub: "signed in when it happened" }
    ].map(function (x) {
      return '<div class="tile"><div class="tile-k">' + esc(x.k) + '</div><div class="tile-v">' + esc(x.v) +
             '</div><div class="tile-sub">' + esc(x.sub) + "</div></div>";
    }).join("");

    var q = $("er-search").value.trim().toLowerCase();
    var groups = errorGroups(Number($("er-range").value) || 7).filter(function (g) {
      if (!q) return true;
      var names = Object.keys(g.users).map(function (id) {
        var a = state.accountById[id];
        return a ? (a.business_name || "") + " " + (a.email || "") : "";
      }).join(" ");
      return (g.last.message + " " + errorWhere(g.last) + " " + Object.keys(g.pages).join(" ") + " " +
        Object.keys(g.browsers).join(" ") + " " + names).toLowerCase().indexOf(q) !== -1;
    });

    $("er-note").textContent = off
      ? "Errors appear once the site's schema.sql and then portal-admin.sql have been re-run."
      : groups.length + " error" + (groups.length === 1 ? "" : "s");
    $("er-list").innerHTML = groups.map(function (g) {
      var x = g.last;
      var who = Object.keys(g.users).map(function (id) { return state.accountById[id]; }).filter(Boolean);
      var fresh = Date.now() - new Date(x.created_at) < 86400000;
      return '<div class="lead-row er-row' + (fresh ? " is-new" : "") + '" data-err="' + esc(g.key) + '">' +
        '<div class="lead-top">' +
          '<span class="pill' + (fresh ? " pill-past_due" : "") + '">' + g.rows.length + "×</span>" +
          '<span class="lead-who"><span class="cell-main er-msg">' + esc(x.message) + "</span>" +
            '<span class="cell-sub">' + esc(["last " + fmtDateTime(x.created_at),
              g.rows.length > 1 ? "first " + fmtDateTime(g.first.created_at) : ""].filter(Boolean).join(" · ")) + "</span></span>" +
        "</div>" +
        '<dl class="er-facts">' +
          "<dt>Pages</dt><dd>" + esc(topOf(g.pages, 4).join(", ") || "—") + "</dd>" +
          "<dt>Browsers</dt><dd>" + esc(topOf(g.browsers, 4).join(", ")) + "</dd>" +
          (errorWhere(x) ? "<dt>In the code</dt><dd class=\"mono\">" + esc(errorWhere(x)) + "</dd>" : "") +
          (who.length ? "<dt>Accounts</dt><dd>" + esc(who.map(function (a) { return a.business_name || a.email; }).join(", ")) + "</dd>" : "") +
        "</dl>" +
        (x.stack ? '<details class="er-stack"><summary>Stack</summary><pre>' + esc(x.stack) + "</pre></details>" : "") +
        '<div class="lead-actions">' +
          (who.length === 1 ? '<button type="button" class="btn-ghost btn-sm" data-open="' + esc(who[0].id) + '">Open account</button>' : "") +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn-ghost btn-sm" data-copy-err>Copy for fixing</button>' +
          '<button type="button" class="btn-ghost btn-sm" data-fixed>Fixed</button>' +
        "</div>" +
      "</div>";
    }).join("");
    $("er-empty").textContent = off ? "" : (state.errors.length ? "Nothing with that search in this period." : "Nothing has broken in anyone's browser in the last 30 days.");
    $("er-empty").hidden = off || groups.length > 0;
  }

  // Everything about one error in a block of plain text, for a chat with
  // Claude or a note to self.
  function errorReport(g) {
    var x = g.last;
    return [
      "Error on the Adronis site (adronis.vercel.app), from the portal's Errors tab:",
      "",
      "Message: " + x.message,
      errorWhere(x) ? "Where: " + errorWhere(x) : null,
      "Seen " + g.rows.length + " time" + (g.rows.length === 1 ? "" : "s") + ", first " + fmtDateTime(g.first.created_at) +
        ", last " + fmtDateTime(x.created_at),
      "Pages: " + (topOf(g.pages, 6).join(", ") || "—"),
      "Browsers: " + topOf(g.browsers, 6).join(", "),
      "Language: " + (x.lang || "—"),
      "User agent: " + (x.user_agent || "—"),
      x.stack ? "\nStack:\n" + x.stack : null
    ].filter(function (line) { return line !== null; }).join("\n");
  }

  $("er-search").addEventListener("input", renderErrors);
  $("er-range").addEventListener("input", renderErrors);

  $("er-list").addEventListener("click", async function (e) {
    var row = e.target.closest("[data-err]");
    if (!row) return;
    var g = errorGroups(30).filter(function (x) { return x.key === row.dataset.err; })[0];
    if (!g) return;
    var b;
    if ((b = e.target.closest("[data-copy-err]"))) {
      copyText(errorReport(g), b);
      return;
    }
    if ((b = e.target.closest("[data-fixed]"))) {
      if (!window.confirm("Clear the " + g.rows.length + " report" + (g.rows.length === 1 ? "" : "s") +
          " of this error? Do it once the fix is live — if it happens again it shows up here as new.")) return;
      b.disabled = true;
      var ids = g.rows.map(function (x) { return x.id; });
      var res = await db.from("client_errors").delete().in("id", ids);
      if (res.error) {
        b.disabled = false;
        flashLabel(b, "Couldn't clear it");
        return;
      }
      state.errors = state.errors.filter(function (x) { return ids.indexOf(x.id) === -1; });
      renderErrors();
      renderToday();
    }
  });

  // The Updates mode: the form, and what has gone out so far.
  function renderUpdates(testers) {
    var pick = $("up-for");
    var was = pick.value;
    pick.innerHTML = '<option value="">Every tester</option>' + testers.slice()
      .sort(function (x, y) { return String(x.business_name || x.email).localeCompare(String(y.business_name || y.email)); })
      .map(function (a) {
        return '<option value="' + esc(a.id) + '">' + esc(a.business_name || a.email) + "</option>";
      }).join("");
    pick.value = was;
    if (pick.value !== was) pick.value = "";

    var off = state.updates === null;
    $("up-body").disabled = off;
    $("up-post").disabled = off;
    if (off) {
      $("up-list").innerHTML = "";
      $("up-msg").textContent = "Updates work once the site's schema.sql and then portal-admin.sql have been re-run.";
      return;
    }
    $("up-list").innerHTML = state.updates.length ? state.updates.map(function (u) {
      var who = u.user_id ? state.accountById[u.user_id] : null;
      return '<div class="lead-row" data-update="' + esc(u.id) + '">' +
        '<div class="lead-top"><span class="lead-who"><span class="cell-main">' +
          esc(u.user_id ? (who ? who.business_name || who.email : "A former tester") : "Every tester") + "</span>" +
          '<span class="cell-sub">' + esc((u.created_by || "Adronis") + " · " + relDays(u.created_at)) + "</span></span>" +
          '<span class="pill' + (u.user_id ? " pill-acc" : "") + '">' + (u.user_id ? "on their suggestion" : "news") + "</span>" +
        "</div>" +
        '<div class="lead-text">' + esc(u.body) + "</div>" +
        '<div class="lead-actions"><span class="spacer"></span>' +
          '<button type="button" class="btn-ghost btn-sm btn-danger" data-delete-update>Delete</button></div>' +
      "</div>";
    }).join("") : '<p class="panel-note">Nothing posted yet.</p>';
  }

  $("up-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var body = $("up-body").value.trim();
    if (!body) return;
    $("up-post").disabled = true;
    $("up-msg").textContent = "Posting…";
    var res = await db.rpc("admin_post_update", { p_user: $("up-for").value || null, p_body: body });
    $("up-post").disabled = false;
    if (res.error) { $("up-msg").textContent = res.error.message; return; }
    $("up-body").value = "";
    $("up-msg").textContent = "Posted. It shows in the control room the next time they open it.";
    var fresh = await db.from("updates").select("*").order("created_at", { ascending: false }).limit(200);
    if (!fresh.error) state.updates = fresh.data || [];
    renderBeta();
    refreshAudit();
  });

  $("up-list").addEventListener("click", async function (e) {
    var b = e.target.closest("[data-delete-update]");
    if (!b) return;
    var id = b.closest("[data-update]").dataset.update;
    if (!confirm("Delete this update? Testers who haven't closed it stop seeing it.")) return;
    b.disabled = true;
    var res = await db.rpc("admin_delete_update", { p_id: id });
    if (res.error) { b.disabled = false; alert(res.error.message); return; }
    state.updates = state.updates.filter(function (u) { return u.id !== id; });
    renderBeta();
    refreshAudit();
  });

  // The Local events mode: the form, and what's coming up.
  function renderEvents() {
    var towns = {};
    state.accounts.forEach(function (a) { if (a.city) towns[a.city.trim()] = true; });
    $("ev-cities").innerHTML = Object.keys(towns).sort().map(function (t) {
      return '<option value="' + esc(t) + '">';
    }).join("");

    var off = state.events === null;
    $("ev-add").disabled = off;
    if (off) {
      $("ev-list").innerHTML = "";
      $("ev-msg").textContent = "Local events work once the site's schema.sql and then portal-admin.sql have been re-run.";
      return;
    }
    var today = ymd(new Date());
    var day = function (s) {
      return new Date(s + "T12:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    };
    var upcoming = state.events.filter(function (ev) { return (ev.ends_on || ev.starts_on) >= today; });
    $("ev-list").innerHTML = upcoming.length ? upcoming.map(function (ev) {
      var when = day(ev.starts_on) + (ev.ends_on ? " – " + day(ev.ends_on) : "");
      var here = ev.city ? state.accounts.filter(function (a) {
        return a.city && a.city.trim().toLowerCase() === ev.city.trim().toLowerCase();
      }).length : null;
      return '<div class="lead-row" data-event="' + esc(ev.id) + '">' +
        '<div class="lead-top"><span class="lead-who"><span class="cell-main">' + esc(ev.name_sr) +
          (ev.name_en ? " · " + esc(ev.name_en) : "") + "</span>" +
          '<span class="cell-sub">' + esc(when + " · offered " + ev.lead_days + " days ahead · " +
            (ev.created_by || "Adronis")) + "</span></span>" +
          '<span class="pill' + (ev.city ? " pill-acc" : "") + '">' + esc(ev.city || "all of " + (ev.country || "Serbia")) + "</span>" +
        "</div>" +
        (ev.idea_sr || ev.idea_en ? '<div class="lead-text">' + esc(ev.idea_sr || ev.idea_en) + "</div>" : "") +
        '<div class="lead-actions">' +
          (here !== null ? '<span class="cell-sub">' + (here === 1 ? "1 account there" : here + " accounts there") + "</span>" : "") +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn-ghost btn-sm btn-danger" data-delete-event>Delete</button></div>' +
      "</div>";
    }).join("") : '<p class="panel-note">No events coming up. Add the next festival or match above.</p>';
  }

  $("ev-from").addEventListener("change", function () {
    $("ev-to").min = $("ev-from").value;
    if ($("ev-to").value && $("ev-to").value < $("ev-from").value) $("ev-to").value = "";
  });

  $("ev-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    $("ev-add").disabled = true;
    $("ev-msg").textContent = "Adding…";
    var res = await db.rpc("admin_add_local_event", {
      p_country: "Serbia",
      p_city: $("ev-city").value.trim() || null,
      p_starts_on: $("ev-from").value,
      p_ends_on: $("ev-to").value || null,
      p_name_sr: $("ev-name-sr").value.trim(),
      p_name_en: $("ev-name-en").value.trim() || null,
      p_idea_sr: $("ev-idea-sr").value.trim() || null,
      p_idea_en: $("ev-idea-en").value.trim() || null,
      p_lead_days: Number($("ev-lead").value) || 14
    });
    $("ev-add").disabled = false;
    if (res.error) { $("ev-msg").textContent = res.error.message; return; }
    ["ev-from", "ev-to", "ev-name-sr", "ev-name-en", "ev-idea-sr", "ev-idea-en"].forEach(function (id) { $(id).value = ""; });
    $("ev-msg").textContent = "Added. It shows in their control room once it's close enough.";
    var fresh = await db.from("local_events").select("*").order("starts_on").limit(500);
    if (!fresh.error) state.events = fresh.data || [];
    renderBeta();
    refreshAudit();
  });

  $("ev-list").addEventListener("click", async function (e) {
    var b = e.target.closest("[data-delete-event]");
    if (!b) return;
    var id = b.closest("[data-event]").dataset.event;
    if (!confirm("Delete this event? It stops showing in control rooms.")) return;
    b.disabled = true;
    var res = await db.rpc("admin_delete_local_event", { p_id: id });
    if (res.error) { b.disabled = false; alert(res.error.message); return; }
    state.events = state.events.filter(function (ev) { return ev.id !== id; });
    renderBeta();
    refreshAudit();
  });

  $("bv-modes").addEventListener("click", function (e) {
    var b = e.target.closest("[data-bv]");
    if (!b) return;
    state.betaView = b.dataset.bv;
    renderBeta();
  });

  // An Email button opens Gmail in a new tab; this notes it alongside.
  // Costs' Pause / Resume switch the ad engine off or on for one account.
  $("bv-list").addEventListener("click", async function (e) {
    var pause = e.target.closest("[data-pause]");
    if (pause) {
      var who = state.accountById[pause.dataset.pause];
      var on = pause.dataset.on === "1";
      var note = null;
      if (on) {
        note = window.prompt("Pause the ad engine for " + ((who && who.business_name) || "this tester") +
          "? No new ads are made for them until you resume. A note on why (only we see it):", "Over the weekly cost cap");
        if (note === null) return;
      }
      pause.disabled = true;
      var res = await db.rpc("admin_set_engine_pause", { p_user: pause.dataset.pause, p_paused: on, p_note: note });
      if (res.error) {
        pause.disabled = false;
        alert(/admin_set_engine_pause/.test(res.error.message)
          ? "Re-run portal-admin.sql first — the pause switch isn't in the database yet."
          : res.error.message);
        return;
      }
      if (who && res.data) Object.assign(who, { engine_paused_at: res.data.engine_paused_at, engine_pause_note: res.data.engine_pause_note });
      renderBeta();
      renderToday();
      refreshAudit();
      return;
    }
    var link = e.target.closest("a[data-contact]");
    if (!link) return;
    var user = link.dataset.user, kind = link.dataset.contact;
    var c = state.contacts[user] = state.contacts[user] || {};
    c[kind] = { at: new Date().toISOString(), by: state.user.email };
    db.rpc("admin_note_contact", { p_user: user, p_kind: kind }).then(function () {
      refreshAudit();
    }, function () {});
    setTimeout(renderBeta, 0);
  });

  // ----------------------------------------------------------------- sales
  //
  // Before an account exists. The demo: what visitors did in the public
  // demo over 30 days (demo_events, from the site's demo.js). The list: the
  // businesses we walk into or write to (prospects), each with a stage and
  // a next step. A business that has since signed up is linked to its
  // account by email or Instagram, and its stage follows the account.

  var STAGES = [
    { id: "contacted", label: "Contacted" },
    { id: "demo", label: "Saw the demo" },
    { id: "applied", label: "Applied" },
    { id: "in_beta", label: "In the beta" },
    { id: "not_now", label: "Not now" }
  ];
  var STAGE_LABEL = {};
  STAGES.forEach(function (s) { STAGE_LABEL[s.id] = s.label; });

  // The demo link to hand out: straight into it (the short /demo drops
  // ?src=), marked with where it was handed out.
  function demoLink(src) {
    return SITE_URL + "/approvals.html?demo=1" + (src ? "&src=" + src : "");
  }

  // A business's own links (prospects.code, from portal-admin.sql): the demo
  // with its name on it, its proposal, and the date calendar. The short
  // /d/, /p/ and /k/ forms are redirects in the site's vercel.json.
  function personalLinks(p) {
    if (!p.code) return null;
    return {
      demo: SITE_URL + "/d/" + p.code,
      proposal: SITE_URL + "/p/" + p.code,
      calendar: SITE_URL + "/k/" + p.code
    };
  }

  // What each business did with its own links, from the last 30 days of
  // demo_events: visits per page, and when it last opened one.
  function indexOpens(events) {
    var by = {};
    (events || []).forEach(function (e) {
      if (!e.code) return;
      var o = by[e.code] = by[e.code] || { demo: {}, proposal: {}, calendar: {}, last: null };
      var kind = e.event === "open" ? "demo" : e.event === "proposal" ? "proposal" : e.event === "calendar" ? "calendar" : null;
      if (kind) o[kind][e.visit] = true;
      if (!o.last || e.created_at > o.last) o.last = e.created_at;
    });
    Object.keys(by).forEach(function (k) {
      ["demo", "proposal", "calendar"].forEach(function (kind) { by[k][kind] = Object.keys(by[k][kind]).length; });
    });
    return by;
  }

  function opensOf(p) {
    return (p.code && state.opens[p.code]) || null;
  }

  function opensLine(p) {
    if (!p.code || !state.demoEvents) return "";
    var o = opensOf(p);
    var parts = o ? [["demo", o.demo], ["proposal", o.proposal], ["calendar", o.calendar]]
      .filter(function (x) { return x[1]; })
      .map(function (x) { return x[0] + (x[1] > 1 ? " " + x[1] + "×" : ""); }) : [];
    return '<div class="sl-next sl-opens' + (parts.length ? " is-on" : "") + '"><span class="mono">OPENED</span> ' +
      (parts.length ? esc(parts.join(" · ")) + " · last " + esc(relDays(o.last))
                    : "nothing from their links yet") + "</div>";
  }

  // "@kafeterija.kutak", "instagram.com/kafeterija.kutak/" and
  // "https://www.instagram.com/kafeterija.kutak?igsh=..." all read the same.
  function handle(s) {
    return String(s || "").trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/^instagram\.com\//, "")
      .replace(/^@/, "").replace(/[/?#].*$/, "");
  }

  function prospectAccount(p) {
    var mail = String(p.email || "").trim().toLowerCase();
    var ig = handle(p.instagram);
    return state.accounts.filter(function (a) {
      return (mail && String(a.email || "").toLowerCase() === mail) || (ig && handle(a.website) === ig);
    })[0] || null;
  }

  // The stage shown: the account's, once there is one - and "saw the
  // demo" once they opened the one made for them.
  function prospectStage(p, acct) {
    if (acct && betaOn(acct)) return "in_beta";
    if (acct) return "applied";
    var o = opensOf(p);
    if (p.stage === "contacted" && o && o.demo) return "demo";
    return p.stage;
  }

  function prospectDue(p) {
    return !!p.next_at && p.next_at <= ymd(new Date()) &&
      ["in_beta", "not_now"].indexOf(prospectStage(p, prospectAccount(p))) === -1;
  }

  function renderDemoCounts() {
    var ev = state.demoEvents;
    if (!ev) {
      $("sl-demo").innerHTML = "";
      $("sl-demo-note").textContent = "The demo's numbers appear once the site's schema.sql and then portal-admin.sql have been re-run.";
      return;
    }
    function visits(test) {
      var seen = {};
      ev.forEach(function (e) { if (test(e)) seen[e.visit] = true; });
      return Object.keys(seen).length;
    }
    var opened = visits(function (e) { return e.event === "open"; });
    var tried = visits(function (e) { return e.event === "approve" || e.event === "reject"; });
    var joined = visits(function (e) { return e.event === "join"; });
    var share = function (n) { return opened ? Math.round((n / opened) * 100) : 0; };
    $("sl-demo").innerHTML = [
      { k: "Opened", v: opened, sub: "visits to the demo" },
      { k: "Tried it", v: tried, sub: share(tried) + "% approved or rejected an ad" },
      { k: "Control room", v: visits(function (e) { return e.event === "control_room"; }), sub: "went on to look at it" },
      { k: "Join the beta", v: joined, sub: share(joined) + "% clicked through to sign up" }
    ].map(function (x) {
      return '<div class="tile"><div class="tile-k">' + esc(x.k) + '</div><div class="tile-v">' + esc(x.v) +
             '</div><div class="tile-sub">' + esc(x.sub) + "</div></div>";
    }).join("");

    // Where the visits came from, by ?src=.
    var bySrc = {};
    ev.forEach(function (e) {
      if (e.event !== "open") return;
      var k = e.src || "direct";
      (bySrc[k] = bySrc[k] || {})[e.visit] = true;
    });
    var names = { card: "the QR card", dm: "messages", proposal: "proposals", calendar: "the date calendar", direct: "a link with no source" };
    var parts = Object.keys(bySrc).sort(function (a, b) {
      return Object.keys(bySrc[b]).length - Object.keys(bySrc[a]).length;
    }).map(function (k) { return Object.keys(bySrc[k]).length + " from " + (names[k] || k); });
    var personal = {};
    ev.forEach(function (e) { if (e.event === "open" && e.code) personal[e.visit] = true; });
    var calendar = visits(function (e) { return e.event === "calendar"; });
    $("sl-demo-note").textContent = (parts.length
      ? "Opened " + parts.join(", ") + "."
      : "Nobody has opened the demo in the last 30 days.") +
      (Object.keys(personal).length ? " " + Object.keys(personal).length + " of them through a business's own link." : "") +
      (calendar ? " The date calendar was opened " + calendar + " time" + (calendar === 1 ? "" : "s") + "." : "") +
      " Each visit counts once, however many times it clicks.";
  }

  // The first message to a business, with the demo made for it when it has
  // one.
  function introMessage(p) {
    var links = personalLinks(p);
    return "Zdravo! Pišem iz Adronisa — pravimo oglase za lokale svake nedelje, a vi ih samo odobrite " +
      "na telefonu i mi ih objavimo. Trenutno biramo nekoliko lokala za besplatnu betu.\n\n" +
      (links ? "Napravili smo primer za " + p.name + ", bez prijave: " + links.demo
             : "Ovako izgleda, bez prijave: " + demoLink("dm")) + "\n\n" +
      "Ako vam se svidi, prijava traje oko 10 minuta: " + SITE_URL + "/signup.html";
  }

  // After a visit or a call: the proposal, with everything talked about.
  function proposalMessage(p) {
    return "Hvala na razgovoru! Evo predloga za " + p.name + " — šta dobijate u beti, kako počinje i koliko " +
      "košta posle: " + personalLinks(p).proposal + "\n\n" +
      "Ako imate pitanja, samo odgovorite na ovu poruku.";
  }

  // A quick review of their Instagram, typed in from what we saw.
  function reviewMessage(p) {
    return "Zdravo! Pogledali smo Instagram profil lokala " + p.name + " i napravili kratak pregled — šta radi " +
      "dobro, šta bi moglo bolje, i savet za svaku stavku. Besplatno je, bez obaveze: " + SITE_URL + "/r/" + p.code;
  }

  // Something useful before anything is asked for: the dates worth an ad.
  function calendarMessage(p) {
    var links = personalLinks(p);
    return "Zdravo! Napravili smo kalendar za lokale: svi datumi u narednih 12 meseci kad se isplati objaviti " +
      "nešto — Dan zaljubljenih, Vaskrs, slave, mature i ostalo, uz ideju za oglas i kada da ga objavite. " +
      "Besplatno je, bez prijave: " + links.calendar + "\n\n" +
      "Ako vam zatreba da neko te oglase pravi umesto vas, to radimo u Adronisu: " + links.demo;
  }

  function renderSales() {
    renderDemoCounts();

    var all = state.prospects;
    var due = (all || []).filter(prospectDue).length;
    $("sl-badge").textContent = due;
    $("sl-badge").hidden = !due;

    if (!all) {
      $("sl-list").innerHTML = "";
      $("sl-count").textContent = "";
      $("sl-add").disabled = true;
      $("sl-empty").textContent = "The list appears once portal-admin.sql has been re-run.";
      $("sl-empty").hidden = false;
      return;
    }
    $("sl-add").disabled = false;

    var q = $("sl-search").value.trim().toLowerCase();
    var st = $("sl-stage").value;
    var rows = all.map(function (p) {
      var acct = prospectAccount(p);
      return { p: p, acct: acct, stage: prospectStage(p, acct) };
    }).filter(function (x) {
      if (st === "open" && ["contacted", "demo", "applied"].indexOf(x.stage) === -1) return false;
      if (st === "due" && !prospectDue(x.p)) return false;
      if (st && st !== "open" && st !== "due" && x.stage !== st) return false;
      if (q) {
        var p = x.p;
        var hay = [p.name, p.place, p.instagram, p.email, p.phone, p.note, p.next_step].join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).sort(function (x, y) {
      // Whatever is due soonest first; nothing planned goes last, newest first.
      var a = x.p.next_at || "9999", b = y.p.next_at || "9999";
      if (a !== b) return a < b ? -1 : 1;
      return new Date(y.p.updated_at) - new Date(x.p.updated_at);
    });

    $("sl-count").textContent = rows.length + " of " + all.length + (due ? " · " + due + " due" : "");
    $("sl-empty").textContent = all.length
      ? "Nothing here with those filters."
      : "No businesses yet. Add the first one you walk into or write to.";
    $("sl-empty").hidden = rows.length > 0;

    $("sl-list").innerHTML = rows.map(function (x) {
      var p = x.p, acct = x.acct;
      var sub = [p.place, p.instagram, p.phone, p.email].filter(Boolean).join(" · ");
      var isDue = prospectDue(p);
      var next = p.next_step || p.next_at
        ? '<div class="sl-next' + (isDue ? " is-due" : "") + '"><span class="mono">NEXT</span> ' +
            esc(p.next_step || "—") + (p.next_at ? " · " + esc(fmtDate(p.next_at + "T12:00")) +
            " (" + esc(relDays(p.next_at + "T12:00")) + ")" : "") + "</div>"
        : "";
      return '<div class="lead-row' + (isDue ? " is-new" : "") + '" data-prospect="' + esc(p.id) + '">' +
        '<div class="lead-top">' +
          '<span class="lead-who"><span class="cell-main">' + esc(p.name) + "</span>" +
            '<span class="cell-sub">' + esc(sub || "no details yet") + "</span></span>" +
          '<span class="pill' + (x.stage === "in_beta" ? " pill-active" : x.stage === "not_now" ? " pill-canceled" : " pill-acc") + '">' +
            esc(STAGE_LABEL[x.stage] || x.stage) + "</span>" +
        "</div>" +
        next +
        opensLine(p) +
        (p.note ? '<div class="lead-text">' + esc(p.note) + "</div>" : "") +
        '<div class="lead-actions">' +
          (acct
            ? '<span class="panel-note">Signed up ' + esc(relDays(acct.created_at)) + " as " + esc(acct.email) + "</span>"
            : '<div class="lead-status sl-stages" role="group" aria-label="Stage">' +
                STAGES.map(function (s) {
                  return '<button type="button" class="mode' + (p.stage === s.id ? " is-on" : "") +
                    '" data-stage="' + s.id + '">' + esc(s.label) + "</button>";
                }).join("") +
              "</div>") +
          '<span class="spacer"></span>' +
          (acct ? '<button type="button" class="btn-ghost btn-sm" data-open="' + esc(acct.id) + '">Open account</button>' : "") +
          '<button type="button" class="btn-ghost btn-sm" data-intro>Copy intro message</button>' +
          (p.code
            ? '<button type="button" class="btn-ghost btn-sm" data-calendar>Copy calendar message</button>' +
              '<button type="button" class="btn-ghost btn-sm" data-proposal>Copy proposal message</button>' +
              '<a class="btn-ghost btn-sm" href="' + esc(personalLinks(p).proposal) + '" target="_blank" rel="noopener">See proposal</a>' +
              (p.review
                ? '<button type="button" class="btn-ghost btn-sm" data-review>Copy review message</button>' +
                  '<a class="btn-ghost btn-sm" href="' + esc(SITE_URL + "/r/" + p.code) + '" target="_blank" rel="noopener">See review</a>'
                : "")
            : "") +
          '<button type="button" class="btn-ghost btn-sm" data-edit>Edit</button>' +
          '<button type="button" class="btn-ghost btn-sm btn-danger" data-delete>Delete</button>' +
        "</div>" +
      "</div>";
    }).join("");
  }

  function prospectById(id) {
    return (state.prospects || []).filter(function (p) { return p.id === id; })[0] || null;
  }

  function openForm(p) {
    state.editing = p ? p.id : "new";
    $("sl-form-title").textContent = p ? "Edit " + p.name : "Add a business";
    $("sl-name").value = p ? p.name : "";
    $("sl-place").value = (p && p.place) || "";
    $("sl-ig").value = (p && p.instagram) || "";
    $("sl-email").value = (p && p.email) || "";
    $("sl-phone").value = (p && p.phone) || "";
    $("sl-form-stage").value = p ? p.stage : "contacted";
    $("sl-next").value = (p && p.next_step) || "";
    $("sl-next-at").value = (p && p.next_at) || "";
    $("sl-note").value = (p && p.note) || "";
    $("sl-plan").value = (p && p.plan) || "counter";
    $("sl-pitch").value = (p && p.pitch) || "";
    var rv = (p && p.review) || {};
    $("sl-rv-last").value = rv.last_post || "";
    $("sl-rv-month").value = typeof rv.per_month === "number" ? rv.per_month : "";
    $("sl-rv-photos").value = rv.photos || "";
    $("sl-rv-bio").checked = rv.bio === true;
    $("sl-rv-video").checked = rv.video === true;
    var picked = (p && p.channels) || [];
    Array.prototype.forEach.call(document.querySelectorAll("#sl-channels input"), function (box) {
      box.checked = picked.indexOf(box.value) > -1;
    });
    limitChannels();
    $("sl-form-msg").textContent = "";
    $("sl-form").hidden = false;
    $("sl-form").scrollIntoView({ block: "start", behavior: "smooth" });
    $("sl-name").focus({ preventScroll: true });
  }

  function closeForm() {
    state.editing = null;
    $("sl-form").hidden = true;
  }

  function upsertProspect(row) {
    var found = false;
    state.prospects = state.prospects.map(function (p) {
      if (p.id !== row.id) return p;
      found = true;
      return row;
    });
    if (!found) state.prospects.unshift(row);
  }

  // What we saw on their Instagram, for the review page. Nothing typed in:
  // no review. The two ticks only count once something else is filled in,
  // since an untouched box can't tell "no" from "didn't look".
  function readReview() {
    var last = $("sl-rv-last").value;
    var month = $("sl-rv-month").value;
    var photos = $("sl-rv-photos").value;
    if (!last && month === "" && !photos) return null;
    var r = { checked_at: ymd(new Date()), bio: $("sl-rv-bio").checked, video: $("sl-rv-video").checked };
    if (last) r.last_post = last;
    if (month !== "") r.per_month = Math.max(0, Math.round(Number(month)));
    if (photos) r.photos = photos;
    return r;
  }

  // The beta gives four networks, so the proposal offers no more.
  function limitChannels() {
    var boxes = document.querySelectorAll("#sl-channels input");
    var on = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).length;
    Array.prototype.forEach.call(boxes, function (b) { b.disabled = !b.checked && on >= 4; });
  }
  $("sl-channels").addEventListener("change", limitChannels);

  $("sl-add").addEventListener("click", function () { openForm(null); });
  $("sl-cancel").addEventListener("click", closeForm);
  ["sl-search", "sl-stage"].forEach(function (id) { $(id).addEventListener("input", renderSales); });

  $("sl-copy-demo").addEventListener("click", function () {
    copyText(demoLink("dm"), $("sl-copy-demo"));
  });

  $("sl-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var val = function (id) { return $(id).value.trim() || null; };
    var row = {
      name: $("sl-name").value.trim(),
      place: val("sl-place"),
      instagram: val("sl-ig"),
      email: val("sl-email"),
      phone: val("sl-phone"),
      stage: $("sl-form-stage").value,
      next_step: val("sl-next"),
      next_at: $("sl-next-at").value || null,
      note: val("sl-note")
    };
    var offer = {
      channels: Array.prototype.filter.call(document.querySelectorAll("#sl-channels input"), function (b) { return b.checked; })
        .map(function (b) { return b.value; }),
      plan: $("sl-plan").value,
      pitch: val("sl-pitch"),
      review: readReview()
    };
    if (!row.name) return;
    $("sl-save").disabled = true;
    $("sl-form-msg").textContent = "Saving…";
    function save(fields) {
      return state.editing === "new"
        ? db.from("prospects").insert(Object.assign({}, fields, { created_by: state.user.email })).select().single()
        : db.from("prospects").update(fields).eq("id", state.editing).select().single();
    }
    var res = await save(Object.assign({}, row, offer));
    // Before portal-admin.sql is re-run the offer's columns aren't there:
    // keep the rest, and say why the offer didn't save.
    var noOffer = res.error && /schema cache|column/i.test(res.error.message);
    if (noOffer) res = await save(row);
    $("sl-save").disabled = false;
    if (res.error) {
      $("sl-form-msg").textContent = res.error.message;
      return;
    }
    if (noOffer) alert("Saved, but not the proposal and the Instagram review: re-run portal-admin.sql for those.");
    upsertProspect(res.data);
    closeForm();
    renderSales();
  });

  $("sl-list").addEventListener("click", async function (e) {
    var rowEl = e.target.closest("[data-prospect]");
    var p = rowEl && prospectById(rowEl.dataset.prospect);
    if (!p) return;
    var b;

    if ((b = e.target.closest("[data-intro]"))) { copyText(introMessage(p), b); return; }
    if ((b = e.target.closest("[data-calendar]"))) { copyText(calendarMessage(p), b); return; }
    if ((b = e.target.closest("[data-proposal]"))) { copyText(proposalMessage(p), b); return; }
    if ((b = e.target.closest("[data-review]"))) { copyText(reviewMessage(p), b); return; }
    if (e.target.closest("[data-edit]")) { openForm(p); return; }

    if ((b = e.target.closest("[data-delete]"))) {
      if (!confirm("Delete " + p.name + " from the list? Its notes go with it.")) return;
      b.disabled = true;
      var del = await db.from("prospects").delete().eq("id", p.id);
      if (del.error) { b.disabled = false; alert(del.error.message); return; }
      state.prospects = state.prospects.filter(function (x) { return x.id !== p.id; });
      if (state.editing === p.id) closeForm();
      renderSales();
      return;
    }

    if ((b = e.target.closest("[data-stage]"))) {
      if (b.classList.contains("is-on")) return;
      Array.prototype.forEach.call(b.parentNode.children, function (x) { x.disabled = true; });
      var res = await db.from("prospects").update({ stage: b.dataset.stage }).eq("id", p.id).select().single();
      if (res.error) {
        Array.prototype.forEach.call(b.parentNode.children, function (x) { x.disabled = false; });
        alert(res.error.message);
        return;
      }
      upsertProspect(res.data);
      renderSales();
    }
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
    $("pq-feedback").hidden = state.adsView !== "feedback";

    renderQueue();
    renderPosted();
    renderWeek();
    renderFeedback();
  }

  // ---- what to fix: every tester's feedback on the ads, together
  //
  // Why ads were turned down (the reason and the tester's own note), the
  // text they rewrote before approving, and their "never" lists - the
  // material for the engine's prompts. The weekly numbers count it; this is
  // what it says.

  function feedbackData() {
    var days = Number($("fb-range").value) || 28;
    var since = Date.now() - days * 86400000;
    var who = $("fb-who").value;
    var ads = adList().filter(function (c) {
      return (!who || c.user_id === who) && new Date(c.updated_at || c.created_at).getTime() >= since;
    });
    var rejected = ads.filter(function (c) { return c.status === "rejected"; });
    var reasons = {};
    rejected.forEach(function (c) { var k = c.reject_reason || "none"; reasons[k] = (reasons[k] || 0) + 1; });
    var notes = rejected.filter(function (c) { return c.reject_note; })
      .sort(function (x, y) { return new Date(y.updated_at) - new Date(x.updated_at); });
    var edits = ads.filter(function (c) {
      return c.edited_at && ((c.original_headline || "") !== (c.headline || "") || (c.original_caption || "") !== (c.caption || ""));
    }).sort(function (x, y) { return new Date(y.edited_at) - new Date(x.edited_at); });
    var decided = ads.filter(function (c) {
      return ["approved", "published", "rejected"].indexOf(c.status) > -1 && !c.auto_approved_at;
    }).length;
    var accounts = (state.sample ? Object.keys(state.sample.accounts).map(function (id) { return state.sample.accounts[id]; })
      : state.accounts.filter(betaOn)).filter(function (a) { return !who || a.id === who; });
    var avoid = accounts.map(function (a) { return { a: a, text: avoidText(a) }; })
      .filter(function (x) { return x.text; });
    return { days: days, ads: ads, rejected: rejected, reasons: reasons, notes: notes, edits: edits,
             decided: decided, avoid: avoid };
  }

  function renderFeedback() {
    // Whose ads: anyone with ads in what the tab loaded.
    var picked = $("fb-who").value;
    var ids = adList().map(function (c) { return c.user_id; })
      .filter(function (id, i, all) { return all.indexOf(id) === i; });
    $("fb-who").innerHTML = '<option value="">Every tester</option>' + ids.map(function (id) {
      var a = adAccount(id);
      return { id: id, name: a.business_name || a.email || "Unnamed business" };
    }).sort(function (x, y) { return x.name.localeCompare(y.name); }).map(function (x) {
      return '<option value="' + esc(x.id) + '"' + (x.id === picked ? " selected" : "") + ">" + esc(x.name) + "</option>";
    }).join("");

    var f = feedbackData();
    var top = reasonList(f.reasons)[0];
    $("fb-tiles").innerHTML = [
      { k: "Turned down", v: f.rejected.length, sub: pct(f.rejected.length, f.decided) + " of the ads they decided" },
      { k: "Mostly", v: top ? top.label : "—", sub: top ? top.n + " of " + f.rejected.length : "nothing turned down" },
      { k: "Notes written", v: f.notes.length, sub: "in their own words" },
      { k: "Rewritten", v: f.edits.length, sub: "approved after editing the text" }
    ].map(function (x) {
      return '<div class="tile"><div class="tile-k">' + esc(x.k) + '</div><div class="tile-v">' + esc(x.v) +
             '</div><div class="tile-sub">' + esc(x.sub) + "</div></div>";
    }).join("");

    var reasons = reasonList(f.reasons);
    $("fb-reasons-panel").hidden = !reasons.length;
    var max = Math.max.apply(null, reasons.map(function (r) { return r.n; }).concat([1]));
    $("fb-reasons").innerHTML = reasons.map(function (r) {
      return '<div class="mix-row"><span class="mix-name">' + esc(r.label) + "</span>" +
             '<span class="mix-track"><span class="mix-fill" style="width:' + ((r.n / max) * 100).toFixed(1) + '%"></span></span>' +
             '<span class="mix-n">' + esc(r.n) + "</span></div>";
    }).join("");

    $("fb-notes-panel").hidden = !f.notes.length;
    $("fb-notes-count").textContent = f.notes.length;
    $("fb-notes").innerHTML = f.notes.map(function (c) {
      var a = adAccount(c.user_id);
      return '<div class="fb-quote">“' + esc(c.reject_note) + "”" +
        '<span class="cell-sub">' + esc([a.business_name || a.email, REASON_LABEL[c.reject_reason] || "no reason picked",
          c.channel, c.headline ? "on “" + c.headline + "”" : null, relDays(c.updated_at)].filter(Boolean).join(" · ")) + "</span></div>";
    }).join("");

    $("fb-edits-panel").hidden = !f.edits.length;
    $("fb-edits-count").textContent = f.edits.length;
    $("fb-edits").innerHTML = f.edits.map(function (c) {
      var a = adAccount(c.user_id);
      var lines = "";
      if ((c.original_headline || "") !== (c.headline || "")) {
        lines += '<div class="fb-edit"><s>' + esc(c.original_headline || "—") + "</s><span>" + esc(c.headline || "—") + "</span></div>";
      }
      if ((c.original_caption || "") !== (c.caption || "")) {
        lines += '<div class="fb-edit" style="margin-top:6px"><s>' + esc(c.original_caption || "—") + "</s><span>" + esc(c.caption || "—") + "</span></div>";
      }
      return '<div class="fb-quote">' + lines +
        '<span class="cell-sub">' + esc([a.business_name || a.email, c.channel, relDays(c.edited_at)].filter(Boolean).join(" · ")) + "</span></div>";
    }).join("");

    $("fb-avoid-panel").hidden = !f.avoid.length;
    $("fb-avoid").innerHTML = f.avoid.map(function (x) {
      return '<div class="fb-quote">' + esc(x.text) + '<span class="cell-sub">' + esc(x.a.business_name || x.a.email || "") + "</span></div>";
    }).join("");

    $("fb-empty").hidden = !!(f.rejected.length || f.edits.length || f.avoid.length);
  }

  // The same as plain text, to paste beside the engine's prompts.
  function feedbackText() {
    var f = feedbackData();
    var lines = ["Adronis — tester feedback on the ads, last " + f.days + " days", ""];
    var reasons = reasonList(f.reasons);
    lines.push("Turned down: " + f.rejected.length + " of " + f.decided + " ads decided" +
      (reasons.length ? " — " + reasons.map(function (r) { return r.label.toLowerCase() + " " + r.n; }).join(", ") : ""));
    if (f.notes.length) {
      lines.push("", "Why, in their words:");
      f.notes.forEach(function (c) {
        var a = adAccount(c.user_id);
        lines.push("- " + (a.business_name || a.email) + " (" + (a.vertical || "business") + ", " +
          (REASON_LABEL[c.reject_reason] || "no reason").toLowerCase() + "): \"" + c.reject_note + "\"" +
          (c.headline ? " — the ad: \"" + c.headline + "\"" : ""));
      });
    }
    if (f.edits.length) {
      lines.push("", "Text they rewrote before approving (was -> now):");
      f.edits.forEach(function (c) {
        var a = adAccount(c.user_id);
        if ((c.original_headline || "") !== (c.headline || "")) {
          lines.push("- " + (a.business_name || a.email) + " headline: \"" + (c.original_headline || "") + "\" -> \"" + (c.headline || "") + "\"");
        }
        if ((c.original_caption || "") !== (c.caption || "")) {
          lines.push("- " + (a.business_name || a.email) + " caption: \"" + (c.original_caption || "") + "\" -> \"" + (c.caption || "") + "\"");
        }
      });
    }
    if (f.avoid.length) {
      lines.push("", "What they told us never to do:");
      f.avoid.forEach(function (x) { lines.push("- " + (x.a.business_name || x.a.email) + ": " + x.text); });
    }
    return lines.join("\n");
  }

  ["fb-range", "fb-who"].forEach(function (id) { $(id).addEventListener("input", renderFeedback); });
  $("fb-copy").addEventListener("click", function () { copyText(feedbackText(), $("fb-copy")); });

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
      (c.edited_at ? '<span class="pq-note">The customer edited this text before approving it.</span>' : "") +
      (c.auto_approved_at ? '<span class="pq-note">Approved automatically — it waited 48 hours and the customer has auto-approve on.</span>' : "");
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
                (c.rescheduled_at ? '<span class="pq-note">The customer picked this time.</span>' : "") +
                (closedOn(adAccount(c.user_id), c.scheduled_at)
                  ? '<span class="pq-note pq-warn">They told us they\'re closed that day' +
                      (closedOn(adAccount(c.user_id), c.scheduled_at).note ? " (" + esc(closedOn(adAccount(c.user_id), c.scheduled_at).note) + ")" : "") +
                      " — check with them before posting, or post it on a day they're open.</span>"
                  : "")
              : '<span class="pq-rel">No posting time yet — post it when it suits the channel.</span>' +
                (closedRanges(adAccount(c.user_id)).length
                  ? '<span class="pq-note pq-warn">Closed: ' + esc(closedText(adAccount(c.user_id))) + ".</span>"
                  : "")) +
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
      var n = { delivered: list.length, approved: 0, rejected: 0, waiting: 0, expired: 0, posted: 0, onTime: 0, toPost: 0, overdue: 0, edited: 0 };
      list.forEach(function (c) {
        if (c.status === "approved" || c.status === "published") n.approved++;
        if (c.status === "rejected") n.rejected++;
        if (c.status === "pending") n.waiting++;
        if (c.status === "expired") n.expired++;
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
      { k: "Waiting on customers", v: t.waiting, sub: t.expired ? t.expired + " expired unanswered" : "not approved or rejected yet" },
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
        '<td class="num" data-label="Waiting">' + n.waiting +
          (n.expired ? '<span class="cell-sub">' + n.expired + " expired</span>" : "") + "</td>" +
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
        t.rejected + ", still waiting on customers " + t.waiting + (t.expired ? ", expired unanswered " + t.expired : ""),
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

  // ---- the posting schedule as a calendar file
  //
  // Every approved ad with a time still ahead, as an event with a reminder
  // 15 minutes before, so whoever posts by hand gets nudged by their phone.
  // Each event keeps the ad's id, so opening a newer file updates the same
  // events in most calendars rather than adding them twice.

  function icsText(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n");
  }

  function icsTime(d) {
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }

  // Lines over 75 characters continue on the next line after a space.
  function icsFold(line) {
    var out = [];
    while (line.length > 74) {
      out.push(line.slice(0, 74));
      line = " " + line.slice(74);
    }
    out.push(line);
    return out.join("\r\n");
  }

  function postingCalendar() {
    var now = Date.now();
    var portal = location.origin + location.pathname;
    var ads = adList().filter(function (c) {
      return c.status === "approved" && c.scheduled_at && new Date(c.scheduled_at).getTime() > now;
    });
    var lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Adronis//Portal//EN",
      "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Adronis — objave"
    ];
    ads.forEach(function (c) {
      var a = adAccount(c.user_id);
      var start = new Date(c.scheduled_at);
      lines.push(
        "BEGIN:VEVENT",
        "UID:" + c.id + "@adronis-portal",
        "DTSTAMP:" + icsTime(new Date()),
        "DTSTART:" + icsTime(start),
        "DTEND:" + icsTime(new Date(start.getTime() + 15 * 60000)),
        "SUMMARY:" + icsText("Objavi: " + (a.business_name || "oglas") + " · " + (c.channel || "")),
        "DESCRIPTION:" + icsText([c.headline, c.caption, "Tekst, slika i Mark posted: " + portal]
          .filter(Boolean).join("\n\n")),
        "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M",
        "DESCRIPTION:" + icsText("Objava za 15 minuta: " + (a.business_name || "")),
        "END:VALARM",
        "END:VEVENT"
      );
    });
    lines.push("END:VCALENDAR");
    return { text: lines.map(icsFold).join("\r\n") + "\r\n", count: ads.length };
  }

  $("aq-ics").addEventListener("click", function () {
    var cal = postingCalendar();
    if (!cal.count) {
      alert("Nothing is scheduled ahead yet - the file would be empty.");
      return;
    }
    var href = URL.createObjectURL(new Blob([cal.text], { type: "text/calendar;charset=utf-8" }));
    var link = document.createElement("a");
    link.href = href;
    link.download = "adronis-objave.ics";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(href); }, 5000);
    flashLabel($("aq-ics"), cal.count + " post" + (cal.count === 1 ? "" : "s") + " in the file");
  });

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
    } else if (l.action === "emailed") {
      what = "<b>opened an email</b>  " + esc({
        ready: "reminder before Monday", quiet: "gone-quiet nudge", launch: "launch offer"
      }[l.changes.kind] || l.changes.kind);
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
    } else if (l.action === "update_posted" || l.action === "update_deleted") {
      what = "<b>" + (l.action === "update_posted" ? "posted an update" : "deleted an update") + "</b>  " +
             (l.target_user ? "for this tester" : "for every tester") + "\n" + esc(l.changes.body || "");
    } else if (l.action === "local_event_added" || l.action === "local_event_deleted") {
      what = "<b>" + (l.action === "local_event_added" ? "added a local event" : "deleted a local event") + "</b>  " +
             esc(l.changes.name || "") +
             (l.changes.starts_on ? " · " + esc(l.changes.starts_on) : "") +
             (l.action === "local_event_added" ? " · " + esc(l.changes.city || "all of Serbia") : "");
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

  // ----------------------------------------------------------------- today
  //
  // The day's list, from everything else the portal knows: ads to post,
  // businesses that just opened their links, follow-ups that are due,
  // testers gone quiet, applications, ratings and messages. Most items go
  // away by themselves once done (the ad is marked posted, the email noted,
  // the next step moved); "Done for today" hides the rest on this device
  // until tomorrow.

  function doneKey() { return "pt-today-" + ymd(new Date()); }
  function doneToday() {
    try { return JSON.parse(localStorage.getItem(doneKey()) || "[]"); } catch (e) { return []; }
  }
  function markDone(id) {
    try {
      var list = doneToday();
      list.push(id);
      localStorage.setItem(doneKey(), JSON.stringify(list));
    } catch (e) {}
  }
  function clock(iso) {
    return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  function todayItems() {
    var items = [];
    var end = new Date();
    end.setHours(23, 59, 59, 999);

    // Ads due today or late, soonest first.
    state.creatives.filter(function (c) {
      return c.status === "approved" && c.scheduled_at && new Date(c.scheduled_at) <= end;
    }).sort(function (x, y) { return new Date(x.scheduled_at) - new Date(y.scheduled_at); }).forEach(function (c) {
      var a = state.accountById[c.user_id] || {};
      var late = overdue(c);
      items.push({ id: "post-" + c.id, kind: late ? "LATE" : "POST", urgent: late,
        title: clock(c.scheduled_at) + " · " + (a.business_name || a.email || "") + " · " + c.channel,
        sub: (late ? relTime(c.scheduled_at) + " · " : "") + (c.headline || ""),
        go: "posting", label: "Open in Ads" });
    });

    // Businesses that opened their own links in the last two days.
    var hot = {};
    (state.prospects || []).forEach(function (p) {
      var o = opensOf(p);
      var st = prospectStage(p, prospectAccount(p));
      if (!o || !o.last || Date.now() - new Date(o.last) > 2 * 86400000 || ["in_beta", "not_now"].indexOf(st) > -1) return;
      hot[p.id] = true;
      var what = [["demo", o.demo], ["proposal", o.proposal], ["calendar", o.calendar]]
        .filter(function (x) { return x[1]; }).map(function (x) { return x[0]; }).join(", ");
      items.push({ id: "hot-" + p.id + "-" + o.last, kind: "WARM",
        title: p.name + " opened their " + (what || "links") + " " + (relDays(o.last) === "today" ? "today" : relDays(o.last)),
        sub: "A good moment to get in touch" + (p.phone ? " · " + p.phone : p.instagram ? " · " + p.instagram : ""),
        go: "sales", label: "Open in Sales" });
    });

    // Follow-ups that are due.
    (state.prospects || []).filter(prospectDue).forEach(function (p) {
      if (hot[p.id]) return;
      items.push({ id: "due-" + p.id + "-" + p.next_at, kind: "FOLLOW UP",
        title: p.name + (p.next_step ? " — " + p.next_step : ""),
        sub: "due " + relDays(p.next_at + "T12:00") + (p.phone ? " · " + p.phone : ""),
        go: "sales", label: "Open in Sales" });
    });

    // Testers gone quiet, unless one of us wrote in the last three days.
    state.accounts.filter(betaOn).forEach(function (a) {
      var q = quietness(a);
      var c = (state.contacts[a.id] || {}).quiet;
      if (!q || (c && Date.now() - new Date(c.at) < 3 * 86400000)) return;
      items.push({ id: "quiet-" + a.id, kind: "GONE QUIET",
        title: (a.business_name || a.email) + " has gone quiet",
        sub: q.reasons.join("; "),
        mail: quietMail(a, q), user: a.id, label: q.waiting ? "Email: ads are waiting" : "Email: how's it going?" });
    });

    // Applications, best fit first.
    var applied = state.accounts.filter(function (a) { return a.beta_applied_at && !betaOn(a); });
    if (applied.length) {
      var top = applied.map(function (a) { return { a: a, s: appScore(a) }; })
        .sort(function (x, y) { return y.s.total - x.s.total; })[0];
      items.push({ id: "apps-" + applied.length, kind: "APPLICATIONS",
        title: applied.length + " application" + (applied.length === 1 ? "" : "s") + " waiting",
        sub: "Best fit: " + (top.a.business_name || top.a.email) + " (" + top.s.total + " / 100)",
        go: "beta", bv: "applications", label: "Review them" });
    }

    // Ratings from the last week.
    (state.ratings || []).forEach(function (x) {
      var a = state.accountById[x.user_id];
      if (!a || Date.now() - new Date(x.created_at) > 7 * 86400000) return;
      items.push({ id: "rating-" + x.id, kind: "RATING",
        title: (a.business_name || a.email) + " rated Adronis", stars: x.stars,
        sub: x.comment ? "“" + x.comment + "”" : "No words, just stars",
        go: "ratings", label: "See ratings" });
    });

    // New messages and feedback (applications are counted above).
    var fresh = state.leads.filter(function (l) { return l.status === "new" && leadKind(l) !== "beta"; }).length;
    if (fresh) {
      items.push({ id: "inbox-" + fresh, kind: "INBOX",
        title: fresh + " new message" + (fresh === 1 ? "" : "s"), sub: "Contact requests, messages and beta feedback",
        go: "inbox", label: "Open the Inbox" });
    }

    // From Friday: testers still missing things before Monday's drop.
    var day = new Date().getDay();
    if (day === 5 || day === 6 || day === 0) {
      var thin = state.accounts.filter(betaOn).filter(function (a) {
        var c = (state.contacts[a.id] || {}).ready;
        return strength(a).score < 60 && !(c && Date.now() - new Date(c.at) < 5 * 86400000);
      });
      if (thin.length) {
        items.push({ id: "monday-" + thin.length, kind: "BEFORE MONDAY",
          title: thin.length + " tester" + (thin.length === 1 ? " is" : "s are") + " missing things for Monday's ads",
          sub: thin.map(function (a) { return a.business_name || a.email; }).slice(0, 4).join(", ") + (thin.length > 4 ? "…" : ""),
          go: "beta", bv: "ready", label: "Send reminders" });
      }
    }

    // Testers whose ads cost more than the weekly cap (Beta → Costs), unless
    // they're paused already, and the budget running out. Only we see this.
    var b = state.budget;
    if (b && state.costs) {
      if (b.tester_week_eur) {
        state.costs.forEach(function (x) {
          var a = state.accountById[x.user_id];
          var weekEur = x.usd_7d * b.usd_eur;
          if (!a || a.engine_paused_at || weekEur <= b.tester_week_eur) return;
          items.push({ id: "cap-" + a.id + "-" + ymd(new Date()), kind: "COSTS", urgent: true,
            title: (a.business_name || a.email) + " cost €" + weekEur.toFixed(2) + " in the last 7 days",
            sub: "Over the €" + b.tester_week_eur + " weekly cap per tester. Pause their ads or find out why.",
            go: "beta", bv: "costs", label: "Open Costs" });
        });
      }
      var spent = state.costs.reduce(function (n, x) { return n + x.usd; }, 0) * b.usd_eur;
      if (b.eur > 0 && spent >= b.eur * 0.9) {
        items.push({ id: "budget-" + Math.floor((spent / b.eur) * 10), kind: "BUDGET", urgent: spent >= b.eur,
          title: "€" + spent.toFixed(2) + " of the €" + b.eur + " beta budget spent (" + Math.round((spent / b.eur) * 100) + "%)",
          sub: spent >= b.eur ? "The budget is spent." : "Nearly spent.",
          go: "beta", bv: "costs", label: "Open Costs" });
      }
    }

    // Something broke in a visitor's browser in the last day.
    var broke = errorGroups(1);
    if (broke.length) {
      var hits = broke.reduce(function (n, g) { return n + g.rows.length; }, 0);
      items.push({ id: "errors-" + broke[0].last.id, kind: "ERRORS", urgent: true,
        title: broke.length + " error" + (broke.length === 1 ? "" : "s") + " on the site in the last day (" + hits + " report" + (hits === 1 ? "" : "s") + ")",
        sub: broke[0].last.message + (broke[0].last.page ? " · " + broke[0].last.page : ""),
        go: "errors", label: "Open Errors" });
    }

    var done = doneToday();
    return items.filter(function (x) { return done.indexOf(x.id) === -1; });
  }

  function renderToday() {
    var items = todayItems();
    $("td-badge").textContent = items.length;
    $("td-badge").hidden = !items.length;
    $("td-date").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    $("td-sum").textContent = items.length
      ? items.length + " thing" + (items.length === 1 ? "" : "s") + " for today"
      : "Nothing left for today.";
    $("td-empty").hidden = items.length > 0;
    $("td-list").innerHTML = items.map(function (x) {
      return '<div class="lead-row td-row' + (x.urgent ? " is-new" : "") + '" data-today="' + esc(x.id) + '">' +
        '<div class="lead-top">' +
          '<span class="pill' + (x.urgent ? " pill-past_due" : " pill-acc") + '">' + esc(x.kind) + "</span>" +
          '<span class="lead-who"><span class="cell-main">' + esc(x.title) + (x.stars ? " " + stars(x.stars) : "") + "</span>" +
            (x.sub ? '<span class="cell-sub">' + esc(x.sub) + "</span>" : "") + "</span>" +
        "</div>" +
        '<div class="lead-actions"><span class="spacer"></span>' +
          (x.mail
            ? '<a class="btn-ghost btn-sm" href="' + esc(x.mail) + '" target="_blank" rel="noopener" data-contact="quiet" data-user="' +
                esc(x.user) + '">' + esc(x.label) + "</a>"
            : '<button type="button" class="btn-ghost btn-sm" data-go="' + esc(x.go) + '"' +
                (x.bv ? ' data-bv-go="' + esc(x.bv) + '"' : "") + ">" + esc(x.label) + "</button>") +
          '<button type="button" class="btn-ghost btn-sm" data-done>Done for today</button>' +
        "</div>" +
      "</div>";
    }).join("");
  }

  function goTo(view) {
    var tab = document.querySelector('.tab[data-view="' + view + '"]');
    if (tab) tab.click();
  }

  $("td-list").addEventListener("click", function (e) {
    var row = e.target.closest("[data-today]");
    if (!row) return;
    var b;
    if ((b = e.target.closest("[data-done]"))) {
      markDone(row.dataset.today);
      renderToday();
      return;
    }
    if ((b = e.target.closest("[data-go]"))) {
      if (b.dataset.bvGo) { state.betaView = b.dataset.bvGo; renderBeta(); }
      if (b.dataset.go === "sales") { $("sl-stage").value = "open"; renderSales(); }
      goTo(b.dataset.go);
      return;
    }
    var link = e.target.closest("a[data-contact]");
    if (link) {
      var c = state.contacts[link.dataset.user] = state.contacts[link.dataset.user] || {};
      c.quiet = { at: new Date().toISOString(), by: state.user.email };
      db.rpc("admin_note_contact", { p_user: link.dataset.user, p_kind: "quiet" }).then(function () {
        refreshAudit();
      }, function () {});
      setTimeout(function () { renderToday(); renderBeta(); }, 0);
    }
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
      ["today", "overview", "accounts", "beta", "sales", "posting", "inbox", "ratings", "errors", "audit", "settings"].forEach(function (v) {
        $("view-" + v).hidden = v !== state.view;
      });
      setMenu(false);
      // A new tab starts at its top, not wherever the last one was scrolled to
      // - on a phone that can be a whole screen below its heading.
      if (changed) window.scrollTo(0, 0);
      if (state.view === "overview" && signupRows.length) renderSignups(signupRows);
      // Whatever was done in the other tabs since, the list catches up.
      if (state.view === "today") renderToday();
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
