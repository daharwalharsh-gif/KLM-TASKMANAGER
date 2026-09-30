// Tyohaar ke din "Happy …" + us tyohaar ka logo.
// Harsh (30 Sep 2026): "Gandhi Jayanti, Dussehra jaise din 'Happy …' likh kar
// uske hisaab se logo aa jaye". Login page (index.html) aur app (app.html)
// dono yahi file use karte hain. Naam Holidays list se aata hai (admin jo
// naam daale); naam me keyword dekh kar logo chunte hain.
// Dekhne ke liye (bina chhutti ke): URL me ?festival=Dussehra
(function () {
  const THEMES = [
    [/gandhi/i, 'gandhi'],
    [/dussehra|dussera|dasara|dashera|dasehra|vijaya ?dashami/i, 'dussehra'],
    [/diwali|deepawali|deepavali|dipawali|deepotsav/i, 'diwali'],
    [/\bholi\b|holika|dhulandi|dhuleti/i, 'holi'],
    [/republic|independence|swatantrata|gantantra/i, 'flag'],
    [/raksha|rakhi/i, 'rakhi'],
    [/shiv/i, 'shiv'],
    [/govardhan|goverdhan|annakut/i, 'govardhan'],
    [/bhai|bhau ?beej|bhratri/i, 'bhaidooj'],
    [/janmashtami|krishna/i, 'krishna'],
    [/navratri|durga|garba|dandiya/i, 'navratri'],
    [/sankranti|lohri|pongal|uttarayan/i, 'kite'],
    [/christmas|xmas/i, 'xmas'],
    [/new ?year/i, 'newyear'],
    [/\beid\b|bakrid|ramzan|ramadan/i, 'eid']
  ];

  const LOGO = {
    // Chashma + charkha
    gandhi: `
      <g fill="none" stroke="#1f2937" stroke-width="3" stroke-linecap="round">
        <circle cx="20" cy="22" r="9.5"/><circle cx="44" cy="22" r="9.5"/>
        <path d="M29.5 21 Q32 18 34.5 21"/><path d="M10.5 20 L4 16 M53.5 20 L60 16"/>
      </g>
      <g transform="translate(32 48)"><g class="fe-spin">
        <circle r="11" fill="#fff7ed" stroke="#f57c00" stroke-width="2.6"/>
        <path d="M0 -11 V11 M-11 0 H11 M-7.8 -7.8 L7.8 7.8 M-7.8 7.8 L7.8 -7.8" stroke="#138808" stroke-width="1.8" stroke-linecap="round"/>
        <circle r="2.6" fill="#1a56db"/>
      </g></g>`,
    // Dhanush + jalta baan
    dussehra: `
      <path d="M16 6 C38 16 38 48 16 58" fill="none" stroke="#b45309" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M16 6 L16 58" stroke="#78350f" stroke-width="1.4"/>
      <path d="M8 32 H52" stroke="#1f2937" stroke-width="3" stroke-linecap="round"/>
      <path d="M61 32 L50 26.5 V37.5 Z" fill="#1f2937"/>
      <path d="M8 32 L3 27 M8 32 L3 37 M12 32 L7 27 M12 32 L7 37" stroke="#f57c00" stroke-width="2.2" stroke-linecap="round"/>
      <g class="fe-flame"><path d="M56 25 C51 19 55 14 54 7 C60 11 64 18 60 24 C59 26 57 26 56 25 Z" fill="#f97316"/>
        <path d="M57 24 C55 21 57 18 57 14 C60 17 61 21 59 23 Z" fill="#fde047"/></g>`,
    // Diya
    diwali: `
      <circle class="fe-glow" cx="32" cy="22" r="17" fill="#fde68a" opacity=".5"/>
      <g class="fe-flame"><path d="M32 6 C25 18 27 29 32 33 C37 29 39 18 32 6 Z" fill="#f97316"/>
        <path d="M32 15 C29 22 30 28 32 31 C34 28 35 22 32 15 Z" fill="#fde047"/></g>
      <path d="M8 38 Q32 64 56 38 Z" fill="#c2410c"/>
      <path d="M8 38 H56" stroke="#f59e0b" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M17 45 Q32 56 47 45" fill="none" stroke="#fde68a" stroke-width="2" stroke-dasharray="2 3"/>`,
    // Rang
    holi: `<g class="fe-pop">
      <circle cx="22" cy="24" r="12" fill="#ec4899" opacity=".9"/><circle cx="42" cy="21" r="10" fill="#facc15" opacity=".9"/>
      <circle cx="37" cy="41" r="13" fill="#22c55e" opacity=".85"/><circle cx="18" cy="43" r="8.5" fill="#3b82f6" opacity=".9"/>
      <circle cx="53" cy="37" r="4" fill="#a855f7"/><circle cx="7" cy="29" r="3" fill="#f97316"/>
      <circle cx="30" cy="7" r="3" fill="#06b6d4"/><circle cx="53" cy="54" r="2.5" fill="#ec4899"/></g>`,
    // Tiranga
    flag: `
      <rect x="9" y="5" width="3.2" height="55" rx="1.6" fill="#64748b"/>
      <g class="fe-wave">
        <path d="M12 8 C24 4 36 13 56 8 V20 C36 25 24 16 12 20 Z" fill="#ff9933"/>
        <path d="M12 20 C24 16 36 25 56 20 V32 C36 37 24 28 12 32 Z" fill="#ffffff" stroke="#e5e7eb" stroke-width=".6"/>
        <path d="M12 32 C24 28 36 37 56 32 V44 C36 49 24 40 12 44 Z" fill="#138808"/>
        <circle cx="34" cy="27" r="4.2" fill="none" stroke="#000080" stroke-width="1.3"/><circle cx="34" cy="27" r="1" fill="#000080"/>
      </g>`,
    // Rakhi
    rakhi: `
      <path d="M2 36 C18 30 46 30 62 36" stroke="#dc2626" stroke-width="3" fill="none" stroke-linecap="round"/>
      <g transform="translate(32 33)"><g class="fe-spin">
        ${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<ellipse cy="-10" rx="4.5" ry="7" fill="${a % 90 ? '#fb923c' : '#f59e0b'}" transform="rotate(${a})"/>`).join('')}
      </g></g>
      <circle cx="32" cy="33" r="7" fill="#dc2626"/><circle cx="32" cy="33" r="3.2" fill="#fde047"/>`,
    // Trishul + damru
    shiv: `
      <path d="M32 6 V60" stroke="#475569" stroke-width="3.2" stroke-linecap="round"/>
      <path d="M19 13 C19 27 25 30 32 30 C39 30 45 27 45 13" fill="none" stroke="#475569" stroke-width="3.2" stroke-linecap="round"/>
      <path d="M32 2 L28.5 11 H35.5 Z M19 7 L16 15 H22 Z M45 7 L42 15 H48 Z" fill="#475569"/>
      <path d="M24 38 H40 L34 44 L40 50 H24 L30 44 Z" fill="#b45309"/>
      <path d="M24 38 H40 M24 50 H40" stroke="#78350f" stroke-width="1.5"/>`,
    // Govardhan parvat
    govardhan: `
      <path d="M2 54 L20 24 L30 34 L42 13 L62 54 Z" fill="#16a34a"/>
      <path d="M42 13 L49 26 L44 24 L40 28 L36 23 Z" fill="#bbf7d0"/>
      <path d="M20 24 L25 32 L20 30 L16 32 Z" fill="#bbf7d0"/>
      <g fill="#facc15"><circle cx="14" cy="50" r="2"/><circle cx="26" cy="47" r="2"/><circle cx="40" cy="49" r="2"/><circle cx="52" cy="50" r="2"/></g>`,
    // Pooja ki thali
    bhaidooj: `
      <ellipse cx="32" cy="46" rx="27" ry="10" fill="#d97706"/><ellipse cx="32" cy="44" rx="23" ry="7" fill="#fbbf24"/>
      <path d="M24 42 Q32 50 40 42 Z" fill="#c2410c"/>
      <g class="fe-flame"><path d="M32 27 C28 33 29 38 32 41 C35 38 36 33 32 27 Z" fill="#f97316"/></g>
      <circle cx="15" cy="44" r="3" fill="#dc2626"/><circle cx="49" cy="44" r="3" fill="#dc2626"/>
      <circle cx="44" cy="40" r="1.4" fill="#fff"/><circle cx="20" cy="40" r="1.4" fill="#fff"/>`,
    // Bansuri + mor pankh
    krishna: `
      <path d="M6 52 L50 16" stroke="#b45309" stroke-width="5" stroke-linecap="round"/>
      <g fill="#78350f"><circle cx="18" cy="42" r="1.3"/><circle cx="24" cy="37" r="1.3"/><circle cx="30" cy="32" r="1.3"/><circle cx="36" cy="27" r="1.3"/></g>
      <g class="fe-wave"><path d="M40 42 C44 28 52 20 60 7 C63 22 57 34 44 43 Z" fill="#16a34a"/>
        <ellipse cx="54" cy="20" rx="5" ry="7" fill="#1d4ed8" transform="rotate(35 54 20)"/>
        <ellipse cx="54" cy="20" rx="2.2" ry="3.2" fill="#facc15" transform="rotate(35 54 20)"/></g>`,
    // Dandiya
    navratri: `
      <path d="M12 56 L46 10" stroke="#db2777" stroke-width="5" stroke-linecap="round"/>
      <path d="M52 56 L18 10" stroke="#f59e0b" stroke-width="5" stroke-linecap="round"/>
      <g fill="#fff"><circle cx="20" cy="45" r="1.5"/><circle cx="38" cy="21" r="1.5"/><circle cx="44" cy="45" r="1.5"/><circle cx="26" cy="21" r="1.5"/></g>
      <g class="fe-pop"><circle cx="32" cy="33" r="4" fill="#facc15"/></g>`,
    // Patang
    kite: `<g class="fe-wave">
      <path d="M32 4 L52 26 L32 48 L12 26 Z" fill="#f97316"/><path d="M32 4 L52 26 L32 26 Z" fill="#facc15"/>
      <path d="M32 4 V48 M12 26 H52" stroke="#fff" stroke-width="1.5"/>
      <path d="M32 48 C27 53 37 56 30 62" stroke="#1a56db" stroke-width="2" fill="none" stroke-linecap="round"/></g>`,
    // Christmas tree
    xmas: `
      <path d="M32 6 L50 30 H40 L54 48 H10 L24 30 H14 Z" fill="#15803d"/>
      <rect x="28" y="48" width="8" height="10" fill="#92400e"/>
      <g class="fe-pop"><path d="M32 1 l2 4.5 5 .5-3.8 3.3 1.1 4.9-4.3-2.6-4.3 2.6 1.1-4.9-3.8-3.3 5-.5 Z" fill="#facc15"/></g>
      <g fill="#ef4444"><circle cx="26" cy="26" r="2"/><circle cx="38" cy="36" r="2"/><circle cx="22" cy="42" r="2"/><circle cx="44" cy="44" r="2"/></g>`,
    // Aatishbaazi
    newyear: `<g class="fe-pop">
      <g stroke="#1a56db" stroke-width="2.6" stroke-linecap="round"><path d="M32 8 V18 M32 46 V56 M8 32 H18 M46 32 H56 M15 15 L22 22 M42 42 L49 49 M15 49 L22 42 M42 22 L49 15"/></g>
      <g fill="#f59e0b"><circle cx="32" cy="32" r="5"/><circle cx="32" cy="4" r="2"/><circle cx="60" cy="32" r="2"/><circle cx="32" cy="60" r="2"/><circle cx="4" cy="32" r="2"/></g></g>`,
    // Chaand + taara
    eid: `
      <path d="M40 10 A22 22 0 1 0 40 54 A17 17 0 1 1 40 10 Z" fill="#facc15"/>
      <g class="fe-pop"><path d="M49 22 l2.4 5 5.5.8-4 3.8 1 5.4-4.9-2.6-4.9 2.6 1-5.4-4-3.8 5.5-.8 Z" fill="#facc15"/></g>`,
    // Baaki sab — gift
    gift: `
      <rect x="12" y="27" width="40" height="30" rx="4" fill="#1a56db"/>
      <rect x="8" y="19" width="48" height="10" rx="3" fill="#3b82f6"/>
      <rect x="29" y="19" width="6" height="38" fill="#facc15"/>
      <path d="M32 19 C26 9 16 12 22 19 M32 19 C38 9 48 12 42 19" stroke="#facc15" stroke-width="3" fill="none" stroke-linecap="round"/>
      <g class="fe-pop" fill="#f59e0b"><circle cx="6" cy="10" r="2"/><circle cx="58" cy="8" r="2"/></g>`
  };

  const CSS = `
    .fest{display:flex;align-items:center;justify-content:center;gap:12px;margin:0 auto 18px;padding:10px 16px;
      border-radius:14px;background:linear-gradient(135deg,#fff7ed,#eff6ff);border:1px solid #fde68a;
      animation:festIn .6s cubic-bezier(.34,1.56,.64,1) both;text-align:left}
    .fest-emb{width:52px;height:52px;flex-shrink:0;overflow:visible;animation:festFloat 2.6s ease-in-out infinite}
    .fest-txt{font-size:18px;font-weight:800;line-height:1.2;
      background:linear-gradient(90deg,#ea580c,#db2777,#1a56db);-webkit-background-clip:text;background-clip:text;color:transparent}
    .fest-sub{font-size:11.5px;color:#64748b;font-weight:600;margin-top:2px}
    .fest-chip{display:inline-flex;align-items:center;gap:7px;padding:3px 12px 3px 5px;border-radius:999px;
      background:linear-gradient(135deg,#fff7ed,#eff6ff);border:1px solid #fde68a;white-space:nowrap;
      animation:festIn .6s cubic-bezier(.34,1.56,.64,1) both}
    .fest-chip .fest-emb{width:30px;height:30px}
    .fest-chip .fest-txt{font-size:13px}
    @media (max-width:640px){ .fest-chip .fest-txt{display:none} .fest-chip{padding:3px} }
    .fe-flame{transform-box:fill-box;transform-origin:50% 100%;animation:feFlick .9s ease-in-out infinite alternate}
    .fe-spin{transform-box:fill-box;transform-origin:center;animation:feSpin 8s linear infinite}
    .fe-glow{animation:feGlow 1.6s ease-in-out infinite alternate}
    .fe-wave{transform-box:fill-box;transform-origin:0 50%;animation:feWave 2s ease-in-out infinite alternate}
    .fe-pop{transform-box:fill-box;transform-origin:center;animation:fePop 2.4s ease-in-out infinite}
    @keyframes festIn{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:none}}
    @keyframes festFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
    @keyframes feFlick{from{transform:scale(1,1) rotate(-3deg)}to{transform:scale(.9,1.1) rotate(3deg)}}
    @keyframes feSpin{to{transform:rotate(360deg)}}
    @keyframes feGlow{from{opacity:.25}to{opacity:.65}}
    @keyframes feWave{from{transform:skewY(-3deg)}to{transform:skewY(3deg)}}
    @keyframes fePop{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
    @media (prefers-reduced-motion:reduce){
      .fest,.fest-chip,.fest-emb,.fe-flame,.fe-spin,.fe-glow,.fe-wave,.fe-pop{animation:none !important}
    }`;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const themeOf = name => (THEMES.find(([re]) => re.test(name)) || [0, 'gift'])[1];
  let styled = false;

  window.KLMFestival = {
    // URL me ?festival=Naam ho to wahi (dekhne ke liye)
    preview() {
      try { return new URLSearchParams(location.search).get('festival') || null; } catch (e) { return null; }
    },
    // names = aaj ki chhuttiyon ke naam; mode = 'block' (login) ya 'chip' (app ka top bar)
    html(names, mode) {
      names = (names || []).map(n => String(n || '').trim()).filter(Boolean);
      if (!names.length) return '';
      if (!styled) {
        const st = document.createElement('style');
        st.textContent = CSS;
        document.head.appendChild(st);
        styled = true;
      }
      const label = names.map(n => /^happy\b/i.test(n) ? n : 'Happy ' + n).join(' & ');
      const emb = `<svg class="fest-emb" viewBox="0 0 64 64" aria-hidden="true">${LOGO[themeOf(names[0])]}</svg>`;
      return mode === 'chip'
        ? `<span class="fest-chip" title="${esc(label)}">${emb}<span class="fest-txt">${esc(label)}</span></span>`
        : `<div class="fest" role="status">${emb}<div><div class="fest-txt">${esc(label)}</div>` +
          `<div class="fest-sub">Warm wishes from Team KLM ✨</div></div></div>`;
    }
  };
})();
