/* ============================================================================
   RepsRecord — Contact Support  (external script; load via <script src>)
   Builds a floating "Contact" button + an in-app modal entirely in JS, and
   re-creates them if the app's re-render ever removes them. Sends messages to
   Formspree, which emails support@repsrecord.com. No inline script needed.
   ============================================================================ */
(function () {
  var ENDPOINT = 'https://formspree.io/f/xjgnpbeb';

  function currentEmail() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/sb-.*-auth-token|supabase.*auth/i.test(k)) {
          var v = JSON.parse(localStorage.getItem(k) || '{}');
          return (v.user && v.user.email) ||
                 (v.currentSession && v.currentSession.user && v.currentSession.user.email) || '';
        }
      }
    } catch (e) {}
    return '';
  }

  function el(tag, styleText, props) {
    var n = document.createElement(tag);
    if (styleText) n.style.cssText = styleText;
    if (props) { for (var p in props) { if (p === 'text') n.textContent = props[p]; else n.setAttribute(p, props[p]); } }
    return n;
  }

  var INPUT_STYLE = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #CBD5E1;' +
                    'border-radius:8px;font-size:14px;margin-bottom:12px;font-family:inherit;';
  var LABEL_STYLE = 'display:block;font-size:12px;font-weight:700;color:#0D1F3C;margin-bottom:4px;';

  function buildOverlay() {
    var overlay = el('div', 'display:none;position:fixed;inset:0;z-index:99999;background:rgba(13,31,60,.55);' +
      'align-items:center;justify-content:center;padding:20px;', { id: 'rr-contact-overlay', role: 'dialog', 'aria-modal': 'true' });

    var card = el('div', 'background:#fff;max-width:460px;width:100%;border-radius:14px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden;font-family:inherit;');

    var head = el('div', 'background:#0D1F3C;color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;');
    head.appendChild(el('span', 'font-weight:800;font-size:16px;', { text: 'Contact Support' }));
    var closeBtn = el('button', 'background:none;border:none;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:0 4px;',
      { type: 'button', 'aria-label': 'Close', text: '\u00d7' });
    head.appendChild(closeBtn);
    card.appendChild(head);

    var body = el('div', 'padding:20px;');
    body.appendChild(el('p', 'margin:0 0 16px;font-size:13px;color:#475569;line-height:1.5;',
      { text: "Have a question or running into trouble? Send us a message and we'll reply to your email." }));

    var form = el('form', '', { id: 'rr-contact-form' });
    function field(labelText, tag, name, extraStyle, attrs) {
      form.appendChild(el('label', LABEL_STYLE, { text: labelText }));
      var input = el(tag, INPUT_STYLE + (extraStyle || ''), Object.assign({ name: name }, attrs || {}));
      form.appendChild(input);
      return input;
    }
    field('Name', 'input', 'name', '', { required: 'required', autocomplete: 'name' });
    field('Email', 'input', 'email', '', { required: 'required', type: 'email', autocomplete: 'email' });
    field('Subject', 'input', '_subject', '', { placeholder: 'How can we help?' });
    field('Message', 'textarea', 'message', 'resize:vertical;', { required: 'required', rows: '5' });

    var actions = el('div', 'display:flex;gap:10px;justify-content:flex-end;');
    var cancel = el('button', 'background:#F1F5F9;color:#0D1F3C;border:none;font-weight:700;font-size:13px;' +
      'padding:10px 16px;border-radius:8px;cursor:pointer;font-family:inherit;', { type: 'button', text: 'Cancel' });
    var send = el('button', 'background:#0D9488;color:#fff;border:none;font-weight:700;font-size:13px;' +
      'padding:10px 18px;border-radius:8px;cursor:pointer;font-family:inherit;', { type: 'submit', id: 'rr-contact-submit', text: 'Send message' });
    actions.appendChild(cancel); actions.appendChild(send);
    form.appendChild(actions);

    var status = el('div', 'margin-top:12px;font-size:13px;line-height:1.4;', { id: 'rr-contact-status', role: 'status', 'aria-live': 'polite' });
    form.appendChild(status);
    body.appendChild(form);
    card.appendChild(body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function close() { overlay.style.display = 'none'; }
    function open() {
      var em = currentEmail();
      var ef = form.querySelector('[name=email]');
      if (em && ef && !ef.value) ef.value = em;
      status.textContent = '';
      overlay.style.display = 'flex';
      setTimeout(function () { var n = form.querySelector('[name=name]'); if (n) n.focus(); }, 50);
    }
    overlay.__open = open;

    closeBtn.addEventListener('click', close);
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.style.display === 'flex') close(); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      status.style.color = '#475569'; status.textContent = 'Sending\u2026'; send.disabled = true;
      fetch(ENDPOINT, { method: 'POST', headers: { 'Accept': 'application/json' }, body: new FormData(form) })
        .then(function (r) {
          if (r.ok) {
            status.style.color = '#059669';
            status.textContent = "\u2713 Message sent \u2014 we'll reply to your email shortly.";
            form.querySelector('[name=message]').value = '';
            var s = form.querySelector('[name=_subject]'); if (s) s.value = '';
            setTimeout(close, 2200);
          } else {
            return r.json().then(function (d) {
              throw new Error((d && d.errors && d.errors[0] && d.errors[0].message) || 'Something went wrong.');
            });
          }
        })
        .catch(function (err) {
          status.style.color = '#DC2626';
          status.textContent = "Couldn't send: " + err.message + " You can also email support@repsrecord.com directly.";
        })
        .finally(function () { send.disabled = false; });
    });

    return overlay;
  }

  function ensureWidget() {
    if (!document.body) return;
    var overlay = document.getElementById('rr-contact-overlay');
    if (!overlay || !overlay.__open) {
      if (overlay) overlay.remove();
      overlay = buildOverlay();
    }
    if (!document.getElementById('rr-contact-trigger')) {
      var b = el('button', 'position:fixed;left:16px;bottom:16px;z-index:9998;background:#0D1F3C;color:#fff;' +
        'border:none;border-radius:24px;padding:10px 16px;font-size:13px;font-weight:700;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;font-family:inherit;',
        { id: 'rr-contact-trigger', type: 'button', 'aria-label': 'Contact Support', text: '\ud83d\udce7 Contact' });
      b.addEventListener('click', function () { overlay.__open(); });
      document.body.appendChild(b);
    }
  }

  function start() {
    ensureWidget();
    setTimeout(ensureWidget, 1500);
    setInterval(ensureWidget, 3000); // self-heal against app re-renders
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
