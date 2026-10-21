// Detección de suscripciones a partir de correos (sin IA, todo en el navegador).
// Cada correo se convierte en un "evento" (alta, cobro, baja, prueba gratis) de un servicio,
// y con los eventos de cada servicio se calcula si sigue activo, cuánto cuesta y cuándo cobra.
(function (root) {
  "use strict";

  const DAY = 864e5;

  /* ---------- Catálogo de servicios conocidos ---------- */
  // match: se busca en remitente + asunto. only: además tiene que aparecer en el texto (para remitentes
  // que mandan de todo, como Uber o Amazon). cycleDays: servicios que cobran cada N días y no por mes.
  const CATALOG = [
    { key: "claude", name: "Claude", match: /anthropic/i, plan: /suscripci[oó]n de (Pro|Max|Team)|(Pro|Max|Team) (?:plan|subscription)|Claude (Pro|Max|Team)/i },
    { key: "chatgpt", name: "ChatGPT", match: /openai/i, plan: /ChatGPT (Plus|Pro|Team)/i },
    { key: "spotify", name: "Spotify", match: /spotify/i, plan: /(Premium(?: para Estudiantes| for Students| Individual| Duo| Familiar| Family)?)/i },
    { key: "netflix", name: "Netflix", match: /netflix/i },
    { key: "disney", name: "Disney+", match: /disney/i },
    { key: "max", name: "Max", match: /@(?:[\w.]+\.)?(?:hbomax|max)\.com/i },
    { key: "prime", name: "Amazon Prime", match: /amazon/i, only: /\bPrime\b/ },
    { key: "youtube", name: "YouTube Premium", match: /youtube|google/i, only: /YouTube (Premium|Music)/i },
    { key: "googleone", name: "Google One", match: /google/i, only: /Google One/i },
    { key: "uberone", name: "Uber One", match: /uber/i, only: /Uber One/i },
    { key: "ifood", name: "Clube iFood", match: /ifood/i, only: /Clube/i, cycleDays: 30 },
    { key: "rappi", name: "Rappi Prime", match: /rappi/i, only: /Prime|Pro\b/i },
    { key: "glovo", name: "Glovo Prime", match: /glovo/i, only: /Prime/i },
    { key: "microsoft", name: "Microsoft 365", match: /microsoft/i, only: /365|Game Pass/i },
    { key: "adobe", name: "Adobe", match: /adobe/i },
    { key: "dropbox", name: "Dropbox", match: /dropbox/i },
    { key: "notion", name: "Notion", match: /notion/i },
    { key: "canva", name: "Canva", match: /canva/i },
    { key: "linkedin", name: "LinkedIn Premium", match: /linkedin/i, only: /Premium/i },
    { key: "duolingo", name: "Duolingo", match: /duolingo/i },
    { key: "audible", name: "Audible", match: /audible/i },
    { key: "playstation", name: "PlayStation Plus", match: /playstation|sony/i, only: /Plus/i },
    { key: "deezer", name: "Deezer", match: /deezer/i },
    { key: "crunchyroll", name: "Crunchyroll", match: /crunchyroll/i },
    { key: "dazn", name: "DAZN", match: /dazn/i },
    { key: "filmin", name: "Filmin", match: /filmin/i },
    { key: "strava", name: "Strava", match: /strava/i },
  ];

  /* ---------- Vocabulario (español, inglés y portugués) ---------- */
  const RE = {
    cancel: /(ya no tienes|se ha cancelado|has cancelado|\bcancelad[ao]\b|cancell?ed\b|has been cancell?ed|subscription (has )?ended|suscripci[oó]n (ha )?(finalizado|terminado|caducado|expirado)|assinatura (foi )?cancelada|cancelamento confirmado)/i,
    start: /(bienvenid[oa] a|welcome to|suscripci[oó]n .{0,30}(confirmada|activada|est[aá] activa)|subscription .{0,20}(confirmed|is active|started)|gracias por (iniciar|suscribirte|tu pedido|su pedido)|thanks for (subscribing|your order)|agora voc[eê] faz parte|[eé] seu!|assinatura (confirmada|ativada)|ya eres premium|you('re| are) now (a )?(member|premium|subscribed))/i,
    charge: /(recibo|receipt|invoice|factura|pago .{0,25}(realizado|confirmado|correctamente)|confirmaci[oó]n de pago|payment (received|confirmation|successful)|cargo total|se ha realizado el cargo|has been charged|pagamento (aprovado|confirmado|realizado)|cobran[cç]a)/i,
    trial: /(prueba gratu?ita|free trial|per[ií]odo de prueba|teste gr[aá]tis|primer mes gratis|first month free)/i,
    fail: /(problema con (tu|su) forma de pago|no (podemos|hemos podido) (procesar|realizar)|payment (failed|declined)|update your payment|actualiza.{0,25}(forma|m[eé]todo) de pago)/i,
    subWords: /(suscripci|subscription|membres|membership|assinatura|renews|se renueva|renovaci|mensual|monthly|mensal|per month|al mes|\/mes|\/month)/i,
    monthly: /(\(Monthly\)|\(Mensual\)|monthly premium|mensual|monthly|mensal|cada mes|every month|per month|al mes|\/mes|\/month|por mes)/i,
    yearly: /(\(Annual\)|\(Anual\)|\(Yearly\)|anual(mente)?|annual(ly)?|yearly|per year|al a[ñn]o|\/a[ñn]o|\/year|por a[ñn]o)/i,
    payApple: /(forma de pago:?\s*apple|paid with apple|m[eé]todo de pago:?\s*apple)/i,
  };

  const NEXT_CUE = /(?:renews|se renueva(?: el)?|renovaci[oó]n(?: el)?:?|next billing date:?|pr[oó]ximo (?:cargo|cobro|pago)(?: ser[aá])?(?: el)?|next (?:payment|charge|billing)(?: date)?(?: is| on| will be)?:?|renova(?:r[aá])? em|pr[oó]xima cobran[cç]a(?: em| ser[aá])?|will renew on|renewal date:?)\s*([^\n|]{4,40})/gi;
  const TRIAL_END_CUE = /(?:prueba(?: gratuita)? (?:termina|finaliza|acaba)(?: el)?|trial ends(?: on)?|primer (?:cobro|cargo)(?: ser[aá])?(?: el)?|first (?:charge|payment)(?: will be)?(?: on)?|teste gr[aá]tis termina em|primeira cobran[cç]a(?: em| ser[aá])?)\s*([^\n|]{4,40})/i;

  /* ---------- Fechas ---------- */
  const MONTHS = {
    ene: 0, jan: 0, feb: 1, fev: 1, mar: 2, abr: 3, apr: 3, may: 4, mai: 4, jun: 5, jul: 6,
    ago: 7, aug: 7, sep: 8, set: 8, oct: 9, out: 9, nov: 10, dic: 11, dec: 11, dez: 11,
  };

  function parseDate(s) {
    if (!s) return null;
    let m = /(\d{1,2})(?:st|nd|rd|th)?(?:\s+de)?\s+([a-zA-ZáéíóúçÁÉÍÓÚ]{3,12})\.?(?:\s+de)?,?\s+(\d{4})/.exec(s);
    if (m) return mk(m[3], m[2], m[1]);
    m = /([a-zA-Z]{3,12})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s);
    if (m) return mk(m[3], m[1], m[2]);
    m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
    return null;
    function mk(y, mon, d) {
      const k = mon.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").slice(0, 3);
      if (!(k in MONTHS)) return null;
      return new Date(+y, MONTHS[k], +d).getTime();
    }
  }

  function addPeriod(t, period, n) {
    if (period.days) return t + period.days * n * DAY;
    const d = new Date(t);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + period.months * n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d.getTime();
  }

  function startOfToday(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /* ---------- Importes ---------- */
  const MONEY_SRC = "(R\\$|US\\$|€|£|\\$)\\s?(\\d{1,4}(?:[.,]\\d{3})*[.,]\\d{2})(?!\\d)|(\\d{1,4}(?:[.,]\\d{3})*[.,]\\d{2})\\s?(€|EUR|USD|BRL|GBP|R\\$)";
  const CUR = { "EUR": "€", "€": "€", "USD": "$", "US$": "$", "$": "$", "BRL": "R$", "R$": "R$", "GBP": "£", "£": "£" };

  function toNumber(s) {
    // "1.234,56" o "1,234.56" o "18.00" o "6,49"
    const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
    const intPart = s.slice(0, lastSep).replace(/[.,]/g, "");
    return parseFloat(intPart + "." + s.slice(lastSep + 1));
  }

  function allMoney(text) {
    const re = new RegExp(MONEY_SRC, "gi");
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const cur = CUR[(m[1] || m[4] || "").toUpperCase()] || "€";
      const value = toNumber(m[2] || m[3]);
      if (value > 0) out.push({ value, cur, index: m.index });
    }
    return out;
  }

  function pickAmount(text) {
    const list = allMoney(text);
    if (!list.length) return null;
    const near = /(tarifa|total|importe|cargo|amount paid|amount|precio|price|valor|charged|cobrar[aá]|cuota|paid)[^\d€$£R]{0,40}$/i;
    for (const m of list) {
      if (near.test(text.slice(Math.max(0, m.index - 60), m.index))) return { value: m.value, cur: m.cur };
    }
    return { value: list[0].value, cur: list[0].cur };
  }

  /* ---------- Texto del correo ---------- */
  function senderName(from) {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from || "");
    if (m) return m[1].trim() || m[2];
    return (from || "").trim();
  }

  function clean(s) {
    return (s || "").replace(/[͏​-‍­]/g, "").replace(/[ \t ]+/g, " ").replace(/\n\s*\n+/g, "\n");
  }

  /* ---------- Correo -> eventos ---------- */
  function catalogFor(mail, text) {
    const head = mail.from + " " + mail.subject;
    for (const c of CATALOG) {
      if (!c.match.test(head)) continue;
      if (c.only && !c.only.test(head)) continue;
      return c;
    }
    return null;
  }

  function periodFrom(text, cat) {
    if (cat && cat.cycleDays) return { days: cat.cycleDays, label: "mes" };
    if (RE.monthly.test(text)) return { months: 1, label: "mes" };
    if (RE.yearly.test(text)) return { months: 12, label: "año" };
    return null;
  }

  function nextDateIn(text) {
    NEXT_CUE.lastIndex = 0;
    let m;
    while ((m = NEXT_CUE.exec(text))) {
      const t = parseDate(m[1]);
      if (t) return t;
    }
    // Recibos tipo Stripe: "Oct 13–Nov 13, 2026" (el periodo pagado termina en el próximo cobro).
    const range = /\b([A-Za-z]{3,9}\.? \d{1,2})\s?[–-]\s?([A-Za-z]{3,9}\.? \d{1,2},? \d{4})/.exec(text);
    if (range) return parseDate(range[2]);
    return null;
  }

  // Apple manda una factura con una línea por producto: "iCloud+ with 2 TB (Monthly) Renews 28 October 2026 9,99 €".
  function appleEvents(mail, text, base) {
    const events = [];
    const flat = text.replace(/\s+/g, " ");
    const re = new RegExp("([^()|]{3,70}?)\\s*\\((Monthly|Mensual|Mensal|Annual|Anual|Yearly|Weekly|Semanal)\\)\\s*(?:Renews|Se renueva el|Renovaci[oó]n:?|Renova em)\\s*(.{6,30}?\\d{4})\\s*(?:" + MONEY_SRC + ")", "gi");
    let m;
    while ((m = re.exec(flat))) {
      let name = m[1].replace(/.*(?:@\S+|:)\s*/, "").trim().replace(/\s+with\s+/i, " ");
      const toks = name.split(" ");
      if (toks.length > 1 && toks[1].toLowerCase().startsWith(toks[0].toLowerCase())) name = toks.slice(1).join(" ");
      const yearly = /annual|anual|yearly/i.test(m[2]);
      events.push(Object.assign({}, base, {
        key: "apple:" + name.toLowerCase(), name, type: "charge",
        amount: { value: toNumber(m[5] || m[6]), cur: CUR[(m[4] || m[7] || "").toUpperCase()] || "€" },
        next: parseDate(m[3]), period: yearly ? { months: 12, label: "año" } : { months: 1, label: "mes" },
      }));
    }
    if (/AppleCare/i.test(flat)) {
      const device = (/(iPad|iPhone|MacBook|iMac|Mac|Apple Watch|AirPods)/.exec(flat) || [])[1] || "";
      const name = "AppleCare+" + (device ? " " + device : "");
      const renew = /Next Contract Renewal Date:?\s*([^|\n]{6,30}?\d{4})/i.exec(flat);
      events.push(Object.assign({}, base, {
        key: "apple:" + name.toLowerCase(), name, type: "charge", amount: pickAmount(flat),
        next: nextDateIn(flat), period: /monthly premium|monthly policy|mensual/i.test(flat) ? { months: 1, label: "mes" } : periodFrom(flat, null),
        note: renew ? "Seguro mensual; el contrato se renueva el " + fmtDate(parseDate(renew[1])) + "." : "",
      }));
    }
    return events;
  }

  function mailToEvents(mail) {
    const text = clean(mail.body || mail.snippet || "");
    const head = mail.subject + " " + clean(mail.snippet || "");
    const base = { id: mail.id, date: mail.date, from: mail.from };

    if (/@(?:[\w.]+\.)?apple\.com/i.test(mail.from) && /receipt|invoice|recibo|factura|billing/i.test(mail.subject + " " + text.slice(0, 300))) {
      return appleEvents(mail, text, base);
    }

    let type = null;
    if (RE.cancel.test(head)) type = "cancel";
    else if (RE.fail.test(head)) type = "fail";
    else if (RE.trial.test(head) && !RE.charge.test(mail.subject)) type = "trial";
    else if (RE.start.test(head)) type = "start";
    else if (RE.charge.test(head)) type = "charge";
    if (!type) return [];

    const cat = catalogFor(mail, text);
    let name, key;
    if (cat) {
      key = cat.key;
      name = cat.name;
      const plan = cat.plan && (cat.plan.exec(mail.subject) || cat.plan.exec(text.slice(0, 800)));
      const planName = plan && (plan[1] || plan[2] || plan[3]);
      if (planName && !name.toLowerCase().includes(planName.toLowerCase())) name += " " + planName.replace(/\s+/g, " ");
    } else {
      if (!RE.subWords.test(head + " " + text.slice(0, 3000))) return [];
      // Stripe y similares: "Your receipt from Empresa, Limited #1234"
      const fromCo = /(?:receipt|recibo|factura|invoice) (?:from|de) ([^#\n,]{2,40})/i.exec(mail.subject);
      name = (fromCo ? fromCo[1] : senderName(mail.from)).replace(/\b(Ireland|Limited|Ltd|Inc|LLC|S\.?L\.?|S\.?A\.?|GmbH|B\.?V\.?)\b\.?/gi, "").trim();
      key = "x:" + name.toLowerCase();
    }

    const ev = Object.assign({}, base, {
      key, name, type, cat,
      amount: type === "cancel" || type === "fail" ? null : pickAmount(head + " \n" + text),
      next: type === "charge" || type === "start" ? nextDateIn(text) : null,
      period: periodFrom(text, cat),
      viaApple: RE.payApple.test(text),
      subHead: RE.subWords.test(head),
    });
    if (type === "trial") {
      const end = TRIAL_END_CUE.exec(text);
      ev.trialEnd = end ? parseDate(end[1]) : null;
    }
    return [ev];
  }

  /* ---------- Eventos -> suscripciones ---------- */
  function fmtDate(t) {
    if (!t) return "";
    return new Date(t).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
  }

  function detect(mails, now) {
    now = now || Date.now();
    const today = startOfToday(now);
    const groups = new Map();
    mails.forEach((m) => mailToEvents(m).forEach((e) => {
      // Recibos de Stripe de Anthropic y el correo de alta de Claude son el mismo servicio.
      if (/^x:anthropic/.test(e.key)) { e.key = "claude"; e.name = "Claude"; }
      if (!groups.has(e.key)) groups.set(e.key, []);
      groups.get(e.key).push(e);
    }));

    const subs = [], trials = [];
    groups.forEach((events, key) => {
      events.sort((a, b) => a.date - b.date);
      const positive = events.filter((e) => e.type === "charge" || e.type === "start");
      const lastPos = positive[positive.length - 1];
      const lastCancel = events.filter((e) => e.type === "cancel").pop();
      const trial = events.filter((e) => e.type === "trial").pop();

      if (trial && trial.trialEnd && trial.trialEnd >= today && !(lastCancel && lastCancel.date > trial.date)) {
        trials.push({ key, name: bestName(events), end: trial.trialEnd, id: trial.id });
      }
      if (!lastPos) return;
      if (lastCancel && lastCancel.date > lastPos.date) return;
      const charges = positive.filter((e) => e.type === "charge");
      // Remitentes desconocidos: hace falta al menos un cobro, y que hable de suscripción en el asunto
      // o que cobre lo mismo cada mes (así no cuentan los recibos de viajes o pedidos sueltos).
      if (key.startsWith("x:")) {
        if (!charges.length) return;
        if (!events.some((e) => e.subHead) && !regularMonthly(charges)) return;
      }

      const withPeriod = [...events].reverse().find((e) => e.period);
      let period = withPeriod ? withPeriod.period : null;
      if (!period && charges.length >= 2) {
        const gaps = [];
        for (let i = 1; i < charges.length; i++) gaps.push((charges[i].date - charges[i - 1].date) / DAY);
        gaps.sort((a, b) => a - b);
        const g = gaps[Math.floor(gaps.length / 2)];
        if (g >= 25 && g <= 35) period = { months: 1, label: "mes" };
        else if (g >= 340 && g <= 390) period = { months: 12, label: "año" };
      }
      if (!period) period = { months: 1, label: "mes" };

      const withNext = [...events].reverse().find((e) => e.next && e.date >= lastPos.date - DAY);
      let next = withNext ? withNext.next : null;
      let estimated = false;
      let anchor = next;
      if (!next) { anchor = lastPos.date; next = addPeriod(lastPos.date, period, 1); estimated = true; }
      let guard = 0;
      while (next < today && guard++ < 400) { next = addPeriod(next, period, 1); estimated = true; }
      // Si hace más de dos periodos que no sabemos nada de él, probablemente ya no está activo.
      // (Solo para servicios que mandan recibos: los que no, como Spotify, siguen activos hasta que avisen de la baja.)
      const stale = charges.length > 0 && estimated && addPeriod(anchor, period, 2) < today;
      if (stale && !(withNext && withNext.next >= today)) return;

      const prev = addPeriod(next, period, -1);
      const withAmount = [...events].reverse().find((e) => e.amount && e.type !== "trial");
      const name = bestName(events);
      const first = positive[0];
      const notes = [];
      if (events.some((e) => e.viaApple)) notes.push("Se paga con Apple.");
      const apple = events.find((e) => e.note);
      if (apple) notes.push(apple.note);
      if (!charges.length) notes.push("Alta el " + fmtDate(first.date) + ". No manda recibo cada mes: fecha calculada.");
      else if (estimated) notes.push("Fecha calculada a partir del último cobro.");
      else notes.push("Fecha confirmada en el correo de " + (key.startsWith("apple:") ? "Apple" : name.split(" ")[0]) + ".");

      subs.push({
        key, name, amount: withAmount ? withAmount.amount : null, period, next, estimated,
        periodDays: Math.round((next - prev) / DAY),
        daysLeft: Math.max(0, Math.round((next - today) / DAY)),
        note: notes.join(" "), lastId: lastPos.id,
      });
    });
    subs.sort((a, b) => a.next - b.next);
    return { subs, trials };
  }

  function regularMonthly(charges) {
    if (charges.length < 2) return false;
    const gaps = [];
    for (let i = 1; i < charges.length; i++) gaps.push((charges[i].date - charges[i - 1].date) / DAY);
    const sameAmount = charges.every((c) => c.amount && charges[0].amount && c.amount.value === charges[0].amount.value);
    return sameAmount && gaps.every((g) => g >= 25 && g <= 35);
  }

  function bestName(events) {
    // El nombre más largo suele ser el más completo ("Spotify Premium para Estudiantes" frente a "Spotify").
    return events.map((e) => e.name).filter(Boolean).sort((a, b) => b.length - a.length)[0];
  }

  // Consulta de Gmail: asuntos típicos de altas, cobros, bajas y pruebas, en cualquier pestaña.
  const QUERY = "newer_than:400d subject:(recibo OR receipt OR invoice OR factura OR suscripción OR suscripcion OR subscription OR assinatura " +
    "OR premium OR clube OR membership OR membresía OR pago OR payment OR pagamento OR cobrança OR cargo OR renovación OR renewal " +
    "OR \"prueba gratuita\" OR \"free trial\" OR cancelada OR cancelled OR canceled OR \"ya no tienes\" OR bienvenido OR welcome OR \"Uber One\" OR Prime)";

  // Filtro rápido con asunto y fragmento, para descargar el correo completo solo cuando hace falta.
  function isCandidate(mail) {
    const head = mail.subject + " " + clean(mail.snippet || "");
    if (/@(?:[\w.]+\.)?apple\.com/i.test(mail.from) && /receipt|invoice|recibo|factura/i.test(mail.subject)) return true;
    return RE.cancel.test(head) || RE.fail.test(head) || RE.trial.test(head) || RE.start.test(head) || RE.charge.test(head);
  }

  root.ZenSubs = { detect, mailToEvents, isCandidate, parseDate, pickAmount, addPeriod, QUERY, CATALOG };
})(typeof window !== "undefined" ? window : globalThis);
