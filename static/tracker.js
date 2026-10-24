/*
  web/static/tracker.js - saves ticks, notes, outcomes, bid details, approvals and
  company profiles as soon as they change.

  Every save is a POST to the server with the page's security token. If a save
  fails, the change is undone on screen and the reason is shown.
*/
const Tracker = (() => {
  const token = document.querySelector('meta[name="csrf"]').content;
  const $ = (s, root = document) => root.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !data.ok) throw new Error(data.error || `Couldn't save (error ${res.status}). Check the network and try again.`);
    return data;
  }

  function say(msg, bad, where = '#save-msg') {
    const m = $(where);
    if (!m) { if (bad) alert(msg); return; }
    m.textContent = msg; m.classList.toggle('error', !!bad);
  }

  // ---- Checklist and requirements on a tender page ----------------------
  // Both are <ul class="checklist">; requirement items have keys starting "req:".
  function checklist() {
    document.querySelectorAll('ul.checklist').forEach(setupList);
  }

  function setupList(list) {
    const tender = list.dataset.tender;
    const isReq = list.classList.contains('reqs');
    const msg = isReq ? '#req-msg' : '#save-msg';

    async function save(li, state) {
      const before = li.dataset.state, beforeText = $('.ck-by', li).textContent;
      paint(li, state, 'Saving…');
      try {
        const r = await post('/api/check', { tender, item: li.dataset.item, state });
        const word = isReq ? 'Met' : state === 'done' ? 'Done' : 'Not needed';
        paint(li, state, state ? `${word} · ${r.by}, ${r.at}` : '');
        if (isReq) {
          $('#req-txt').replaceChildren(el('b', null, String(r.req_done)), ` of ${r.req_total} met`);
        } else {
          $('#pct-bar').style.width = r.pct + '%';
          $('#pct-bar').parentElement.setAttribute('aria-valuenow', r.pct);
          $('#pct-txt').replaceChildren(el('b', null, r.pct + '%'), ` · ${r.done} of ${r.total} steps`);
          const st = $('#stage'); st.textContent = r.stage;
          st.className = 'pill ' + (r.stage === 'Submitted' ? 'st-sub' : r.stage === 'In progress' ? 'st-prog' : 'st-none');
          // The "Ask for approval" button becomes usable once the internal review is ticked.
          if (li.dataset.item === 'review') { const ask = $('#ask-approval'); if (ask) ask.disabled = state !== 'done'; }
        }
        say('Saved.', false, msg);
        if (r.approval_reset) { say('Saved. This cancelled the approval - ask for approval again.', true, msg); setTimeout(() => location.reload(), 1500); }
      } catch (e) {
        paint(li, before, beforeText);
        say(e.message, true, msg);
      }
    }

    function paint(li, state, byText) {
      li.dataset.state = state;
      const box = $('input', li), na = $('.na', li);
      box.checked = state === 'done';
      box.disabled = state === 'na';
      if (na) na.setAttribute('aria-pressed', String(state === 'na'));
      if (byText !== undefined) $('.ck-by', li).textContent = byText;
    }

    list.addEventListener('change', (ev) => {
      if (ev.target.matches('input[type=checkbox]')) save(ev.target.closest('li'), ev.target.checked ? 'done' : '');
    });
    list.addEventListener('click', (ev) => {
      const b = ev.target.closest('.na');
      if (b) { const li = b.closest('li'); save(li, li.dataset.state === 'na' ? '' : 'na'); }
    });
  }

  // ---- Notes on a tender page --------------------------------------------
  function notes(tender) {
    const form = $('#note-form');
    if (!form) return;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const box = $('#note-text');
      const text = box.value.trim();
      if (!text) return;
      const btn = $('button', form); btn.disabled = true;
      try {
        const r = await post('/api/note', { tender, text });
        const li = el('li');
        li.append(el('div', 'muted', `${r.by} · ${r.at}`), el('div', 'note-body', r.text));
        $('#notes').prepend(li);
        box.value = '';
        say('Note added.');
      } catch (e) { say(e.message, true); }
      btn.disabled = false;
    });
  }

  // ---- Outcome drop-downs (tender page and Tenders list) ------------------
  function outcomeSelects() {
    document.querySelectorAll('select.outcome').forEach((sel) => {
      let before = sel.value;
      sel.addEventListener('change', async () => {
        const by = document.querySelector(`[data-by="${sel.dataset.tender}"]`);
        try {
          const r = await post('/api/outcome', { tender: sel.dataset.tender, outcome: sel.value });
          before = sel.value;
          if (by) by.textContent = sel.value ? `${r.by}, just now` : '';
        } catch (e) { sel.value = before; alert(e.message); }
      });
    });
  }

  // ---- "Refresh data now" on the Activity page ----------------------------
  function refreshButton() {
    const btn = $('#refresh');
    if (!btn) return;
    const runState = $('#run-state');
    async function watch() {
      const s = await (await fetch('/api/status')).json();
      $('#last-ok').textContent = s.last_ok_text;
      if (s.running) { runState.textContent = '(running now…)'; setTimeout(watch, 3000); }
      else { runState.textContent = s.last_message ? `Last run: ${s.last_message}` : ''; btn.disabled = false; }
    }
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await post('/api/refresh', {}); runState.textContent = '(running now…)'; setTimeout(watch, 3000); }
      catch (e) { alert(e.message); btn.disabled = false; }
    });
  }

  // ---- Bid details on a tender page (save when a field is left) ---------
  function details() {
    const box = $('#details');
    if (!box) return;
    const tender = box.dataset.tender;
    box.querySelectorAll('[data-field]').forEach((input) => {
      let before = input.value;
      input.addEventListener('change', async () => {
        const by = $(`[data-by-field="${input.dataset.field}"]`);
        try {
          const r = await post('/api/detail', { tender, field: input.dataset.field, value: input.value });
          before = input.value;
          if (by) by.textContent = input.value ? `${input.value && r.shown !== input.value ? r.shown + ' · ' : ''}${r.by}, ${r.at}` : '';
          say('Saved.');
          if (r.approval_reset) { say('Saved. This cancelled the approval - ask for approval again.', true); setTimeout(() => location.reload(), 1500); }
        } catch (e) { input.value = before; say(e.message, true); }
      });
    });
  }

  // ---- Approval (SOP 5.4): clerk asks, manager approves or sends back ----
  function approval() {
    const box = $('#approval');
    if (!box) return;
    const tender = box.dataset.tender;
    const ask = $('#ask-approval');
    if (ask) ask.addEventListener('click', async () => {
      ask.disabled = true;
      try {
        await post('/api/request_approval', { tender, comment: $('#ask-comment').value });
        location.reload();
      } catch (e) { say(e.message, true, '#approval-msg'); ask.disabled = false; }
    });
    box.querySelectorAll('[data-decide]').forEach((btn) => btn.addEventListener('click', async () => {
      const comment = $('#decide-comment').value.trim();
      if (btn.dataset.decide === 'sent_back' && !comment) {
        say('Write what needs to change before sending it back.', true, '#approval-msg');
        $('#decide-comment').focus();
        return;
      }
      btn.disabled = true;
      try {
        await post('/api/decide', { tender, decision: btn.dataset.decide, comment });
        location.reload();
      } catch (e) { say(e.message, true, '#approval-msg'); btn.disabled = false; }
    }));
  }

  // ---- Hand over work on a tender (managers) -------------------------------
  function handover() {
    const box = $('#handover');
    if (!box) return;
    const btn = $('#ho-go'), msg = $('#ho-msg');
    btn.addEventListener('click', async () => {
      const from = $('#ho-from').value, to = $('#ho-to').value;
      if (!from || !to || from === to) { msg.textContent = 'Pick who it comes from and a different clerk to give it to.'; msg.classList.add('error'); return; }
      btn.disabled = true;
      try {
        const r = await post('/api/handover', { tender: box.dataset.tender, from, to, remove_old: $('#ho-remove').checked });
        msg.textContent = `Done: ${r.moved} entries moved from ${from} to ${to}.`; msg.classList.remove('error');
        setTimeout(() => location.reload(), 1200);
      } catch (e) { msg.textContent = e.message; msg.classList.add('error'); btn.disabled = false; }
    });
  }

  // ---- Company profiles (managers) ----------------------------------------
  function companies() {
    document.querySelectorAll('section.company').forEach((card) => {
      const btn = $('[data-save-company]', card);
      if (!btn) return;
      const msg = $('.save-msg', card);
      btn.addEventListener('click', async () => {
        const body = { name: card.dataset.company };
        card.querySelectorAll('[data-key]').forEach((f) => { body[f.dataset.key] = f.value; });
        btn.disabled = true;
        try { await post('/api/company', body); msg.textContent = 'Saved.'; msg.classList.remove('error'); }
        catch (e) { msg.textContent = e.message; msg.classList.add('error'); }
        btn.disabled = false;
      });
    });
  }

  return { checklist, notes, outcomeSelects, refreshButton, details, approval, companies, handover };
})();
