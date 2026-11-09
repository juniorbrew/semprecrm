/*
 * SempreCRM site bot - vanilla JS, no dependencies. Embed with:
 *   <script src=".../robo.js" data-robo="PUBLIC_KEY" async></script>
 * Everything is built with createElement + textContent inside a Shadow DOM
 * (config and visitor text never become markup). Nothing is sent before the
 * visitor finishes and ticks the consent box; answers stay in localStorage
 * for 1 day so a closed chat resumes. window.SempreRobo.mount({config,
 * preview, container, submit}) powers the Settings preview: same widget,
 * unsaved config, no call to the public API.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var DAY = 864e5;

  var TEXT = {
    pt: {
      open: 'Abrir conversa',
      close: 'Fechar conversa',
      send: 'Enviar',
      skip: 'Pular',
      placeholder: 'Digite aqui',
      required: 'Preciso dessa resposta para continuar.',
      phone: 'Esse número não parece válido. Informe com DDD, por exemplo (11) 98765-4321.',
      email: 'Esse e-mail não parece válido. Confira e tente de novo.',
      consentIntro: 'Para terminar, preciso da sua autorização.',
      consentNeeded: 'Marque a caixa para continuar.',
      privacy: 'Política de privacidade',
      sending: 'Enviando',
      error: 'Não foi possível enviar agora. Tente de novo em instantes.',
      retry: 'Tentar de novo',
      whatsapp: 'Continuar no WhatsApp',
      typing: 'Digitando',
    },
    en: {
      open: 'Open chat',
      close: 'Close chat',
      send: 'Send',
      skip: 'Skip',
      placeholder: 'Type here',
      required: 'I need this answer to continue.',
      phone: 'That number does not look valid. Include the area code, e.g. (11) 98765-4321.',
      email: 'That email does not look valid. Please check it and try again.',
      consentIntro: 'To finish, I need your permission.',
      consentNeeded: 'Tick the box to continue.',
      privacy: 'Privacy policy',
      sending: 'Sending',
      error: 'We could not send this right now. Please try again shortly.',
      retry: 'Try again',
      whatsapp: 'Continue on WhatsApp',
      typing: 'Typing',
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
      try { return fn(window.localStorage); } catch { return null; } // storage blocked: chat still works
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

  function validPhone(v) {
    return /^\d{10,15}$/.test(v.replace(/\D/g, ''));
  }

  function validEmail(v) {
    return /^[^\s@]{1,64}@[^\s@]+\.[^\s@.]{2,}$/.test(v) && v.length <= 254;
  }

  /** Builds one widget. `o`: { config, key, endpoint, preview, container, submit, lang }. */
  function build(cfg, o) {
    var T = TEXT[pickLang(o.lang)];
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var st = o.preview || !o.key ? null : store(o.key);
    var S = { open: false, started: false, i: 0, answers: {}, t0: 0, busy: false, finished: false };
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
    var hp = h('input', { class: 'hp', type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    var foot = h('div', { class: 'foot' }, [zone, hp]);
    var panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': cfg.name }, [
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
    });

    function later(fn, ms) {
      var id = setTimeout(fn, reduced ? 0 : ms);
      timers.push(id);
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
      if (st) st.write({ t0: S.t0, answers: S.answers, i: S.i });
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

    function ask(error) {
      if (S.i >= cfg.questions.length) return consent();
      var q = cfg.questions[S.i];
      if (error) {
        typing(function () { input(q); }, error);
        return;
      }
      typing(function () { input(q); }, q.text);
    }

    function skipBtn(q) {
      return h('button', { class: 'btn alt', type: 'button', text: T.skip, onclick: function () { answer(q, ''); } });
    }

    function input(q) {
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
      var form = h('form', { class: 'row', novalidate: '' }, [field, h('button', { class: 'btn', type: 'submit', text: T.send })]);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = field.value.replace(/\s+/g, ' ').trim();
        if (!v) {
          if (q.required) return ask(T.required);
          return answer(q, '');
        }
        if (q.type === 'phone' && !validPhone(v)) return ask(T.phone);
        if (q.type === 'email' && !validEmail(v)) return ask(T.email);
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
        : post(o, { answers: answers, consent: true, website: hp.value, elapsed_ms: Date.now() - S.t0 });
      send.then(function (res) {
        S.busy = false;
        t.remove();
        return res.ok ? done(res.body) : fail();
      }, function () {
        S.busy = false;
        t.remove();
        fail();
      });
    }

    function fail() {
      msg('bot', T.error);
      clearZone();
      zone.appendChild(h('button', { class: 'btn', type: 'button', text: T.retry, onclick: submit }));
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
      if (saved && !S.finished) {
        S.t0 = Number(saved.t0) || Date.now();
        S.answers = saved.answers;
        S.i = Math.min(Math.max(0, Number(saved.i) || 0), cfg.questions.length);
        if (cfg.greeting) msg('bot', cfg.greeting);
        for (var k = 0; k < S.i; k++) {
          var q = cfg.questions[k];
          msg('bot', q.text);
          if (typeof S.answers[q.id] === 'string') msg('me', S.answers[q.id]);
        }
        return ask();
      }
      S.t0 = Date.now();
      typing(ask, cfg.greeting);
    }

    function openPanel() {
      S.open = true;
      wrap.classList.add('open');
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
        if (!b || !b.ok || ctl.dead) return;
        var real = build(normalize(b.config), o);
        ctl.host = real.host;
        ctl.open = real.open;
        ctl.close = real.close;
        ctl.destroy = real.destroy;
      })
      .catch(function () { /* a bot that cannot load stays invisible */ });
    return ctl;
  }

  window.SempreRobo = { mount: mount };

  var key = script && script.getAttribute('data-robo');
  if (key && /^[0-9a-f]{32}$/.test(key) && !window['__semprerobo_' + key]) {
    window['__semprerobo_' + key] = true;
    var base = '';
    try { base = new URL(script.src).origin; } catch { base = ''; }
    var go = function () { mount({ key: key, endpoint: base + '/api/v1/robo/' + key }); };
    if (document.body) go();
    else document.addEventListener('DOMContentLoaded', go);
  }
})();
