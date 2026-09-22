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
    open: null            // the account id whose drawer is showing
  };

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
  // paying, and net of whatever discount was agreed.
  function mrr(a) {
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

  // ------------------------------------------------------------- boot/auth

  async function boot() {
    var res = await db.auth.getSession();
    var session = res.data.session;

    if (!session) { showGate(); return; }

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

    var tiles = [
      { k: "Monthly revenue", v: euro(s.mrr), sub: s.active + " paying account" + (s.active === 1 ? "" : "s") },
      { k: "In trial", v: s.trialing, sub: euro(s.mrr_if_trials_convert) + " if they all convert" },
      { k: "Accounts", v: s.accounts, sub: s.onboarded + " finished the brief" },
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
  function renderSignups(rows) {
    var total = rows.reduce(function (n, r) { return n + Number(r.n); }, 0);
    $("ov-signup-total").textContent = total + " signup" + (total === 1 ? "" : "s");

    var W = 620, H = 150, pad = 18;
    var max = Math.max(1, Math.max.apply(null, rows.map(function (r) { return Number(r.n); })));
    var bw = (W - pad * 2) / Math.max(rows.length, 1);

    var bars = rows.map(function (r, i) {
      var n = Number(r.n);
      var h = n === 0 ? 2 : Math.max(3, (n / max) * (H - pad * 2));
      var x = pad + i * bw;
      var y = H - pad - h;
      return '<rect class="bar' + (n === 0 ? " bar-empty" : "") + '" x="' + (x + 1).toFixed(1) +
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
      '<div class="table-wrap" style="border:none"><table><tbody>' +
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
        var hay = [a.email, a.business_name, a.city, a.vertical, a.website]
          .join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      if (st === "none" && a.subscription_status) return false;
      if (st && st !== "none" && a.subscription_status !== st) return false;
      if (pl === "none" && a.plan) return false;
      if (pl && pl !== "none" && a.plan !== pl) return false;
      if (fl === "discount" && !(a.discount_percent > 0)) return false;
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

    $("ac-body").innerHTML = rows.map(function (a) {
      var when = a.subscription_status === "trialing" ? a.trial_ends_at : a.current_period_end;
      var whenLabel = a.subscription_status === "trialing" ? "trial ends " : "renews ";
      var m = mrr(a);

      var flags = "";
      if (a.cancel_at_period_end) flags += '<span class="cell-sub">cancels at period end</span>';
      else if (a.pending_plan) flags += '<span class="cell-sub">switching to ' + esc(planLabel(a.pending_plan)) + "</span>";

      return '<tr data-open="' + esc(a.id) + '"' + (state.open === a.id ? ' class="is-open"' : "") + ">" +
        '<td><span class="cell-main">' + esc(a.business_name || "—") + "</span>" +
          '<span class="cell-sub">' + esc(a.email) + (a.city ? " · " + esc(a.city) : "") + "</span></td>" +
        '<td>' + esc(planLabel(a.plan)) +
          (a.billing_cycle ? '<span class="cell-sub">' + esc(a.billing_cycle) + "</span>" : "") + "</td>" +
        "<td>" + statusPill(a.subscription_status) + flags + "</td>" +
        '<td class="num">' + (a.discount_percent ? esc(a.discount_percent) + "%" : "—") + "</td>" +
        '<td class="num">' + (m ? euro(m) : "—") + "</td>" +
        '<td class="num">' + (when ? esc(fmtDate(when)) +
            '<span class="cell-sub">' + whenLabel + esc(relDays(when)) + "</span>" : "—") + "</td>" +
        '<td class="num">' + esc(fmtDate(a.created_at)) +
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
    state.open = id;

    var brief = [
      ["City", a.city], ["Vertical", a.vertical], ["Website", a.website],
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

      "<h4>Quick actions</h4>" +
      '<div class="quick">' +
        '<button class="btn-ghost btn-sm" data-ext="7">+7 days trial</button>' +
        '<button class="btn-ghost btn-sm" data-ext="14">+14 days</button>' +
        '<button class="btn-ghost btn-sm" data-ext="30">+30 days</button>' +
      "</div>" +
      '<p class="field-hint" style="margin:8px 0 0">' +
        "Extending moves both the trial end and the next charge date." +
      "</p>" +

      "<h4>Grant a plan</h4>" +
      '<div class="field-row">' +
        '<div class="field"><label for="dr-gplan">PLAN</label><select id="dr-gplan">' +
          planOptions(a.plan || "storefront") + "</select></div>" +
        '<div class="field"><label for="dr-gcycle">CYCLE</label><select id="dr-gcycle">' +
          '<option value="monthly">monthly</option><option value="annual">annual</option>' +
        "</select></div>" +
      "</div>" +
      '<div class="field-row">' +
        '<div class="field"><label for="dr-gdays">DAYS IT RUNS</label>' +
          '<input id="dr-gdays" type="number" min="1" max="3650" value="30"></div>' +
        '<div class="field"><label for="dr-gas">RECORD AS</label><select id="dr-gas">' +
          '<option value="active">paying subscription</option>' +
          '<option value="trial">trial</option>' +
        "</select></div>" +
      "</div>" +
      '<button class="btn btn-sm" id="dr-grant">Grant it</button>' +
      '<p class="field-hint" style="margin:10px 0 0">' +
        "Sets the plan and the status straight away, with no checkout and no card. " +
        "Use it for a comped account, a deal closed off-site, or fixing a bad state." +
      "</p>" +

      "<h4>Billing</h4>" +
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
      '<div class="field"><label for="dr-cancel">AT THE END OF THE PERIOD</label><select id="dr-cancel">' +
        '<option value="false"' + (a.cancel_at_period_end ? "" : " selected") + ">renew as normal</option>" +
        '<option value="true"' + (a.cancel_at_period_end ? " selected" : "") + ">cancel</option>" +
      "</select></div>" +

      "<h4>Discount</h4>" +
      '<div class="field-row">' +
        '<div class="field"><label for="dr-disc">PERCENT OFF</label>' +
          '<input id="dr-disc" type="number" min="0" max="100" step="1" value="' +
          (a.discount_percent == null ? "" : esc(a.discount_percent)) + '"></div>' +
        '<div class="field"><label for="dr-disc-note">WHAT WAS AGREED</label>' +
          '<input id="dr-disc-note" type="text" value="' + esc(a.discount_note || "") + '"></div>' +
      "</div>" +
      '<p class="field-hint">' +
        "Nothing charges a card yet, so this figure is the agreement. " +
        "It comes straight off this account's monthly revenue on the overview." +
      "</p>" +

      "<h4>Internal note</h4>" +
      '<div class="field"><textarea id="dr-notes" placeholder="Only ever seen here.">' +
        esc(a.admin_notes || "") + "</textarea></div>" +

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
        '<button class="btn-ghost btn-sm" id="dr-cancel-btn">Close</button>' +
        '<span class="spacer"></span>' +
        '<span class="panel-note" id="dr-msg"></span>' +
      "</div>";

    // The plan <select> for the billing block needs the current value selected,
    // which planOptions() only does for the value it is handed.
    $("dr-plan").value = a.plan || "";

    $("drawer").hidden = false;
    $("scrim").hidden = false;
    document.body.style.overflow = "hidden";   // the table must not scroll behind it
    wireDrawer(a);
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
    $("drawer").hidden = true;
    $("scrim").hidden = true;
    $("drawer").innerHTML = "";
    document.body.style.overflow = "";
    renderAccounts();
  }

  $("scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.open) closeDrawer();
  });

  function drawerMsg(text, bad) {
    var el = $("dr-msg");
    if (!el) return;
    el.textContent = text;
    el.style.color = bad ? "var(--bad)" : "var(--ok)";
  }

  function wireDrawer(a) {
    $("dr-close").addEventListener("click", closeDrawer);
    $("dr-cancel-btn").addEventListener("click", closeDrawer);

    Array.prototype.forEach.call($("drawer").querySelectorAll("[data-ext]"), function (b) {
      b.addEventListener("click", async function () {
        b.disabled = true;
        var res = await db.rpc("admin_extend_trial", {
          p_user: a.id, p_days: Number(b.dataset.ext)
        });
        b.disabled = false;
        if (res.error) { drawerMsg(res.error.message, true); return; }
        drawerMsg("Trial now ends " + fmtDate(res.data.trial_ends_at) + ".");
        await loadAll();
      });
    });

    $("dr-grant").addEventListener("click", async function () {
      var btn = $("dr-grant");
      btn.disabled = true;
      var res = await db.rpc("admin_grant_plan", {
        p_user: a.id,
        p_plan: $("dr-gplan").value,
        p_cycle: $("dr-gcycle").value,
        p_days: Number($("dr-gdays").value) || null,
        p_as_trial: $("dr-gas").value === "trial",
        p_discount: null,
        p_note: null
      });
      btn.disabled = false;
      if (res.error) { drawerMsg(res.error.message, true); return; }
      drawerMsg("Granted.");
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
      put("discount_percent", $("dr-disc").value.trim(), a.discount_percent);
      put("discount_note", $("dr-disc-note").value.trim(), a.discount_note);
      put("admin_notes", $("dr-notes").value.trim(), a.admin_notes);

      var wantCancel = $("dr-cancel").value === "true";
      if (wantCancel !== !!a.cancel_at_period_end) patch.cancel_at_period_end = wantCancel;

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
      state.view = tab.dataset.view;
      Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
        t.classList.toggle("is-on", t === tab);
      });
      ["overview", "accounts", "audit", "settings"].forEach(function (v) {
        $("view-" + v).hidden = v !== state.view;
      });
    });
  });

  boot();
})();
