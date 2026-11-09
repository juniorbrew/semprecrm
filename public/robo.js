/*
 * SempreCRM site bot - vanilla JS, no dependencies. Embed with:
 *   <script src=".../robo.js" data-robo="PUBLIC_KEY" async></script>
 * Everything is built with createElement + textContent inside a Shadow DOM
 * (config and visitor text never become markup). Nothing is sent before the
 * visitor finishes and ticks the consent box; answers stay in sessionStorage
 * (this tab only) so a closed chat resumes. window.SempreRobo.mount({config,
 * preview, container, submit}) powers the Settings preview: same widget,
 * unsaved config, no call to the public API.
 */
(function () {
  'use strict';

  var script = document.currentScript || document.querySelector('script[data-robo]');
  var DAY = 864e5;

  var TEXT = {
    pt: {
      open: 'Abrir conversa',
      close: 'Fechar conversa',
      send: 'Enviar',
      skip: 'Pular',
      placeholder: 'Digite aqui',
      required: 'Preciso dessa resposta para continuar.',
      name: 'Escreva só o seu nome, sem links, e-mails ou números.',
      phone: 'Esse número não parece válido. Informe com DDD, por exemplo (11) 98765-4321.',
      email: 'Esse e-mail não parece válido. Confira e tente de novo.',
      consentIntro: 'Para terminar, preciso da sua autorização.',
      consentNeeded: 'Marque a caixa para continuar.',
      privacy: 'Política de privacidade',
      sending: 'Enviando',
      error: 'Não foi possível enviar agora. Tente de novo em instantes.',
      retry: 'Tentar de novo',
      whatsapp: 'Continuar no WhatsApp',
    },
    en: {
      open: 'Open chat',
      close: 'Close chat',
      send: 'Send',
      skip: 'Skip',
      placeholder: 'Type here',
      required: 'I need this answer to continue.',
      name: 'Please write only your name, without links, emails or numbers.',
      phone: 'That number does not look valid. Include the area code, e.g. (11) 98765-4321.',
      email: 'That email does not look valid. Please check it and try again.',
      consentIntro: 'To finish, I need your permission.',
      consentNeeded: 'Tick the box to continue.',
      privacy: 'Privacy policy',
      sending: 'Sending',
      error: 'We could not send this right now. Please try again shortly.',
      retry: 'Try again',
      whatsapp: 'Continue on WhatsApp',
    },
  };

  var CSS =
    ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,sans-serif}' +
    '.wrap{position:fixed;bottom:20px;z-index:2147483000;display:flex;flex-direction:column;gap:12px;max-width:calc(100vw - 24px)}' +
    '.wrap.preview{position:absolute}' +
    '.wrap.right{right:20px;align-items:flex-end}.wrap.left{left:20px;align-items:flex-start}' +
    '.launch{display:flex;align-items:center;gap:10px;border:0;background:transparent;padding:0;cursor:pointer;color:#111}' +
    '.wrap.left .launch{flex-direction:row-reverse}' +
    '.label{background:#fff;color:#111;padding:8px 12px;border-radius:12px;font-size:14px;box-shadow:0 2px 12px rgba(0,0,0,.18);max-width:200px}' +
    '.dot{width:56px;height:56px;border-radius:50%;background:var(--c);color:var(--t);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.25)}' +
    '.dot svg{width:26px;height:26px;fill:currentColor}' +
    'button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}' +
    '.panel{display:none;flex-direction:column;width:360px;max-width:100%;height:520px;max-height:calc(100vh - 110px);background:#fff;color:#111;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.28);overflow:hidden;animation:pop .18s ease-out}' +
    '.wrap.open .panel{display:flex}.wrap.open .launch{display:none}' +
    '@keyframes pop{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
    '.head{display:flex;align-items:center;justify-content:space-between;background:var(--c);color:var(--t);padding:12px 14px;font-weight:600;font-size:15px}' +
    '.x{border:0;background:transparent;color:inherit;font-size:24px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:8px}' +
    '.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f5f6f8}' +
    '.msg{max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}' +
    '.msg.bot{align-self:flex-start;background:#fff;color:#111;border:1px solid #e3e5e8}' +
    '.msg.me{align-self:flex-end;background:var(--c);color:var(--t)}' +
    '.typing{align-self:flex-start;display:flex;gap:4px;padding:12px;background:#fff;border:1px solid #e3e5e8;border-radius:14px}' +
    '.typing i{width:6px;height:6px;border-radius:50%;background:#777;animation:blink 1s infinite}' +
    '.typing i+i{animation-delay:.2s}.typing i+i+i{animation-delay:.4s}' +
    '@keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}' +
    '.foot{padding:10px 12px;border-top:1px solid #e3e5e8;background:#fff;display:flex;flex-direction:column;gap:8px}' +
    '.row{display:flex;gap:8px}.row input[type=text],.row input[type=email],.row input[type=tel]{flex:1;min-width:0;padding:10px 12px;border:1px solid #b9bec7;border-radius:10px;font-size:16px;color:#111;background:#fff}' +
    '.btn{border:0;border-radius:10px;padding:10px 14px;font-size:14px;font-weight:600;cursor:pointer;background:var(--c);color:var(--t);text-decoration:none;text-align:center}' +
    '.btn.alt{background:#fff;color:#111;border:1px solid #b9bec7}' +
    '.choices{display:flex;flex-wrap:wrap;gap:8px}' +
    '.consent{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.4;color:#222}' +
    '.consent input{margin-top:3px;width:18px;height:18px;flex:none}.consent a{color:#1d4ed8}' +
    '.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}' +
    '@media (max-width:480px){.wrap.open:not(.preview){inset:0;bottom:0;right:0;left:0;max-width:none;gap:0}' +
    '.wrap.open:not(.preview) .panel{width:100vw;height:100vh;height:100dvh;max-height:none;border-radius:0}}' +
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}';

  function pickLang(forced) {
    if (forced === 'en' || forced === 'pt') return forced;
    return /^en/i.test(navigator.language || '') ? 'en' : 'pt';
  }

  function safeColor(c) {
    return /^#[0-9a-f]{6}$/i.test(String(c)) ? String(c) : '#2563eb';
  }

  function textOn(hex) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? '#111111' : '#ffffff';
  }

  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }

  // Defensive copy of the config: unknown shapes become empty strings/lists.
  function normalize(c) {
    c = c || {};
    var k = c.consent || {};
    return {
      name: str(c.name, 80) || 'Chat',
      color: safeColor(c.color),
      bubbleText: str(c.bubbleText, 80),
      side: c.side === 'left' ? 'left' : 'right',
      greeting: str(c.greeting, 400),
      thanks: str(c.thanks, 400),
      whatsapp: c.whatsapp === true,
      consent: { text: str(k.text, 400), linkUrl: httpsUrl(k.linkUrl) },
      questions: (Array.isArray(c.questions) ? c.questions.slice(0, 10) : [])
        .filter(function (q) { return q && typeof q.id === 'string' && typeof q.text === 'string'; })
        .map(function (q) {
          return {
            id: q.id.slice(0, 24),
            text: q.text.slice(0, 300),
            type: ['choice', 'name', 'phone', 'email'].indexOf(q.type) >= 0 ? q.type : 'text',
            options: (Array.isArray(q.options) ? q.options.slice(0, 6) : []).filter(function (o) { return typeof o === 'string'; }),
            required: q.required === true,
          };
        }),
    };
  }

  function httpsUrl(u) {
    try {
      var p = new URL(u);
      return p.protocol === 'https:' ? p.href : '';
    } catch {
      return '';
    }
  }

  function store(key) {
    var k = 'sempre-robo:' + key;
    function ls(fn) {
      try { return fn(window.sessionStorage); } catch { return null; } // storage blocked: chat still works
    }
    return {
      read: function () {
        var s = ls(function (l) { return JSON.parse(l.getItem(k)); });
        return s && s.exp > Date.now() && s.answers && typeof s.answers === 'object' ? s : null;
      },
      write: function (s) {
        s.exp = Date.now() + DAY;
        ls(function (l) { l.setItem(k, JSON.stringify(s)); });
      },
      clear: function () { ls(function (l) { l.removeItem(k); }); },
    };
  }

  function h(tag, props, kids) {
    var n = document.createElement(tag);
    props = props || {};
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      if (k === 'text') n.textContent = props[k];
      else if (k === 'class') n.className = props[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function icon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z');
    svg.appendChild(p);
    return svg;
  }

  // Same rules as the server (normalizeTypedPhone + isValidE164, EMAIL_RE).
  function validPhone(raw) {
    var d = raw.replace(/\D/g, '');
    if (d && raw.trim().charAt(0) !== '+') {
      if (d.indexOf('00') === 0) d = d.slice(2);
      else {
        var n = d.replace(/^0/, '');
        if (n.length === 10 || n.length === 11) d = '55' + n;
      }
    }
    return /^[1-9]\d{6,14}$/.test(d);
  }

  function validEmail(v) {
    return /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[^\s@<>"',;.]{2,}$/.test(v) && v.length <= 254;
  }

  // Shape of the questions: a saved chat is only resumed if it still matches.
  function signature(qs) {
    var t = qs.map(function (q) { return q.id + '|' + q.type + '|' + q.options.join('\u0001'); }).join('\u0002');
    var x = 5381;
    for (var i = 0; i < t.length; i++) x = ((x << 5) + x + t.charCodeAt(i)) | 0;
    return (x >>> 0).toString(36);
  }

  /** Builds one widget. `o`: { config, key, endpoint, preview, container, submit, lang }. */
  function build(cfg, o) {
    var T = TEXT[pickLang(o.lang)];
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var st = o.preview || !o.key ? null : store(o.key);
    var S = { open: false, started: false, i: 0, answers: {}, t0: 0, busy: false, finished: false };
    var sig = signature(cfg.questions);
    var vv = window.visualViewport;
    var prevOverflow = null;
    var timers = [];

    var host = h('div', { 'data-robo-host': '' });
    var root = host.attachShadow({ mode: 'open' });
    var color = cfg.color;
    var wrap = h('div', { class: 'wrap ' + cfg.side + (o.preview ? ' preview' : '') });
    wrap.style.setProperty('--c', color);
    wrap.style.setProperty('--t', textOn(color));

    var launch = h('button', { class: 'launch', type: 'button', 'aria-label': T.open, onclick: openPanel }, [
      cfg.bubbleText ? h('span', { class: 'label', text: cfg.bubbleText }) : null,
      h('span', { class: 'dot' }, [icon()]),
    ]);
    var closeBtn = h('button', { class: 'x', type: 'button', 'aria-label': T.close, text: '×', onclick: closePanel });
    var log = h('div', { class: 'log', role: 'log', 'aria-live': 'polite', });
    var zone = h('div');
    var hp = h('input', { class: 'hp', type: 'text', name: 'contact_ref', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    var foot = h('div', { class: 'foot' }, [zone, hp]);
    var panel = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'false', 'aria-label': cfg.name }, [
      h('div', { class: 'head' }, [h('span', { text: cfg.name }), closeBtn]),
      log,
      foot,
    ]);

    wrap.appendChild(panel);
    wrap.appendChild(launch);
    root.appendChild(h('style', { text: CSS }));
    root.appendChild(wrap);
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.open && !o.preview) closePanel();
      if (e.key === 'Tab' && S.open && fullScreen()) trap(e);
    });

    // Full-screen on small phones: the page behind must not be reachable.
    function fullScreen() {
      return !o.preview && !!(window.matchMedia && window.matchMedia('(max-width:480px)').matches);
    }

    function trap(e) {
      var els = Array.prototype.filter.call(panel.querySelectorAll('button,input,a[href]'), function (n) {
        return !n.disabled && n.getAttribute('tabindex') !== '-1';
      });
      if (!els.length) return;
      var first = els[0], last = els[els.length - 1], cur = root.activeElement;
      if (e.shiftKey && (cur === first || !cur)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (cur === last || !cur)) { e.preventDefault(); first.focus(); }
    }

    function fit() {
      if (!vv || !fullScreen()) return;
      panel.style.height = vv.height + 'px';
      wrap.style.top = vv.offsetTop + 'px';
    }

    function lock(on) {
      if (on && fullScreen()) {
        panel.setAttribute('aria-modal', 'true');
        if (prevOverflow === null) prevOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
        if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit(); }
      } else {
        panel.setAttribute('aria-modal', 'false');
        if (prevOverflow !== null) { document.documentElement.style.overflow = prevOverflow; prevOverflow = null; }
        if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
        panel.style.height = '';
        wrap.style.top = '';
      }
    }

    // The bot's own typing pause counts for everyone (reduced motion: shorter, still non-zero).
    function later(fn, ms) {
      timers.push(setTimeout(fn, reduced ? Math.min(ms, 300) : ms));
    }

    function scroll() {
      log.scrollTop = log.scrollHeight;
    }

    function msg(who, text) {
      var m = h('div', { class: 'msg ' + who, text: text });
      log.appendChild(m);
      scroll();
    }

    function focusZone() {
      if (!S.open) return;
      var f = zone.querySelector('input,button');
      if (f) f.focus();
    }

    function clearZone() {
      while (zone.firstChild) zone.removeChild(zone.firstChild);
    }

    function typing(then, text) {
      var t = h('div', { class: 'typing', 'aria-hidden': 'true' }, [h('i'), h('i'), h('i')]);
      log.appendChild(t);
      scroll();
      clearZone();
      later(function () {
        t.remove();
        if (text) msg('bot', text);
        then();
      }, Math.min(1200, 350 + (text ? text.length * 10 : 0)));
    }

    function persist() {
      if (st) st.write({ t0: S.t0, answers: S.answers, i: S.i, sig: sig });
    }

    function answer(q, value, shown) {
      if (value) {
        S.answers[q.id] = value;
        msg('me', shown || value);
      }
      S.i += 1;
      persist();
      ask();
    }

    function ask(error, prefill) {
      if (S.i >= cfg.questions.length) return consent();
      var q = cfg.questions[S.i];
      typing(function () { input(q, prefill); }, error || q.text);
    }

    function skipBtn(q) {
      return h('button', { class: 'btn alt', type: 'button', text: T.skip, onclick: function () { answer(q, ''); } });
    }

    function input(q, prefill) {
      clearZone();
      if (q.type === 'choice') {
        var box = h('div', { class: 'choices' });
        q.options.forEach(function (opt) {
          box.appendChild(h('button', { class: 'btn alt', type: 'button', text: opt, onclick: function () { answer(q, opt); } }));
        });
        zone.appendChild(box);
        if (!q.required) zone.appendChild(h('button', { class: 'btn alt', type: 'button', text: T.skip, onclick: function () { answer(q, ''); } }));
        return focusZone();
      }
      var type = q.type === 'email' ? 'email' : q.type === 'phone' ? 'tel' : 'text';
      var ac = q.type === 'email' ? 'email' : q.type === 'phone' ? 'tel' : q.type === 'name' ? 'name' : 'off';
      var field = h('input', {
        type: type, autocomplete: ac, maxlength: q.type === 'name' ? '80' : '500',
        placeholder: T.placeholder, 'aria-label': q.text,
      });
      if (prefill) field.value = prefill;
      var form = h('form', { class: 'row', novalidate: '' }, [field, h('button', { class: 'btn', type: 'submit', text: T.send })]);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = field.value.replace(/\s+/g, ' ').trim();
        if (!v) {
          if (q.required) return ask(T.required);
          return answer(q, '');
        }
        if (q.type === 'phone' && !validPhone(v)) return ask(T.phone, v);
        if (q.type === 'email' && !validEmail(v)) return ask(T.email, v);
        answer(q, v);
      });
      zone.appendChild(form);
      if (!q.required) zone.appendChild(skipBtn(q));
      focusZone();
    }

    function consent() {
      typing(function () {
        clearZone();
        var box = h('input', { type: 'checkbox', id: 'robo-consent' });
        var link = httpsUrl(cfg.consent.linkUrl);
        var label = h('label', { for: 'robo-consent', text: cfg.consent.text + ' ' });
        if (link) label.appendChild(h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: T.privacy }));
        var send = h('button', { class: 'btn', type: 'button', text: T.send });
        send.addEventListener('click', function () {
          if (!box.checked) return msg('bot', T.consentNeeded);
          submit();
        });
        zone.appendChild(h('div', { class: 'consent' }, [box, label]));
        zone.appendChild(send);
        focusZone();
      }, T.consentIntro);
    }

    function submit() {
      if (S.busy) return;
      S.busy = true;
      clearZone();
      var t = h('div', { class: 'typing', role: 'status', 'aria-label': T.sending }, [h('i'), h('i'), h('i')]);
      log.appendChild(t);
      scroll();
      var answers = {};
      for (var k in S.answers) if (Object.prototype.hasOwnProperty.call(S.answers, k)) answers[k] = S.answers[k];
      var send = o.submit
        ? Promise.resolve().then(function () { return o.submit(answers); }).then(function (b) { return { ok: true, body: b || {} }; })
        : post(o, { answers: answers, consent: true, contact_ref: hp.value, elapsed_ms: Date.now() - S.t0 });
      send.then(function (res) {
        S.busy = false;
        t.remove();
        if (res.ok) return done(res.body);
        if (res.status === 400) return rejected(res.body);
        fail(res.status === 429 || res.status >= 500);
      }, function () {
        S.busy = false;
        t.remove();
        fail(true);
      });
    }

    // The server refused an answer: go back to that question with what was typed.
    function rejected(b) {
      var err = (b && b.error) || '';
      var kind = err === 'invalid_phone' ? 'phone' : err === 'invalid_email' ? 'email' : err === 'invalid_name' ? 'name' : '';
      var at = -1;
      cfg.questions.forEach(function (q, j) {
        if (at < 0 && ((b && b.question === q.id) || (!(b && b.question) && kind && q.type === kind))) at = j;
      });
      if (at < 0) return fail(false);
      var q = cfg.questions[at], typed = S.answers[q.id] || '';
      delete S.answers[q.id];
      S.i = at;
      persist();
      ask(T[kind || 'required'] || T.required, typed);
    }

    function fail(retry) {
      msg('bot', T.error);
      clearZone();
      if (retry) zone.appendChild(h('button', { class: 'btn', type: 'button', text: T.retry, onclick: submit }));
      else zone.appendChild(h('button', { class: 'btn alt', type: 'button', text: T.close, onclick: closePanel }));
      focusZone();
    }

    function done(body) {
      S.finished = true;
      if (st) st.clear();
      msg('bot', cfg.thanks);
      clearZone();
      var url = typeof body.whatsapp_url === 'string' && body.whatsapp_url.indexOf('https://wa.me/') === 0 ? body.whatsapp_url : '';
      if (cfg.whatsapp && url) {
        zone.appendChild(h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer', text: T.whatsapp }));
      } else {
        zone.appendChild(h('button', { class: 'btn alt', type: 'button', text: T.close, onclick: closePanel }));
      }
      focusZone();
    }

    function start() {
      var saved = st && st.read();
      if (saved && !S.finished && saved.sig === sig) {
        S.t0 = Number(saved.t0) || Date.now();
        S.i = Math.min(Math.max(0, Number(saved.i) || 0), cfg.questions.length);
        if (cfg.greeting) msg('bot', cfg.greeting);
        for (var k = 0; k < S.i; k++) {
          var q = cfg.questions[k], a = saved.answers[q.id];
          msg('bot', q.text);
          // Only answers that are still valid for this question come back.
          if (typeof a === 'string' && (q.type !== 'choice' || q.options.indexOf(a) >= 0)) {
            S.answers[q.id] = a;
            msg('me', a);
          }
        }
        return ask();
      }
      S.t0 = Date.now();
      typing(ask, cfg.greeting);
    }

    function openPanel() {
      S.open = true;
      wrap.classList.add('open');
      lock(true);
      if (!S.started) {
        S.started = true;
        start();
      } else {
        focusZone();
      }
    }

    function closePanel() {
      S.open = false;
      wrap.classList.remove('open');
      lock(false);
      launch.focus();
    }

    (o.container || document.body).appendChild(host);
    if (o.open) openPanel();

    return {
      host: host,
      open: openPanel,
      close: closePanel,
      destroy: function () {
        timers.forEach(clearTimeout);
        lock(false);
        if (host.parentNode) host.parentNode.removeChild(host);
      },
    };
  }

  function post(o, body) {
    return window
      .fetch(o.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
      })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          return { ok: r.ok && b && b.ok === true, status: r.status, body: b || {} };
        });
      });
  }

  /** mount({ key | config, endpoint?, preview?, container?, submit?, open?, lang? }) */
  function mount(o) {
    o = o || {};
    if (o.config) return build(normalize(o.config), o);
    var ctl = { destroy: function () { ctl.dead = true; } };
    window
      .fetch(o.endpoint, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) {
        if (!b || !b.ok || ctl.dead) return o.onFail && o.onFail();
        var real = build(normalize(b.config), o);
        ctl.host = real.host;
        ctl.open = real.open;
        ctl.close = real.close;
        ctl.destroy = real.destroy;
      })
      .catch(function () { if (o.onFail) o.onFail(); }); // a bot that cannot load stays invisible
    return ctl;
  }

  window.SempreRobo = { mount: mount };

  var key = script && script.getAttribute('data-robo');
  if (key && /^[0-9a-f]{32}$/.test(key) && !window['__semprerobo_' + key]) {
    // Marked while loading, cleared if the config cannot be fetched so a later tag can retry.
    window['__semprerobo_' + key] = true;
    var base = '';
    try { base = new URL(script.src).origin; } catch { base = ''; }
    var go = function () { mount({ key: key, endpoint: base + '/api/v1/robo/' + key, onFail: function () { delete window['__semprerobo_' + key]; } }); };
    if (document.body) go();
    else document.addEventListener('DOMContentLoaded', go);
  }
})();
