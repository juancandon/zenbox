(function () {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ].join(" ");
  const MAX_THREADS = 150;
  const CONCURRENCY = 4;

  const state = {
    token: null,
    email: "",
    demo: false,
    filter: "reply",
    mails: [],
    events: [],
  };

  const $ = (id) => document.getElementById(id);

  // Crea elementos con texto seguro (nunca se inserta HTML de los correos).
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function decodeEntities(s) {
    const t = document.createElement("textarea");
    t.innerHTML = s || "";
    return t.value;
  }

  function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }

  /* ---------- Google ---------- */

  let tokenClient = null;

  function initGoogle() {
    if (!CFG.GOOGLE_CLIENT_ID) {
      $("login").disabled = true;
      $("loginNote").textContent = "La conexión con Google aún no está configurada. Mientras tanto puedes ver la demostración.";
      return;
    }
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      setTimeout(initGoogle, 200);
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: onToken,
      error_callback: (err) => {
        $("loginNote").textContent = "No se completó la conexión (" + (err && err.type || "cancelada") + ").";
      },
    });
  }

  function onToken(resp) {
    if (resp.error) {
      $("loginNote").textContent = "Google no dio permiso: " + resp.error;
      return;
    }
    if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ...SCOPES.split(" "))) {
      $("loginNote").textContent = "Para funcionar necesitamos los dos permisos (correo y calendario). Vuelve a conectar y marca ambas casillas.";
      return;
    }
    state.token = resp.access_token;
    state.demo = false;
    state.subs = null;
    showApp();
    load();
  }

  async function api(url) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + state.token } });
      if (r.status === 401) throw new Error("expired");
      if (r.status === 429 || r.status >= 500) {
        await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt));
        continue;
      }
      if (!r.ok) throw new Error("Error " + r.status + " al leer " + new URL(url).pathname);
      return r.json();
    }
    throw new Error("Google está limitando las peticiones. Prueba de nuevo en un minuto.");
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    async function worker() {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  async function fetchMails(days) {
    const G = "https://gmail.googleapis.com/gmail/v1/users/me";
    const profile = await api(G + "/profile");
    state.email = profile.emailAddress;
    const ids = [];
    let page = "";
    do {
      const q = encodeURIComponent("in:inbox newer_than:" + days + "d");
      const res = await api(G + "/threads?maxResults=100&q=" + q + (page ? "&pageToken=" + page : ""));
      (res.threads || []).forEach((t) => ids.push(t.id));
      page = res.nextPageToken;
    } while (page && ids.length < MAX_THREADS);
    const headers = ["From", "Subject", "List-Unsubscribe", "Precedence", "Auto-Submitted"]
      .map((x) => "&metadataHeaders=" + x).join("");
    const threads = await mapLimit(ids.slice(0, MAX_THREADS), CONCURRENCY, (id) =>
      api(G + "/threads/" + id + "?format=metadata" + headers)
    );
    return threads.map(toMail).filter(Boolean);
  }

  const RECEIPT_Q = 'newer_than:400d -category:promotions (recibo OR receipt OR factura OR invoice OR "tu suscripción" OR "your subscription" OR suscripción OR subscription OR renovación OR renewal OR membership OR "pago recibido" OR "payment received" OR "cobro")';

  async function fetchReceipts() {
    const G = "https://gmail.googleapis.com/gmail/v1/users/me";
    const res = await api(G + "/messages?maxResults=150&q=" + encodeURIComponent(RECEIPT_Q));
    const ids = (res.messages || []).map((m) => m.id);
    const msgs = await mapLimit(ids, CONCURRENCY, (id) =>
      api(G + "/messages/" + id + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject")
    );
    return msgs.map((m) => {
      const hdr = (name) => {
        const x = ((m.payload && m.payload.headers) || []).find((y) => y.name.toLowerCase() === name.toLowerCase());
        return x ? x.value : "";
      };
      return { id: m.id, from: hdr("From"), subject: hdr("Subject"), snippet: decodeEntities(m.snippet), date: Number(m.internalDate) };
    });
  }

  function toMail(t) {
    const msgs = t.messages || [];
    if (!msgs.length) return null;
    const last = msgs[msgs.length - 1];
    const received = msgs.filter((m) => !(m.labelIds || []).includes("SENT"));
    const lastIn = received[received.length - 1] || last;
    const hdr = (m, name) => {
      const x = ((m.payload && m.payload.headers) || []).find((y) => y.name.toLowerCase() === name.toLowerCase());
      return x ? x.value : "";
    };
    const labels = new Set();
    msgs.forEach((m) => (m.labelIds || []).forEach((l) => labels.add(l)));
    return {
      id: t.id,
      from: hdr(lastIn, "From"),
      subject: hdr(msgs[0], "Subject"),
      snippet: decodeEntities(lastIn.snippet),
      date: Number(last.internalDate),
      labels,
      lastIsMine: (last.labelIds || []).includes("SENT"),
      bulk: !!(hdr(lastIn, "List-Unsubscribe") || /bulk|list/i.test(hdr(lastIn, "Precedence")) ||
        (hdr(lastIn, "Auto-Submitted") && !/^no$/i.test(hdr(lastIn, "Auto-Submitted")))),
    };
  }

  async function fetchEvents() {
    const now = new Date();
    const end = new Date(now.getTime() + 14 * 864e5);
    const url = "https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=100" +
      "&timeMin=" + encodeURIComponent(now.toISOString()) + "&timeMax=" + encodeURIComponent(end.toISOString());
    const res = await api(url);
    return (res.items || []).filter((e) => e.status !== "cancelled").map((e) => ({
      title: e.summary || "(sin título)",
      start: e.start.dateTime || e.start.date,
      allDay: !e.start.dateTime,
      link: e.htmlLink,
    }));
  }

  /* ---------- Clasificación (reglas, sin IA) ---------- */

  const AUTOMATED = /(no-?reply|do-?not-?reply|notifica|notification|alert|mailer|newsletter|news@|info@|hello@|marketing|promo|bounce|support@|soporte@|updates?@)/i;
  const IMPORTANT_WORDS = /(seguridad|security|contraseña|password|c[oó]digo|verifica|factura|invoice|recibo|receipt|pago|payment|cobro|cita|appointment|pedido|order|reserva|booking|vuelo|flight|banco|bank|hacienda|multa|contrato)/i;

  function classify(m) {
    const promo = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"].some((l) => m.labels.has(l));
    const updates = m.labels.has("CATEGORY_UPDATES");
    const primary = !promo && !updates;
    const automated = m.bulk || AUTOMATED.test(m.from);
    const important = m.labels.has("IMPORTANT") || m.labels.has("STARRED") || IMPORTANT_WORDS.test(m.subject);
    if (primary && !m.lastIsMine && !automated) return "reply";
    if (IMPORTANT_WORDS.test(m.subject) || m.labels.has("STARRED")) return "read";
    if (primary && (important || !m.bulk)) return "read";
    return "noise";
  }

  function senderName(from) {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from || "");
    if (m) return m[1].trim() || m[2];
    return (from || "").trim() || "(desconocido)";
  }
  function senderEmail(from) {
    const m = /<([^>]+)>/.exec(from || "");
    return (m ? m[1] : from || "").toLowerCase().trim();
  }

  /* ---------- Suscripciones (a partir de recibos) ---------- */

  const MONEY = /(R\$|US\$|\$|€|£)\s?(\d{1,4}(?:[.,]\d{2}))|(\d{1,4}(?:[.,]\d{2}))\s?(€|EUR|USD|BRL|GBP)/i;
  const SUB_WORDS = /(suscripci[oó]n|subscription|membres[ií]a|membership|renovaci[oó]n|renewal|plan mensual|monthly plan)/i;
  const SHARED_BILLERS = /(apple\.com|google\.com|paypal\.|stripe\.com)$/i;

  function parseMoney(text) {
    const m = MONEY.exec(text || "");
    if (!m) return null;
    let cur = (m[1] || m[4] || "").toUpperCase();
    cur = { "EUR": "€", "USD": "$", "US$": "$", "BRL": "R$", "GBP": "£" }[cur] || cur;
    const value = parseFloat((m[2] || m[3]).replace(",", "."));
    return value > 0 ? { value, cur } : null;
  }

  function baseDomain(from) {
    const d = senderEmail(from).split("@")[1] || "";
    return d.split(".").slice(-2).join(".");
  }

  function frequency(days) {
    if (days >= 6 && days <= 8) return { name: "Semanal", days: 7, perMonth: 30 / 7 };
    if (days >= 25 && days <= 35) return { name: "Mensual", days: Math.round(days), perMonth: 1 };
    if (days >= 80 && days <= 100) return { name: "Trimestral", days: Math.round(days), perMonth: 1 / 3 };
    if (days >= 340 && days <= 390) return { name: "Anual", days: 365, perMonth: 1 / 12 };
    return null;
  }

  function detectSubscriptions(receipts) {
    const groups = new Map();
    receipts.forEach((r) => {
      r.money = parseMoney(r.subject + " " + r.snippet);
      const dom = baseDomain(r.from);
      // Apple, Google o PayPal cobran muchos servicios distintos: los separamos por importe.
      const key = SHARED_BILLERS.test(dom) ? dom + "|" + (r.money ? r.money.cur + r.money.value : "?") : dom;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });
    const subs = [];
    groups.forEach((list, key) => {
      list.sort((a, b) => a.date - b.date);
      const last = list[list.length - 1];
      const priced = list.filter((r) => r.money);
      const money = priced.length ? priced[priced.length - 1].money : null;
      let freq = null;
      if (list.length >= 2) {
        const gaps = [];
        for (let i = 1; i < list.length; i++) gaps.push((list[i].date - list[i - 1].date) / 864e5);
        gaps.sort((a, b) => a - b);
        freq = frequency(gaps[Math.floor(gaps.length / 2)]);
      }
      const isSub = list.some((r) => SUB_WORDS.test(r.subject + " " + r.snippet));
      if (!freq && !isSub) return;
      const old = Date.now() - last.date > (freq ? freq.days * 1.6 : 45) * 864e5;
      if (old) return; // hace tiempo que no cobra: probablemente cancelada
      let next = null;
      if (freq) {
        next = last.date + freq.days * 864e5;
        while (next < Date.now() - 864e5) next += freq.days * 864e5;
      }
      const name = senderName(last.from);
      subs.push({
        name: SHARED_BILLERS.test(key.split("|")[0]) && money ? name + " (" + fmtMoney(money) + ")" : name,
        money, freq, next, count: list.length, lastId: last.id,
      });
    });
    return subs.sort((a, b) => (a.next || Infinity) - (b.next || Infinity));
  }

  function fmtMoney(m) {
    const v = m.value.toLocaleString("es", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return m.cur === "€" ? v + " €" : m.cur + " " + v;
  }

  /* ---------- Promociones ---------- */

  const PROMO_RULES = [
    [/gratis|free|regalo|gift/i, 70],
    [/2\s?x\s?1|3\s?x\s?2/i, 60],
    [/evento|event|concierto|entradas/i, 50],
    [/sorteo|giveaway|gana un|win a/i, 45],
    [/descuento|discount|rebaja|sale\b|oferta/i, 30],
    [/cup[oó]n|coupon|c[oó]digo promo|promo code/i, 25],
    [/env[ií]o gratis|free shipping/i, 20],
  ];

  function promoScore(m) {
    const text = m.subject + " " + m.snippet;
    const hits = [];
    PROMO_RULES.forEach(([re, pts]) => { if (re.test(text)) hits.push(pts); });
    const pct = /(?:-|hasta\s|up to\s)?(\d{1,2})\s?%/i.exec(text);
    if (pct) hits.push(Math.min(95, Number(pct[1])));
    if (!hits.length) return 0;
    hits.sort((a, b) => b - a);
    return Math.min(100, hits[0] + 5 * (hits.length - 1));
  }

  /* ---------- Pantalla ---------- */

  const LABELS = {
    reply: { name: "Necesitan respuesta", tag: "Responder" },
    read: { name: "Conviene leer", tag: "Leer" },
    noise: { name: "Publicidad y boletines", tag: "Ruido" },
  };

  function showApp() {
    $("welcome").hidden = true;
    $("app").hidden = false;
    $("controls").hidden = false;
  }

  function showWelcome() {
    $("welcome").hidden = false;
    $("app").hidden = true;
    $("controls").hidden = true;
    $("banner").hidden = true;
    $("who").textContent = "";
  }

  function setBanner(text) {
    $("banner").hidden = !text;
    $("banner").textContent = text || "";
  }

  function fmtDate(ms) {
    const d = new Date(ms);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString("es", { day: "numeric", month: "short" });
  }

  function gmailLink(id) {
    const u = state.email ? "?authuser=" + encodeURIComponent(state.email) : "";
    return "https://mail.google.com/mail/" + u + "#all/" + id;
  }

  function render() {
    const counts = { reply: 0, read: 0, noise: 0 };
    state.mails.forEach((m) => counts[m.cat]++);

    const tiles = $("tiles");
    tiles.replaceChildren(
      ...["reply", "read", "noise"].map((k) =>
        h("button", { class: "tile " + k + (state.filter === k ? " active" : ""), onclick: () => { state.filter = k; render(); } },
          h("div", { class: "n" }, counts[k]), h("div", { class: "l" }, LABELS[k].name))
      ),
      h("button", { class: "tile" + (state.filter === "all" ? " active" : ""), onclick: () => { state.filter = "all"; render(); } },
        h("div", { class: "n" }, state.mails.length), h("div", { class: "l" }, "Total en la bandeja"))
    );

    const list = state.mails
      .filter((m) => state.filter === "all" || m.cat === state.filter)
      .sort((a, b) => b.date - a.date);
    $("listTitle").textContent = state.filter === "all" ? "Todos los correos" : LABELS[state.filter].name;
    $("list").replaceChildren(
      ...(list.length ? list.map((m) =>
        h("a", { class: "mail", href: gmailLink(m.id), target: "_blank", rel: "noopener" },
          h("div", { class: "row1" },
            h("span", { class: "from" }, h("span", { class: "tag " + m.cat }, LABELS[m.cat].tag), senderName(m.from)),
            h("span", { class: "date" }, fmtDate(m.date))),
          h("div", { class: "subj" }, m.subject || "(sin asunto)"),
          h("div", { class: "snip" }, m.snippet))
      ) : [h("div", { class: "empty" }, state.filter === "reply" ? "Nada pendiente de responder. ¡Bien!" : "No hay correos aquí.")])
    );

    renderAgenda();
    renderSenders();
    renderSubs();
    renderPromos();
  }

  function renderSubs() {
    if (state.subsError) {
      $("subs").replaceChildren(h("div", { class: "error" }, "No pude leer los recibos: " + state.subsError));
      return;
    }
    const subs = state.subs || [];
    if (!subs.length) {
      $("subs").replaceChildren(h("div", { class: "empty" }, "No he encontrado recibos de suscripciones en tu correo."));
      return;
    }
    const totals = {};
    subs.forEach((s) => {
      if (s.money && s.freq) totals[s.money.cur] = (totals[s.money.cur] || 0) + s.money.value * s.freq.perMonth;
    });
    const totalText = Object.entries(totals).map(([cur, v]) => fmtMoney({ cur, value: v })).join(" + ");
    $("subs").replaceChildren(
      totalText ? h("p", { class: "subtotal" }, "Gasto estimado al mes: ", h("strong", {}, totalText)) : null,
      h("div", { class: "table-wrap" }, h("table", { class: "subs" },
        h("thead", {}, h("tr", {}, h("th", {}, "Servicio"), h("th", {}, "Importe"), h("th", {}, "Frecuencia"), h("th", {}, "Próximo cobro"))),
        h("tbody", {}, ...subs.map((s) => {
          const daysLeft = s.next ? Math.ceil((s.next - Date.now()) / 864e5) : null;
          return h("tr", {},
            h("td", {}, h("a", { href: gmailLink(s.lastId), target: "_blank", rel: "noopener" }, s.name)),
            h("td", {}, s.money ? fmtMoney(s.money) : "?"),
            h("td", {}, s.freq ? s.freq.name : "Sin datos"),
            h("td", { class: daysLeft !== null && daysLeft <= 3 ? "soon" : "" },
              s.next ? new Date(s.next).toLocaleDateString("es", { day: "numeric", month: "short" }) +
                " (" + (daysLeft <= 0 ? "hoy" : daysLeft === 1 ? "mañana" : "en " + daysLeft + " días") + ")" : "?"));
        })))),
      h("p", { class: "small" }, "Calculado a partir de los recibos de tu correo del último año. Las fechas son estimaciones.")
    );
  }

  function renderPromos() {
    const promos = state.mails
      .filter((m) => m.labels.has("CATEGORY_PROMOTIONS") || (m.cat === "noise" && m.bulk))
      .map((m) => ({ m, score: promoScore(m) }))
      .filter((p) => p.score > 0);
    const min = Number($("promoMin").value);
    $("promoMinLabel").textContent = min;
    const top = promos.filter((p) => p.score >= min).sort((a, b) => b.score - a.score);
    $("promos").replaceChildren(...(top.length ? top.map((p) =>
      h("a", { class: "mail", href: gmailLink(p.m.id), target: "_blank", rel: "noopener" },
        h("div", { class: "row1" },
          h("span", { class: "from" }, h("span", { class: "score" }, p.score), senderName(p.m.from)),
          h("span", { class: "date" }, fmtDate(p.m.date))),
        h("div", { class: "subj" }, p.m.subject || "(sin asunto)"))
    ) : [h("div", { class: "empty" }, "Ninguna promo llega a esa puntuación. Baja el mínimo.")]));

    const byCompany = new Map();
    promos.forEach((p) => {
      const key = baseDomain(p.m.from);
      const cur = byCompany.get(key) || { name: senderName(p.m.from), best: p, n: 0 };
      cur.n++;
      if (p.score > cur.best.score) cur.best = p;
      byCompany.set(key, cur);
    });
    const companies = [...byCompany.values()].sort((a, b) => b.best.score - a.best.score).slice(0, 10);
    $("companies").replaceChildren(...(companies.length ? companies.map((c) =>
      h("a", { class: "mail", href: gmailLink(c.best.m.id), target: "_blank", rel: "noopener" },
        h("div", { class: "row1" },
          h("span", { class: "from" }, h("span", { class: "score" }, c.best.score), c.name),
          h("span", { class: "date" }, c.n + (c.n === 1 ? " promo" : " promos"))),
        h("div", { class: "snip" }, c.best.m.subject))
    ) : [h("div", { class: "empty" }, "Sin promociones en este periodo.")]));
  }

  function renderAgenda() {
    const byDay = new Map();
    state.events.forEach((e) => {
      const key = e.allDay ? e.start : new Date(e.start).toDateString();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    });
    if (!byDay.size) {
      $("agenda").replaceChildren(h("div", { class: "empty" }, "No tienes eventos en las próximas dos semanas."));
      return;
    }
    $("agenda").replaceChildren(...[...byDay.values()].map((evs) => {
      const first = evs[0];
      const d = first.allDay ? new Date(first.start + "T00:00") : new Date(first.start);
      return h("div", { class: "day" },
        h("div", { class: "dname" }, d.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" })),
        ...evs.map((e) => h("div", { class: "event" },
          h("span", { class: "time" }, e.allDay ? "Todo el día" : new Date(e.start).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })),
          e.link ? h("a", { class: "title", href: e.link, target: "_blank", rel: "noopener" }, e.title) : h("span", { class: "title" }, e.title)
        )));
    }));
  }

  function renderSenders() {
    const tally = new Map();
    state.mails.filter((m) => m.cat === "noise").forEach((m) => {
      const key = senderEmail(m.from);
      const cur = tally.get(key) || { name: senderName(m.from), n: 0 };
      cur.n++;
      tally.set(key, cur);
    });
    const top = [...tally.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    if (!top.length) {
      $("senders").replaceChildren(h("div", { class: "empty" }, "Sin publicidad en este periodo."));
      return;
    }
    $("senders").replaceChildren(
      h("ul", {}, ...top.map((s) => h("li", {}, h("span", { class: "name" }, s.name), h("span", { class: "count" }, s.n + (s.n === 1 ? " correo" : " correos"))))),
      h("p", { class: "small" }, "Si no los lees, darte de baja de estos remitentes es lo que más limpia tu bandeja.")
    );
  }

  async function load() {
    const days = $("days").value;
    $("list").replaceChildren(h("div", { class: "loading" }, "Leyendo tu correo…"));
    $("agenda").replaceChildren(h("div", { class: "loading" }, "Leyendo tu agenda…"));
    $("subs").replaceChildren(h("div", { class: "loading" }, "Buscando recibos…"));
    $("refresh").disabled = true;
    setBanner(state.demo ? "Estás viendo una demostración con datos inventados." : "");
    try {
      if (state.demo) {
        const d = demoData();
        state.mails = d.mails; state.events = d.events; state.email = "";
        state.subs = detectSubscriptions(d.receipts); state.subsError = "";
      } else {
        const [mails, events] = await Promise.all([fetchMails(days), fetchEvents()]);
        state.mails = mails; state.events = events;
        state.subsError = "";
        // Los recibos son de todo el año, no dependen del periodo elegido: se leen una vez por sesión.
        if (!state.subs) {
          try { state.subs = detectSubscriptions(await fetchReceipts()); }
          catch (e) { if (e.message === "expired") throw e; state.subsError = e.message; }
        }
      }
      state.mails.forEach((m) => { m.cat = classify(m); });
      $("who").textContent = state.demo ? "Demostración" : state.email;
      render();
    } catch (e) {
      if (e.message === "expired") {
        state.token = null;
        showWelcome();
        $("loginNote").textContent = "La sesión con Google caducó. Vuelve a conectar.";
      } else {
        $("list").replaceChildren(h("div", { class: "error" }, "No pude leer tus datos: " + e.message));
        $("agenda").replaceChildren();
      }
    } finally {
      $("refresh").disabled = false;
    }
  }

  function logout() {
    if (state.token && window.google) google.accounts.oauth2.revoke(state.token, () => {});
    state.token = null; state.mails = []; state.events = []; state.subs = null; state.email = ""; state.demo = false;
    showWelcome();
    $("loginNote").textContent = "Te has desconectado. No queda ningún dato tuyo en esta web.";
  }

  /* ---------- Demostración ---------- */

  function demoData() {
    const now = Date.now();
    const H = 36e5;
    const mk = (from, subject, snippet, hoursAgo, labels, opts) => Object.assign({
      id: "demo" + Math.random().toString(36).slice(2), from, subject, snippet,
      date: now - hoursAgo * H, labels: new Set(labels), lastIsMine: false, bulk: false,
    }, opts || {});
    const mails = [
      mk("Lucía Martín <lucia@ejemplo.com>", "¿Quedamos el jueves para revisar el proyecto?", "Hola, te escribo para ver si te viene bien el jueves a las 17h…", 3, ["INBOX", "IMPORTANT"]),
      mk("Pedro Gómez <pedro@empresa.es>", "Presupuesto reforma", "Te adjunto el presupuesto actualizado, ¿me confirmas si lo ves bien?", 20, ["INBOX"]),
      mk("Ana <ana@ejemplo.com>", "Cumple de Marta", "¿Te apuntas a la cena del sábado? Necesito saberlo antes del miércoles.", 30, ["INBOX"]),
      mk("Banco Ejemplo <avisos@bancoejemplo.com>", "Tu factura de octubre ya está disponible", "Consulta el detalle de tu factura en la app.", 8, ["INBOX", "CATEGORY_UPDATES"], { bulk: true }),
      mk("Aerolínea <no-reply@aerolinea.com>", "Cambio en tu reserva de vuelo", "El horario de tu vuelo ha cambiado. Revisa los detalles.", 26, ["INBOX", "IMPORTANT"]),
      mk("Google <no-reply@accounts.google.com>", "Alerta de seguridad", "Se ha iniciado sesión en un dispositivo nuevo.", 50, ["INBOX", "CATEGORY_UPDATES"]),
      mk("Tienda Moda <newsletter@tiendamoda.com>", "-40% solo este fin de semana", "No te lo pierdas: descuentos en toda la colección.", 2, ["INBOX", "CATEGORY_PROMOTIONS"], { bulk: true }),
      mk("Tienda Moda <newsletter@tiendamoda.com>", "Novedades de otoño", "Descubre lo último en nuestra tienda.", 40, ["INBOX", "CATEGORY_PROMOTIONS"], { bulk: true }),
      mk("Tienda Moda <newsletter@tiendamoda.com>", "Último día de rebajas", "Hoy acaba la promoción.", 70, ["INBOX", "CATEGORY_PROMOTIONS"], { bulk: true }),
      mk("App de Citas <hello@appcitas.com>", "Tienes 3 nuevos likes", "Entra para ver quién eres.", 5, ["INBOX", "CATEGORY_SOCIAL"], { bulk: true }),
      mk("App de Citas <hello@appcitas.com>", "¡Alguien te ha escrito!", "Abre la app para leerlo.", 28, ["INBOX", "CATEGORY_SOCIAL"], { bulk: true }),
      mk("Apuestas Ya <promo@apuestasya.com>", "Bono de 50 € para ti", "Solo hoy, regístrate y llévate tu bono.", 12, ["INBOX", "CATEGORY_PROMOTIONS"], { bulk: true }),
      mk("Cine Ya <promos@cineya.com>", "2x1 en entradas este jueves", "Trae a quien quieras: segunda entrada gratis.", 15, ["INBOX", "CATEGORY_PROMOTIONS"], { bulk: true }),
      mk("Zapatos Top <news@zapatostop.com>", "Envío gratis y 20% de descuento", "Usa el cupón OTONO20 hasta el domingo.", 33, ["INBOX", "CATEGORY_PROMOTIONS"], { bulk: true }),
      mk("Revista Tech <news@revistatech.com>", "Lo mejor de la semana", "Los 10 artículos más leídos.", 60, ["INBOX", "CATEGORY_PROMOTIONS"], { bulk: true }),
    ];
    const day = (n, hour) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
    const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const events = [
      { title: "Reunión de equipo", start: day(0, 18), allDay: false },
      { title: "Dentista", start: day(1, 10), allDay: false },
      { title: "Revisión del proyecto con Lucía", start: day(2, 17), allDay: false },
      { title: "Cobro del gimnasio", start: iso(4), allDay: true },
      { title: "Cena de cumpleaños de Marta", start: day(5, 21), allDay: false },
    ];
    const ago = (d) => now - d * 864e5;
    const rc = (from, subject, snippet, daysAgo) => ({ id: "demo" + Math.random().toString(36).slice(2), from, subject, snippet, date: ago(daysAgo) });
    const receipts = [];
    [3, 33, 63, 93].forEach((d) => receipts.push(rc("Música Plus <recibos@musicaplus.com>", "Recibo de tu suscripción", "Importe: 10,99 € · Plan Individual", d)));
    [12, 42, 72].forEach((d) => receipts.push(rc("Apple <no_reply@email.apple.com>", "Tu recibo de Apple", "iCloud+ 200 GB 2,99 €", d)));
    [26, 56, 86].forEach((d) => receipts.push(rc("Gimnasio Centro <cobros@gimnasiocentro.es>", "Factura mensual", "Cuota mensual 34,90 €", d)));
    [200].forEach((d) => receipts.push(rc("Nube Fotos <billing@nubefotos.com>", "Your subscription renewal", "Annual plan €29.99", d)));
    receipts.push(rc("Vídeo Stream <info@videostream.com>", "Bienvenido a tu suscripción", "Tu primer cobro de 7,99 € será el día 1", 10));
    return { mails, events, receipts };
  }

  /* ---------- Arranque ---------- */

  $("appName").textContent = CFG.APP_NAME || "ZenBox";
  const savedDays = storeGet("days");
  if (savedDays) $("days").value = savedDays;
  $("days").addEventListener("change", () => { storeSet("days", $("days").value); load(); });
  $("refresh").addEventListener("click", load);
  $("logout").addEventListener("click", logout);
  $("login").addEventListener("click", () => { if (tokenClient) tokenClient.requestAccessToken({ prompt: "" }); else if (CFG.GOOGLE_CLIENT_ID) $("loginNote").textContent = "Un momento, cargando Google… vuelve a pulsar en unos segundos."; });
  $("demo").addEventListener("click", () => { state.demo = true; showApp(); load(); });
  const savedMin = storeGet("promoMin");
  if (savedMin) $("promoMin").value = savedMin;
  $("promoMin").addEventListener("input", () => { storeSet("promoMin", $("promoMin").value); renderPromos(); });
  initGoogle();
})();
