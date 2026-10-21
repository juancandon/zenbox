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
        const type = err && err.type;
        $("loginNote").textContent = type === "popup_failed_to_open"
          ? "Tu navegador ha bloqueado la ventana de Google. Permite las ventanas emergentes para esta web y vuelve a pulsar."
          : type === "popup_closed"
            ? "Se cerró la ventana de Google antes de terminar. Vuelve a pulsar Conectar con Google."
            : "No se completó la conexión (" + (type || "cancelada") + ").";
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

  // Correos de altas, cobros, bajas y pruebas gratis del último año (ver subs.js).
  async function fetchSubscriptionMails() {
    const G = "https://gmail.googleapis.com/gmail/v1/users/me";
    const ids = [];
    let page = "";
    do {
      const res = await api(G + "/messages?maxResults=100&q=" + encodeURIComponent(ZenSubs.QUERY) + (page ? "&pageToken=" + page : ""));
      (res.messages || []).forEach((m) => ids.push(m.id));
      page = res.nextPageToken;
    } while (page && ids.length < 300);
    const hdr = (m, name) => {
      const x = ((m.payload && m.payload.headers) || []).find((y) => y.name.toLowerCase() === name.toLowerCase());
      return x ? x.value : "";
    };
    const metas = await mapLimit(ids, CONCURRENCY, (id) =>
      api(G + "/messages/" + id + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject"));
    const candidates = metas
      .map((m) => ({ id: m.id, from: hdr(m, "From"), subject: hdr(m, "Subject"), snippet: decodeEntities(m.snippet), date: Number(m.internalDate) }))
      .filter((m) => ZenSubs.isCandidate(m))
      .slice(0, 120);
    await mapLimit(candidates, CONCURRENCY, async (m) => {
      const full = await api(G + "/messages/" + m.id + "?format=full");
      m.body = bodyText(full.payload);
    });
    return candidates;
  }

  function b64(data) {
    const bin = atob((data || "").replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  // Texto del correo: la parte en texto plano si la hay; si no, el HTML convertido a texto (sin ejecutar nada).
  function bodyText(payload) {
    const parts = [];
    (function walk(p) {
      if (!p) return;
      if (p.parts) p.parts.forEach(walk);
      else if (p.body && p.body.data) parts.push(p);
    })(payload);
    const plain = parts.find((p) => p.mimeType === "text/plain");
    if (plain) return b64(plain.body.data);
    const html = parts.find((p) => p.mimeType === "text/html");
    if (!html) return "";
    const doc = new DOMParser().parseFromString(b64(html.body.data), "text/html");
    doc.querySelectorAll("script,style,head").forEach((el) => el.remove());
    doc.querySelectorAll("br,p,div,tr,li,h1,h2,h3,h4,table").forEach((el) => el.after("\n"));
    doc.querySelectorAll("td,th").forEach((el) => el.after(" "));
    return doc.body ? doc.body.textContent : "";
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

  function baseDomain(from) {
    const d = senderEmail(from).split("@")[1] || "";
    return d.split(".").slice(-2).join(".");
  }

  const CODES = { "€": "€", "$": "USD", "R$": "BRL", "£": "GBP" };
  function fmtMoney(m) {
    const v = m.value.toLocaleString("es", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v + " " + (CODES[m.cur] || m.cur);
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

  /* ---------- Suscripciones: pantalla ---------- */

  // Lo que el usuario oculta, corrige o añade a mano se guarda solo en este navegador.
  function prefs() {
    try { return JSON.parse(storeGet("subsPrefs") || "{}"); } catch (e) { return {}; }
  }
  function savePrefs(p) { storeSet("subsPrefs", JSON.stringify(p)); }

  function allSubs() {
    const p = prefs();
    const hidden = p.hidden || [];
    const edits = p.edits || {};
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const list = (state.subs || []).filter((s) => !hidden.includes(s.key)).map((s) => {
      const e = edits[s.key];
      return e ? Object.assign({}, s, { amount: { value: e.value, cur: e.cur } }) : s;
    });
    (p.manual || []).forEach((m) => {
      const period = m.yearly ? { months: 12, label: "año" } : { months: 1, label: "mes" };
      const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      let next = new Date(today.getFullYear(), today.getMonth(), Math.min(m.day, lastDay)).getTime();
      if (next < today.getTime()) next = ZenSubs.addPeriod(next, period, 1);
      const prev = ZenSubs.addPeriod(next, period, -1);
      list.push({
        key: "manual:" + m.id, manual: true, name: m.name, note: m.note || "Añadida a mano.",
        amount: m.value ? { value: m.value, cur: m.cur } : null, period, next, estimated: true,
        periodDays: Math.round((next - prev) / 864e5), daysLeft: Math.round((next - today.getTime()) / 864e5),
      });
    });
    return list.sort((a, b) => a.next - b.next);
  }

  function renderSubs() {
    if (state.subsError) {
      $("subs").replaceChildren(h("div", { class: "error" }, "No pude leer los recibos: " + state.subsError));
      return;
    }
    const subs = allSubs();
    const p = prefs();
    // El total va en la moneda más habitual (euros si hay alguna en euros); el resto se indica aparte.
    const counts = {};
    subs.forEach((s) => { if (s.amount) counts[s.amount.cur] = (counts[s.amount.cur] || 0) + 1; });
    const main = counts["€"] ? "€" : Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "€";
    let total = 0;
    const others = {};
    subs.forEach((s) => {
      if (!s.amount) return;
      const perMonth = s.amount.value / s.period.months;
      if (s.amount.cur === main) total += perMonth; else others[s.amount.cur] = (others[s.amount.cur] || 0) + perMonth;
    });

    const fmtDay = (t) => new Date(t).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
    const rows = subs.map((s) => {
      const pct = s.periodDays ? Math.min(100, Math.round((s.daysLeft / s.periodDays) * 100)) : 0;
      const otherCur = s.amount && s.amount.cur !== main;
      const note = s.note + (otherCur ? " En " + (CODES[s.amount.cur] || s.amount.cur) + ": no suma al total en " + (CODES[main] || main) + "." : "");
      return h("tr", {},
        h("td", { class: "svc" },
          h("div", { class: "svc-name" }, s.lastId ? h("a", { href: gmailLink(s.lastId), target: "_blank", rel: "noopener" }, s.name) : s.name),
          h("div", { class: "svc-note" }, note),
          h("div", { class: "svc-actions" },
            h("button", { class: "link", onclick: () => editSub(s) }, "Editar importe"),
            h("button", { class: "link", onclick: () => hideSub(s) }, s.manual ? "Quitar" : "No es mía"))),
        h("td", { class: "amt" }, s.amount ? fmtMoney(s.amount) + " / " + s.period.label : "?"),
        h("td", { class: "next" }, fmtDay(s.next) + (s.estimated ? " (estimada)" : "")),
        h("td", { class: "left" },
          h("div", { class: "left-n" }, s.daysLeft === 1 ? "1 día" : s.daysLeft + " días"),
          h("div", { class: "bar" }, h("span", { style: "width:" + pct + "%" })),
          h("div", { class: "svc-note" }, "de " + s.periodDays + " del periodo")));
    });

    const trials = (state.trials || []).map((t) => {
      const days = Math.max(0, Math.round((t.end - Date.now()) / 864e5));
      return h("li", {}, h("strong", {}, t.name), ": empieza a cobrar el " + fmtDay(t.end) + " (" + (days === 1 ? "queda 1 día" : "quedan " + days + " días") + ").");
    });
    const hiddenCount = (p.hidden || []).length;

    $("subs").replaceChildren(
      h("div", { class: "subs-head" },
        h("p", { class: "small" }, "Lo que pagas cada mes y cuántos días te quedan pagados hasta el próximo cobro. Debajo, las pruebas gratis y cuándo empiezan a cobrar."),
        h("div", { class: "stats" },
          h("div", {}, h("div", { class: "stat-l" }, "Gasto al mes"), h("div", { class: "stat-n" }, fmtMoney({ value: total, cur: main })),
            Object.keys(others).length ? h("div", { class: "svc-note" }, "+ " + Object.entries(others).map(([c, v]) => fmtMoney({ value: v, cur: c })).join(" + ")) : null),
          h("div", {}, h("div", { class: "stat-l" }, "Suscripciones activas"), h("div", { class: "stat-n" }, subs.length)))),
      subs.length ? h("div", { class: "table-wrap" }, h("table", { class: "subs" },
        h("thead", {}, h("tr", {}, h("th", {}, "Servicio"), h("th", {}, "Importe"), h("th", {}, "Próximo cobro"), h("th", {}, "Días pagados que te quedan"))),
        h("tbody", {}, ...rows))) : h("div", { class: "empty" }, "No he encontrado suscripciones activas en tu correo."),
      h("div", { class: "subs-tools" },
        h("button", { onclick: addSub }, "+ Añadir una a mano"),
        hiddenCount ? h("button", { class: "link", onclick: () => { const q = prefs(); q.hidden = []; savePrefs(q); renderSubs(); } }, "Mostrar ocultas (" + hiddenCount + ")") : null),
      h("div", { id: "subForm" }),
      h("h4", {}, "Pruebas gratis"),
      trials.length ? h("ul", { class: "trials" }, ...trials) : h("p", { class: "small" }, "No tienes ninguna prueba gratis activa ahora mismo. Cuando empieces una, aparecerá aquí con los días que te quedan antes del primer cobro."),
      h("p", { class: "small" }, "Sale de tus recibos y avisos de cobro en Gmail del último año. Si una fecha pone «estimada», el servicio no avisa de la renovación y se calcula a partir del último cobro o del alta. Lo que ocultes, corrijas o añadas a mano se guarda solo en este navegador.")
    );
  }

  function hideSub(s) {
    const p = prefs();
    if (s.manual) p.manual = (p.manual || []).filter((m) => "manual:" + m.id !== s.key);
    else p.hidden = [...new Set([...(p.hidden || []), s.key])];
    savePrefs(p);
    renderSubs();
  }

  function subForm(title, fields, onSave) {
    const box = $("subForm");
    const inputs = {};
    const row = (label, el) => h("label", {}, h("span", {}, label), el);
    const curSel = h("select", {}, ...["€", "R$", "$", "£"].map((c) => h("option", { value: c }, CODES[c] || c)));
    curSel.value = fields.cur || "€";
    inputs.cur = curSel;
    const form = h("form", { class: "sub-form", onsubmit: (ev) => {
      ev.preventDefault();
      const value = parseFloat(String(inputs.value.value).replace(",", "."));
      onSave({
        name: inputs.name ? inputs.name.value.trim() : "", value: isNaN(value) ? 0 : value, cur: inputs.cur.value,
        day: inputs.day ? Math.min(31, Math.max(1, parseInt(inputs.day.value, 10) || 1)) : 0,
        yearly: inputs.yearly ? inputs.yearly.value === "y" : false, note: inputs.note ? inputs.note.value.trim() : "",
      });
      box.replaceChildren();
    } },
      h("h4", {}, title),
      fields.name !== undefined ? row("Nombre", inputs.name = h("input", { required: "required", value: fields.name, placeholder: "Por ejemplo, alquiler" })) : null,
      row("Importe", h("span", { class: "inline" }, inputs.value = h("input", { inputmode: "decimal", value: fields.value || "", placeholder: "0,00" }), curSel)),
      fields.day !== undefined ? row("Día de cobro", inputs.day = h("input", { type: "number", min: "1", max: "31", value: fields.day || 1 })) : null,
      fields.yearly !== undefined ? row("Frecuencia", inputs.yearly = h("select", {}, h("option", { value: "m" }, "Cada mes"), h("option", { value: "y" }, "Cada año"))) : null,
      fields.note !== undefined ? row("Nota", inputs.note = h("input", { value: fields.note, placeholder: "Opcional" })) : null,
      h("div", { class: "inline" }, h("button", { class: "primary", type: "submit" }, "Guardar"), h("button", { type: "button", onclick: () => box.replaceChildren() }, "Cancelar")));
    box.replaceChildren(form);
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function editSub(s) {
    subForm("Importe de " + s.name, { value: s.amount ? String(s.amount.value).replace(".", ",") : "", cur: s.amount ? s.amount.cur : "€" }, (v) => {
      const p = prefs();
      if (s.manual) {
        const m = (p.manual || []).find((x) => "manual:" + x.id === s.key);
        if (m) { m.value = v.value; m.cur = v.cur; }
      } else {
        p.edits = Object.assign({}, p.edits, { [s.key]: { value: v.value, cur: v.cur } });
      }
      savePrefs(p);
      renderSubs();
    });
  }

  function addSub() {
    subForm("Añadir una suscripción a mano", { name: "", value: "", cur: "€", day: new Date().getDate(), yearly: false, note: "" }, (v) => {
      const p = prefs();
      p.manual = [...(p.manual || []), Object.assign({ id: Date.now().toString(36) }, v)];
      savePrefs(p);
      renderSubs();
    });
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
        const r = ZenSubs.detect(d.receipts); state.subs = r.subs; state.trials = r.trials; state.subsError = "";
      } else {
        const [mails, events] = await Promise.all([fetchMails(days), fetchEvents()]);
        state.mails = mails; state.events = events;
        state.subsError = "";
        // Los recibos son de todo el año, no dependen del periodo elegido: se leen una vez por sesión.
        if (!state.subs) {
          try { const r = ZenSubs.detect(await fetchSubscriptionMails()); state.subs = r.subs; state.trials = r.trials; }
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
    const inDays = (d) => new Date(now + d * 864e5).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const rc = (from, subject, body, daysAgo) => ({ id: "demo" + Math.random().toString(36).slice(2), from, subject, snippet: body.slice(0, 160), body, date: ago(daysAgo) });
    const receipts = [
      rc("Apple <no_reply@email.apple.com>", "Your invoice from Apple.", "Invoice Apple Account: demo@ejemplo.com iCloud iCloud+ with 200 GB (Monthly) Renews " + inDays(9) + " 2,99 €", 21),
      rc("Spotify <no-reply@spotify.com>", "Confirmación de tu pedido de \"Premium Individual\"", "¡Gracias por tu pedido! Aceptas que se te cobrará automáticamente la tarifa de 10,99 € cada mes hasta que la canceles.", 70),
      rc("Gimnasio Centro <cobros@gimnasiocentro.es>", "Recibo de tu cuota mensual", "Cuota mensual de tu suscripción: importe 34,90 €", 26),
      rc("Gimnasio Centro <cobros@gimnasiocentro.es>", "Recibo de tu cuota mensual", "Cuota mensual de tu suscripción: importe 34,90 €", 56),
      rc("Nube Fotos <billing@nubefotos.com>", "Your subscription has been cancelled", "Your subscription has been cancelled and will not renew.", 15),
      rc("Nube Fotos <billing@nubefotos.com>", "Your receipt", "Monthly subscription. Amount paid €4.99", 45),
      rc("Vídeo Stream <info@videostream.com>", "Empieza tu prueba gratuita", "Tu prueba gratuita termina el " + inDays(6) + ". Primer cobro de 7,99 € al mes.", 24),
    ];
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
