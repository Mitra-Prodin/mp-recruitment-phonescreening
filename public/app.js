/* Aplikasi kandidat Phone Screening PT Mitra Prodin.
 * Tanpa pustaka dan tanpa proses build, supaya ringan di HP spesifikasi rendah.
 * Browser hanya memanggil /api/... di domain ini; Worker yang berbicara dengan web rekrutmen.
 */
(function () {
  "use strict";

  /* ============ Keadaan ============ */
  var token = (/^\/s\/([^/?#]+)/.exec(location.pathname) || [])[1] || "";
  var LS_KEY = "ps:" + token;
  var VIDEO_BPS = 550000; // ± 4,6 MB per menit bersama audio
  var AUDIO_BPS = 64000;

  var S = {
    step: "loading", // loading | cover | q | send | done | blocked | error
    session: null,
    mock: false,
    idx: 0,
    fix: false, // sedang melengkapi satu pertanyaan dari halaman kirim
    ans: {}, // per id pertanyaan
    up: {}, // unggahan rekaman per id pertanyaan
    dirty: {}, // id pertanyaan yang belum tersimpan di server -> nomor versi
    syncing: false,
    syncRetry: false,
    name: "",
    contact: "",
    consent: false,
    busy: false,
    blocked: null,
    missing: [],
    enterAt: 0,
    baseSpent: 0,
    timeUp: false,
  };
  // Keadaan perekam untuk pertanyaan yang sedang tampil
  var R = { state: "idle", err: "", stream: null, rec: null, chunks: [], t0: 0, seq: 0, audioCtx: null, raf: 0 };
  var tickTimer = 0;
  var saveTimer = 0;

  /* ============ Util ============ */
  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function mmss(n) { n = Math.max(0, Math.round(n)); var s = n % 60; return Math.floor(n / 60) + ":" + (s < 10 ? "0" : "") + s; }
  function toast(m) {
    var t = $("#toast"); t.textContent = m; t.classList.add("show");
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove("show"); }, 3500);
  }
  function qs() { return S.session.questions; }
  function cur() { return qs()[S.idx]; }
  function A(q) { return S.ans[q.id]; }
  function isRec(q) { return q.type === "recording"; }
  function mediaNeeds() {
    var v = false, a = false;
    qs().forEach(function (q) { if (isRec(q)) { if (q.media === "video") v = true; else a = true; } });
    return { v: v, a: a, any: v || a };
  }
  function canRecord() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); }
  function deviceInfo() {
    var u = navigator.userAgent || "", m;
    var touchMac = /Macintosh/.test(u) && navigator.maxTouchPoints > 1;
    var dev = /Android/.test(u) ? (/Mobile/.test(u) ? "HP Android" : "Tablet Android")
      : /iPhone|iPod/.test(u) ? "iPhone" : (/iPad/.test(u) || touchMac) ? "iPad"
      : /Windows/.test(u) ? "Laptop/PC Windows" : /Macintosh/.test(u) ? "Mac" : /CrOS/.test(u) ? "Chromebook"
      : /Linux/.test(u) ? "Laptop/PC Linux" : "Perangkat lain";
    var br = (m = /(?:FBAN|FBAV|Instagram|Line\/|MicroMessenger)/.exec(u)) ? "Browser dalam aplikasi"
      : (m = /Edg(?:A|iOS)?\/(\d+)/.exec(u)) ? "Edge " + m[1]
      : (m = /OPR\/(\d+)/.exec(u)) ? "Opera " + m[1]
      : (m = /SamsungBrowser\/(\d+)/.exec(u)) ? "Samsung Internet " + m[1]
      : (m = /(?:Firefox|FxiOS)\/(\d+)/.exec(u)) ? "Firefox " + m[1]
      : (m = /(?:Chrome|CriOS)\/(\d+)/.exec(u)) ? "Chrome " + m[1]
      : (m = /Version\/(\d+)[.\d]* .*Safari/.exec(u)) ? "Safari " + m[1] : "Browser lain";
    return (dev + " · " + br + " · layar " + screen.width + "×" + screen.height).slice(0, 255);
  }
  function tenggat(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    try {
      return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" }) + ", " +
        d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return d.toString(); }
  }

  /* ============ Panggilan ke Worker ============ */
  function api(method, path, body) {
    return fetch("/api/session/" + encodeURIComponent(token) + path, {
      method: method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { status: r.status, body: j || {}, mock: r.headers.get("x-mock-api") === "1" };
      });
    }, function () { return { status: 0, body: {} }; });
  }
  /** Link tidak dapat dipakai (404/410 dengan code)? Tampilkan halamannya. */
  function gone(res) {
    var c = res.body && res.body.code;
    if ((res.status === 404 || res.status === 410) && (c === "not_found" || c === "submitted" || c === "expired" || c === "closed")) {
      stopMedia(); abortUploads(); S.blocked = res.body; S.step = c === "submitted" && S.justSubmitted ? "done" : "blocked";
      if (c === "submitted") clearLocal();
      render();
      return true;
    }
    return false;
  }
  function retryable(res) { return res.status === 0 || res.status >= 500 || res.status === 429; }

  /* ============ Simpanan lokal (bertahan bila browser tertutup) ============ */
  function persist() {
    try {
      var d = {}, sp = {}, pc = {};
      qs().forEach(function (q) {
        var a = A(q); sp[q.id] = Math.round(a.spent); if (a.paste) pc[q.id] = a.paste;
        if (S.dirty[q.id]) d[q.id] = { text: a.text, paste: a.paste, fallback: a.fallback };
      });
      localStorage.setItem(LS_KEY, JSON.stringify({ d: d, sp: sp, pc: pc }));
    } catch (e) { /* mode privat atau penyimpanan penuh: abaikan */ }
  }
  function readLocal() { try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) { return null; } }
  function clearLocal() { try { localStorage.removeItem(LS_KEY); } catch (e) { /* abaikan */ } }

  /* ============ Autosave jawaban ============ */
  function payload(q) {
    var a = A(q), rec = isRec(q);
    var p = {
      question_id: q.id,
      answer_text: rec && !a.fallback ? null : (String(a.text || "").trim() ? String(a.text) : null),
      time_spent_seconds: Math.round(a.spent),
      retake_count: a.retakeDone,
      is_text_fallback: rec && a.fallback,
    };
    // Sesi tidak mengembalikan paste_count. Bila di perangkat ini tidak ada catatan tempel,
    // field tidak dikirim supaya nilai yang sudah tersimpan di server tidak tertimpa nol.
    if (a.paste > 0) p.paste_count = a.paste;
    if (rec && !a.fallback && a.file) {
      p.file_key = a.file.key; p.file_mime = a.file.mime; p.file_size_bytes = a.file.size; p.recording_seconds = a.file.sec;
    }
    return p;
  }
  function markDirty(q) { S.dirty[q.id] = (S.dirty[q.id] || 0) + 1; persist(); pump(); refresh(); }
  /** Ketikan: langsung dicatat di perangkat, dikirim ke server setelah kandidat berhenti mengetik sebentar. */
  function touch(q) {
    S.dirty[q.id] = (S.dirty[q.id] || 0) + 1;
    clearTimeout(touch.t); touch.t = setTimeout(persist, 400);
    clearTimeout(saveTimer); saveTimer = setTimeout(pump, 1500);
  }
  function dirtyCount() { return Object.keys(S.dirty).length; }
  function pump() {
    if (S.syncing || S.step === "blocked" || S.step === "done") return;
    var id = Object.keys(S.dirty)[0];
    if (!id) return;
    var q = qs().filter(function (x) { return String(x.id) === id; })[0];
    if (!q) { delete S.dirty[id]; return pump(); }
    var ver = S.dirty[id];
    S.syncing = true; refresh();
    api("POST", "/answer", payload(q)).then(function (res) {
      S.syncing = false;
      if (gone(res)) return;
      if (retryable(res)) {
        S.syncRetry = true; refresh();
        clearTimeout(pump.t); pump.t = setTimeout(pump, 4000);
        return;
      }
      S.syncRetry = false;
      if (res.status !== 200 && res.body.message) toast(res.body.message);
      if (S.dirty[id] === ver) delete S.dirty[id];
      persist(); refresh(); pump();
    });
  }

  /* ============ Unggah rekaman ============ */
  function pendingUploads() {
    return qs().filter(function (q) { var u = S.up[q.id]; return u && (u.state === "up" || u.state === "wait"); });
  }
  function abortUploads() { Object.keys(S.up).forEach(function (id) { dropUpload(id); }); }
  function dropUpload(id) {
    var u = S.up[id]; if (!u) return;
    clearTimeout(u.timer); clearTimeout(u.watch);
    if (u.xhr) { u.xhr.onload = u.xhr.onerror = u.xhr.onabort = null; try { u.xhr.abort(); } catch (e) { /* abaikan */ } }
    if (u.url) { try { URL.revokeObjectURL(u.url); } catch (e) { /* abaikan */ } }
    delete S.up[id];
  }
  function runUpload(q) {
    var u = S.up[q.id]; if (!u || u.state === "done" || u.state === "failed") return;
    clearTimeout(u.timer);
    u.state = "up"; u.pct = 0; refresh();
    var xhr = u.xhr = new XMLHttpRequest();
    xhr.open("PUT", "/api/session/" + encodeURIComponent(token) + "/upload?question_id=" + q.id + "&retake=" + u.retake);
    xhr.setRequestHeader("content-type", u.mime);
    function stalled() { try { xhr.abort(); } catch (e) { /* abaikan */ } }
    function watch() { clearTimeout(u.watch); u.watch = setTimeout(stalled, 60000); }
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) { u.pct = Math.min(99, Math.round(e.loaded / e.total * 100)); watch(); refreshUpload(q); }
    };
    function again() {
      clearTimeout(u.watch);
      if (S.up[q.id] !== u) return;
      u.state = "wait"; u.tries++;
      u.timer = setTimeout(function () { runUpload(q); }, Math.min(30000, 2000 * Math.pow(2, Math.min(u.tries, 4))));
      refresh();
    }
    xhr.onerror = xhr.onabort = again;
    xhr.onload = function () {
      clearTimeout(u.watch);
      if (S.up[q.id] !== u) return;
      var body = {}; try { body = JSON.parse(xhr.responseText) || {}; } catch (e) { /* abaikan */ }
      var a = A(q);
      if (xhr.status === 200 && body.file_key) {
        u.state = "done"; u.pct = 100;
        a.file = { key: body.file_key, mime: body.file_mime, size: body.file_size_bytes, sec: u.sec };
        a.hasRec = true; a.recSec = u.sec; a.retakeDone = u.retake;
        markDirty(q);
        return;
      }
      if (xhr.status === 409 && body.code === "already_uploaded") { u.state = "done"; u.pct = 100; a.hasRec = true; refresh(); return; }
      if (gone({ status: xhr.status, body: body })) return;
      if (xhr.status === 413 || xhr.status === 415 || xhr.status === 422 || xhr.status === 409) {
        u.state = "failed"; u.error = body.message || "Rekaman tidak dapat diunggah."; refresh(); return;
      }
      again();
    };
    watch();
    xhr.send(u.blob);
  }
  window.addEventListener("online", function () {
    if (!S.session) return;
    qs().forEach(function (q) { var u = S.up[q.id]; if (u && u.state === "wait") runUpload(q); });
    pump();
  });

  /* ============ Kelengkapan ============ */
  function filled(q) {
    var a = A(q);
    if (isRec(q) && !a.fallback) { var u = S.up[q.id]; return a.hasRec || !!(u && u.state !== "failed"); }
    return String(a.text || "").trim().length > 0;
  }
  function missingList() { return qs().filter(function (q) { return q.is_required && (!filled(q) || S.missing.indexOf(q.id) >= 0); }); }

  /* ============ Media ============ */
  function pickMime(video) {
    var list = video
      ? ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"]
      : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"];
    for (var i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) { /* lanjut */ }
    }
    return "";
  }
  function stopMeter() {
    if (R.raf) cancelAnimationFrame(R.raf); R.raf = 0;
    if (R.audioCtx) { try { R.audioCtx.close(); } catch (e) { /* abaikan */ } R.audioCtx = null; }
  }
  function startMeter() {
    stopMeter();
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !R.stream) return;
    try {
      var ctx = R.audioCtx = new AC(), an = ctx.createAnalyser(), buf;
      an.fftSize = 256; buf = new Uint8Array(an.fftSize);
      ctx.createMediaStreamSource(R.stream).connect(an);
      if (ctx.state === "suspended" && ctx.resume) ctx.resume().catch(function () { /* abaikan */ });
      var mult = [0.6, 0.85, 1, 0.85, 0.6], smooth = 0;
      (function loop() {
        R.raf = requestAnimationFrame(loop);
        an.getByteTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
        smooth = Math.max(Math.min(1, Math.sqrt(sum / buf.length) * 5), smooth * 0.85);
        var bars = document.querySelectorAll("#lvl i"), max = bars.length && bars[0].parentNode.classList.contains("over") ? 18 : 38;
        for (var b = 0; b < bars.length; b++) bars[b].style.height = (6 + smooth * max * mult[b]) + "px";
      })();
    } catch (e) { stopMeter(); }
  }
  function stopMedia() {
    R.seq++;
    stopMeter();
    if (R.rec) { try { R.rec.ondataavailable = R.rec.onstop = R.rec.onerror = null; if (R.rec.state !== "inactive") R.rec.stop(); } catch (e) { /* abaikan */ } R.rec = null; }
    if (R.stream) { R.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* abaikan */ } }); R.stream = null; }
    R.chunks = [];
  }
  function camOn() {
    var q = cur(), video = q.media === "video";
    stopMedia();
    if (!window.isSecureContext || !canRecord()) { R.state = "error"; R.err = "unsupported"; render(); return; }
    var seq = R.seq;
    R.state = "ask"; R.slow = false; render();
    // Sebagian browser tidak pernah menjawab permintaan izin: jangan biarkan kandidat menunggu tanpa jalan keluar.
    setTimeout(function () { if (seq === R.seq && R.state === "ask") { R.slow = true; render(); } }, 10000);
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } : false,
    }).then(function (stream) {
      if (seq !== R.seq || S.step !== "q") { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      R.stream = stream; R.state = "ready"; render(); startMeter();
    }, function (err) {
      if (seq !== R.seq) return;
      var n = (err && err.name) || "";
      R.err = /NotAllowed|Security|PermissionDenied/.test(n) ? "denied"
        : /NotFound|DevicesNotFound|Overconstrained/.test(n) ? "nodevice"
        : /NotReadable|TrackStart|Abort/.test(n) ? "busy" : "other";
      R.state = "error"; render();
    });
  }
  function recStart() {
    var q = cur(), video = q.media === "video", mime = pickMime(video), rec;
    if (!R.stream) return camOn();
    var opts = { audioBitsPerSecond: AUDIO_BPS };
    if (video) opts.videoBitsPerSecond = VIDEO_BPS;
    if (mime) opts.mimeType = mime;
    try { rec = new MediaRecorder(R.stream, opts); }
    catch (e) { try { rec = new MediaRecorder(R.stream); } catch (e2) { R.state = "error"; R.err = "unsupported"; stopMedia(); render(); return; } }
    R.rec = rec; R.chunks = []; R.pick = mime;
    rec.ondataavailable = function (e) { if (e.data && e.data.size) R.chunks.push(e.data); };
    rec.onstop = function () { recDone(q, rec); };
    rec.onerror = function () { if (rec.state !== "inactive") { try { rec.stop(); } catch (e) { /* abaikan */ } } };
    R.stream.getTracks().forEach(function (t) { t.onended = function () { if (R.rec === rec && rec.state === "recording") rec.stop(); }; });
    if (R.audioCtx && R.audioCtx.state === "suspended") { try { R.audioCtx.resume(); } catch (e) { /* abaikan */ } }
    try { rec.start(1000); } catch (e) { R.state = "error"; R.err = "unsupported"; stopMedia(); render(); return; }
    R.t0 = Date.now(); R.state = "rec"; render();
  }
  function recStop() { if (R.rec && R.rec.state !== "inactive") { try { R.rec.stop(); } catch (e) { /* abaikan */ } } }
  function recDone(q, rec) {
    var video = q.media === "video";
    var sec = Math.min(Math.max(1, Math.round((Date.now() - R.t0) / 1000)), (q.time_limit_minutes || 2) * 60);
    var type = String(rec.mimeType || R.pick || (video ? "video/webm" : "audio/webm")).split(";")[0].trim().toLowerCase();
    if (!video) type = type.replace(/^video\//, "audio/");
    var blob = new Blob(R.chunks, { type: type });
    stopMedia();
    if (!blob.size) { R.state = "ready"; toast("Rekaman kosong. Mohon coba merekam lagi."); camOn(); return; }
    var a = A(q), old = S.up[q.id], had = a.hasRec || !!(old && old.state !== "failed");
    dropUpload(q.id);
    if (had) a.retake++;
    a.hasRec = false; a.file = null;
    S.missing = S.missing.filter(function (id) { return id !== q.id; });
    S.up[q.id] = { blob: blob, mime: type, sec: sec, retake: a.retake, state: "up", pct: 0, tries: 0, url: URL.createObjectURL(blob) };
    R.state = "done"; render();
    runUpload(q);
  }

  /* ============ Alur ============ */
  function curSpent() { return S.baseSpent + Math.floor((Date.now() - S.enterAt) / 1000); }
  function limitOf(q) {
    return !isRec(q) && S.session.interview.use_time_limit && !S.fix && q.time_limit_minutes > 0 ? q.time_limit_minutes * 60 : 0;
  }
  function enter() {
    var q = cur(), a = A(q);
    stopMedia();
    S.enterAt = Date.now(); S.baseSpent = a.spent;
    S.timeUp = limitOf(q) > 0 && a.spent >= limitOf(q);
    R.state = (a.hasRec || S.up[q.id]) ? "done" : "idle"; R.err = "";
    clearInterval(tickTimer); tickTimer = setInterval(tick, 500);
    render(); window.scrollTo(0, 0);
  }
  function leave() {
    var q = cur(), a = A(q);
    clearInterval(tickTimer); clearTimeout(saveTimer);
    a.spent = curSpent();
    stopMedia();
    markDirty(q);
  }
  function tick() {
    if (S.step !== "q") return;
    var q = cur(), a = A(q), lim = limitOf(q);
    a.spent = curSpent();
    if (a.spent % 5 === 0) persist();
    if (lim && !S.timeUp) {
      var left = lim - a.spent, t = $("#qtimer");
      if (t) { t.textContent = mmss(left); t.classList.toggle("low", left <= 30); }
      if (left <= 0) { toast("Waktu habis. Lanjut ke pertanyaan berikutnya."); next(true); return; }
    }
    if (R.state === "rec") {
      var max = (q.time_limit_minutes || 2) * 60, el = (Date.now() - R.t0) / 1000, c = $("#recclock");
      if (c) c.textContent = mmss(max - el);
      if (el >= max) { toast("Durasi maksimal tercapai."); recStop(); }
    }
  }
  function next(force) {
    var q = cur();
    if (R.state === "rec") { toast("Selesaikan rekaman dulu."); return; }
    if (!force && !S.timeUp && q.is_required && !filled(q)) {
      toast(isRec(q) && !A(q).fallback ? "Mohon rekam jawaban Anda dulu." : "Pertanyaan ini wajib dijawab."); return;
    }
    S.missing = S.missing.filter(function (id) { return id !== q.id || !filled(q); });
    leave();
    if (!S.fix && S.idx < qs().length - 1) { S.idx++; enter(); return; }
    S.fix = false; S.step = "send"; render(); window.scrollTo(0, 0);
  }
  function back() {
    if (R.state === "rec") { toast("Selesaikan rekaman dulu."); return; }
    if (S.idx <= 0) return;
    leave(); S.idx--; enter();
  }
  /** Lanjut di pertanyaan pertama yang belum pernah disimpan. Pertanyaan wajib yang terlewat
   *  (waktu habis, unggahan hilang) dilengkapi lewat halaman kirim, bukan dengan mengulang dari awal. */
  function resumeIndex() {
    var list = qs();
    for (var i = 0; i < list.length; i++) if (!A(list[i]).seen) return i;
    return -1;
  }

  function load() {
    if (!token) { S.blocked = { code: "not_found", message: "Link tidak ditemukan." }; S.step = "blocked"; render(); return; }
    S.step = "loading"; render();
    api("GET", "").then(function (res) {
      if (gone(res)) return;
      if (res.status !== 200 || !res.body.questions) { S.step = "error"; render(); return; }
      var s = S.session = res.body, local = readLocal() || {};
      S.mock = !!res.mock;
      S.name = (s.candidate && s.candidate.name) || ""; S.contact = (s.candidate && s.candidate.contact) || "";
      s.questions.forEach(function (q) {
        var sv = q.answer, a = S.ans[q.id] = {
          text: (sv && sv.answer_text) || "", spent: (sv && sv.time_spent_seconds) || 0, paste: 0,
          retake: (sv && sv.retake_count) || 0, retakeDone: (sv && sv.retake_count) || 0,
          fallback: !!(sv && sv.is_text_fallback), hasRec: !!(sv && sv.has_recording),
          recSec: (sv && sv.recording_seconds) || 0, file: null, seen: !!sv,
        };
        // Jawaban yang belum sempat tersimpan sebelum browser tertutup
        var d = local.d && local.d[q.id];
        if (d && s.started) {
          a.text = d.text || ""; a.seen = true;
          if (isRec(q) && s.interview.allow_text_fallback) a.fallback = !!d.fallback;
          S.dirty[q.id] = 1;
        }
        if (local.sp && local.sp[q.id] > a.spent) a.spent = local.sp[q.id];
        if (local.pc && local.pc[q.id] > 0) a.paste = local.pc[q.id];
      });
      if (!s.started) { S.step = "cover"; render(); return; }
      var i = resumeIndex();
      if (i < 0) { S.step = "send"; render(); } else { S.step = "q"; S.idx = i; enter(); if (i > 0) toast("Melanjutkan dari pertanyaan " + (i + 1) + "."); }
      pump();
    });
  }
  function start() {
    var name = S.name.trim(), contact = S.contact.trim();
    if (!name) { toast("Mohon isi nama lengkap."); return; }
    if (!contact) { toast("Mohon isi nomor WhatsApp atau email."); return; }
    if (!S.consent) { toast("Mohon centang persetujuan lebih dulu."); return; }
    if (S.busy) return;
    S.busy = true; render();
    api("POST", "/start", { candidate_name: name, candidate_contact: contact, consent: true, device_info: deviceInfo() }).then(function (res) {
      S.busy = false;
      if (gone(res)) return;
      if (res.status === 200) { S.session.started = true; S.step = "q"; S.idx = 0; enter(); return; }
      toast(res.status === 422 ? "Mohon periksa kembali nama dan kontak Anda." : "Gagal memulai. Periksa koneksi Anda, lalu coba lagi.");
      render();
    });
  }
  function submit() {
    if (S.busy || pendingUploads().length || dirtyCount() || missingList().length) return;
    S.busy = true; render();
    var total = 0; qs().forEach(function (q) { total += Math.round(A(q).spent); });
    S.justSubmitted = true;
    api("POST", "/submit", { total_duration_seconds: total, device_info: deviceInfo() }).then(function (res) {
      S.busy = false;
      if (res.status === 200) { clearLocal(); abortUploads(); S.step = "done"; render(); window.scrollTo(0, 0); return; }
      if (gone(res)) return;
      S.justSubmitted = false;
      if (res.status === 422 && res.body.missing_question_ids) {
        S.missing = res.body.missing_question_ids;
        // Server adalah acuan: rekaman yang dianggap belum ada harus diunggah lagi
        qs().forEach(function (q) {
          if (S.missing.indexOf(q.id) >= 0 && isRec(q) && !A(q).fallback) { A(q).hasRec = false; A(q).file = null; dropUpload(q.id); }
        });
        toast(res.body.message || "Masih ada pertanyaan wajib yang belum lengkap.");
      } else toast("Gagal mengirim. Periksa koneksi Anda, lalu coba lagi.");
      render();
    });
  }

  /* ============ Tampilan ============ */
  function uploadLine(q) {
    var u = S.up[q.id], a = A(q);
    if (!u) return a.hasRec ? '<p class="small muted">✓ Rekaman tersimpan' + (a.recSec ? " · " + mmss(a.recSec) : "") + ".</p>" : "";
    if (u.state === "up") return '<div class="bar"><i style="width:' + u.pct + '%"></i></div><p class="small muted num">Mengunggah rekaman… ' + u.pct + "%. Anda boleh lanjut ke pertanyaan berikutnya.</p>";
    if (u.state === "wait") return '<div class="note warn">Sinyal lemah. Unggahan dicoba ulang otomatis, rekaman Anda aman selama halaman ini tetap terbuka. <button class="link" data-act="up-now">Coba sekarang</button></div>';
    if (u.state === "failed") return '<div class="note err">' + esc(u.error) + "</div>";
    return '<p class="small muted">✓ Rekaman terunggah · ' + mmss(u.sec) + ".</p>";
  }
  function refreshUpload(q) {
    if (S.step === "q" && cur().id === q.id) { var el = $("#upline"); if (el) el.innerHTML = uploadLine(q); }
    else if (S.step === "send") { var p = $("#up-" + q.id); if (p) p.textContent = S.up[q.id].pct + "%"; }
    chip();
  }
  function chip() {
    var n = S.session ? pendingUploads().length : 0;
    $("#chip").innerHTML = (S.mock ? '<span class="badge warn">Mode tiruan</span>' : "") +
      (n && S.step !== "done" && S.step !== "blocked" ? '<span class="badge acc">↑ ' + n + " rekaman diunggah</span>" : "");
  }
  function syncText() {
    if (S.syncRetry) return "Belum tersimpan. Mencoba lagi saat koneksi kembali…";
    if (S.syncing || dirtyCount()) return "Menyimpan…";
    return "Jawaban tersimpan otomatis.";
  }
  /** Perbarui bagian yang berubah tanpa menggambar ulang isian yang sedang diketik. */
  function refresh() {
    if (S.step === "send") { render(); return; }
    chip();
    if (S.step !== "q") return;
    var el = $("#sync"); if (el) el.textContent = syncText();
    var u = $("#upline"); if (u) u.innerHTML = uploadLine(cur());
  }

  function vCover() {
    var s = S.session, iv = s.interview, m = mediaNeeds(), n = s.questions.length;
    var need = m.v ? "kamera dan mikrofon" : "mikrofon";
    var intro = (iv.interviewer ? "Perkenalkan, saya " + esc(iv.interviewer) + " dari " + esc(iv.company) + (iv.location ? ", " + esc(iv.location) : "") + ". " : "") + esc(iv.opening_text || "");
    return '<h2>Wawancara Awal Online' + (iv.position ? "<br>" + esc(iv.position) : "") + "</h2>" +
      '<p class="small muted">' + esc(iv.company) + (iv.location ? " · " + esc(iv.location) : "") + "</p>" +
      (intro.trim() ? '<p class="small">' + intro + "</p>" : "") +
      '<div class="row"><span class="badge acc">' + n + ' pertanyaan</span><span class="badge acc">± ' + iv.estimated_minutes + " menit</span>" +
        (m.any ? '<span class="badge rec">butuh ' + (m.v ? "kamera &amp; mikrofon" : "mikrofon") + "</span>" : "") +
        '<span class="badge">' + (iv.allow_back ? "boleh kembali" : "tidak bisa kembali") + "</span></div>" +
      '<ul class="plain"><li>Dapat diisi sampai <b>' + esc(tenggat(s.expired_at)) + "</b>.</li>" +
        "<li>Perangkat: HP atau laptop dengan koneksi internet" + (m.any ? ", " + need + " yang berfungsi, di tempat yang tenang" : "") + ".</li>" +
        "<li>Jawaban tersimpan otomatis. Bila koneksi terputus, buka lagi link yang sama untuk melanjutkan.</li>" +
        (iv.use_time_limit ? "<li>Pertanyaan tertulis memiliki batas waktu.</li>" : "") + "</ul>" +
      (m.any && !canRecord() ? '<div class="note warn"><b>Browser ini tidak mendukung perekaman.</b> Salin link ini lalu buka di Chrome (Android) atau Safari (iPhone).</div>' : "") +
      '<label class="f"><span>Nama lengkap</span><input type="text" id="f-name" maxlength="150" autocomplete="name" value="' + esc(S.name) + '"></label>' +
      '<label class="f"><span>Nomor WhatsApp atau email</span><input type="text" id="f-contact" maxlength="150" autocapitalize="off" value="' + esc(S.contact) + '"></label>' +
      '<p class="small muted">Terisi dari data lamaran Anda. Perbaiki bila ada yang keliru.</p>' +
      '<div class="note"><b>Perlindungan data.</b> Jawaban' + (m.any ? " dan rekaman" : "") + " Anda hanya digunakan untuk penilaian rekrutmen dan hanya dapat diakses tim rekrutmen " + esc(iv.company) + ", serta disimpan sebagai arsip lamaran Anda. Anda dapat meminta data Anda dihapus. Mohon jangan menyebutkan NIK, nomor rekening, atau dokumen pribadi lain." +
        (iv.track_paste ? " Sistem mencatat bila jawaban tertulis ditempel dari sumber lain." : "") + "</div>" +
      '<label class="chk"><input type="checkbox" id="f-consent"' + (S.consent ? " checked" : "") + "><span>Saya menyetujui " +
        (m.any ? "perekaman " + (m.v ? "video dan suara" : "suara") + " serta " : "") + "pemrosesan data saya untuk keperluan rekrutmen ini.</span></label>" +
      '<button class="primary block" data-act="start"' + (S.busy ? " disabled" : "") + ">" + (S.busy ? "Memulai…" : "Mulai wawancara →") + "</button>" +
      (m.any ? '<p class="small muted center">Tidak bersedia direkam? Hubungi recruiter Anda. Anda tetap dapat mengikuti phone screening lewat telepon.</p>' : "");
  }

  var ERR = {
    denied: "Izin %s ditolak. Ketuk ikon gembok atau pengaturan situs di samping alamat halaman, izinkan %s, lalu tekan Coba lagi.",
    nodevice: "%s tidak ditemukan di perangkat ini. Pastikan perangkatnya terpasang dan tidak dimatikan.",
    busy: "%s sedang dipakai aplikasi lain (misalnya panggilan video). Tutup aplikasi itu, lalu tekan Coba lagi.",
    unsupported: "Browser ini tidak mendukung perekaman. Salin link ini lalu buka di Chrome (Android) atau Safari (iPhone).",
    other: "%s tidak dapat dinyalakan. Tekan Coba lagi.",
  };
  function vRecorder(q, a) {
    var video = q.media === "video", max = (q.time_limit_minutes || 2) * 60, left = q.max_retakes - a.retake;
    var cls = "stage" + (video ? "" : " audio"), dev = video ? "kamera dan mikrofon" : "mikrofon", Dev = video ? "Kamera atau mikrofon" : "Mikrofon";
    var lvl = '<div class="lvl' + (video ? " over" : "") + '" id="lvl" aria-label="Level suara"><i></i><i></i><i></i><i></i><i></i></div>';
    var view = (video ? '<video id="live" class="mirror" autoplay muted playsinline></video>' : "") + lvl;
    var fb = S.session.interview.allow_text_fallback
      ? '<button class="link" data-act="fallback">' + (video ? "Kamera" : "Mikrofon") + " bermasalah? Jawab dengan ketikan</button>" : "";
    var u = S.up[q.id], html;
    if (R.state === "idle") {
      html = '<div class="' + cls + '"><div class="idle">' + (video ? "Kamera" : "Mikrofon") + " belum menyala.<br>Durasi maksimal " + mmss(max) + ".</div></div>" +
        '<p class="small muted">Jawaban pertanyaan ini direkam dengan ' + (video ? "video" : "suara") + ". Setelah tombol di bawah ditekan, browser akan bertanya apakah halaman ini boleh memakai " + dev + '. Pilih <b>Izinkan</b>. Perekaman baru dimulai setelah Anda menekan "Mulai merekam". ' +
        (left > 0 ? "Anda punya " + left + " kesempatan merekam ulang." : "Tidak ada kesempatan merekam ulang.") + "</p>" +
        '<button class="primary block" data-act="cam">' + (video ? "Nyalakan kamera" : "Siapkan mikrofon") + "</button>" + fb;
    } else if (R.state === "ask") {
      html = '<div class="' + cls + '"><div class="idle">Meminta izin ' + dev + "…<br>Pilih Izinkan pada pertanyaan dari browser.</div></div>" +
        (R.slow ? '<div class="note warn">Pertanyaan izin belum muncul atau belum dijawab. Bila tidak ada pertanyaan dari browser, periksa izin ' + dev + ' di pengaturan situs, lalu tekan Coba lagi.</div><button class="block" data-act="cam">Coba lagi</button>' + fb : "");
    } else if (R.state === "error") {
      html = '<div class="note err"><b>' + (R.err === "unsupported" ? "Perekaman tidak didukung" : R.err === "denied" ? "Izin ditolak" : Dev + " bermasalah") + ".</b> " +
        esc((ERR[R.err] || ERR.other).replace("%s", R.err === "denied" ? dev : Dev).replace("%s", dev)) + "</div>" +
        '<button class="primary block" data-act="cam">Coba lagi</button>' +
        (fb || '<p class="small muted">Jika tetap tidak bisa, hubungi recruiter Anda untuk phone screening lewat telepon.</p>');
    } else if (R.state === "ready") {
      html = '<div class="' + cls + '">' + view + '<div class="tag">Siap merekam</div><div class="clock">' + mmss(max) + "</div></div>" +
        '<p class="small muted">' + (video ? "Pastikan wajah Anda terlihat jelas. " : "") + "Coba bicara: garis hijau bergerak bila suara Anda terdengar.</p>" +
        '<button class="rec block" data-act="rec">● Mulai merekam</button>' +
        ((a.hasRec || u) ? '<button class="link" data-act="cancel-retake">Batal, pakai rekaman sebelumnya</button>' : fb);
    } else if (R.state === "rec") {
      html = '<div class="' + cls + '">' + view + '<div class="tag"><span class="dot"></span>Merekam</div><div class="clock" id="recclock">' + mmss(max) + "</div></div>" +
        '<button class="block" data-act="stop">■ Selesai merekam</button>';
    } else {
      html = '<div class="' + cls + '">' + (u && u.url
        ? (video ? '<video controls playsinline preload="metadata" src="' + u.url + '"></video>' : '<audio controls preload="metadata" src="' + u.url + '"></audio>')
        : '<div class="idle">Rekaman Anda sudah tersimpan' + (a.recSec ? " (" + mmss(a.recSec) + ")" : "") + ".</div>") + "</div>" +
        '<div id="upline" class="stack tight">' + uploadLine(q) + "</div>" +
        (u && u.url ? '<p class="small muted">Putar dulu untuk memastikan suara Anda terdengar.</p>' : "") +
        (u && u.state === "failed" ? '<button class="block" data-act="retake">Rekam lagi</button>'
          : left > 0 ? '<button class="block" data-act="retake">↻ Rekam ulang (sisa ' + left + ")</button>"
          : '<p class="small muted">Kesempatan merekam ulang sudah habis.</p>');
    }
    return html;
  }
  function vQuestion() {
    var s = S.session, iv = s.interview, i = S.idx, q = cur(), a = A(q), n = s.questions.length, body, lim = limitOf(q);
    var dis = S.timeUp ? " disabled" : "";
    if (isRec(q) && a.fallback) {
      body = '<div class="note">Jawaban ketik dipakai karena mikrofon atau kamera bermasalah.</div>' +
        '<textarea id="f-text" maxlength="10000" placeholder="Tulis jawaban Anda di sini…">' + esc(a.text) + "</textarea>" +
        '<button class="link" data-act="record-again">Coba rekam lagi</button>';
    } else if (isRec(q)) {
      body = vRecorder(q, a);
    } else if (q.type === "choice") {
      body = '<div class="choices">' + (q.options || []).map(function (o) {
        var sel = a.text === o;
        return '<label class="choice' + (sel ? " sel" : "") + '"><input type="radio" name="opt" value="' + esc(o) + '"' + (sel ? " checked" : "") + dis + "><span>" + esc(o) + "</span></label>";
      }).join("") + "</div>";
    } else if (q.type === "scale") {
      body = '<div class="scale">' + [1, 2, 3, 4, 5].map(function (v) {
        return '<button class="' + (a.text === String(v) ? "sel" : "") + '" data-act="scale" data-v="' + v + '" aria-pressed="' + (a.text === String(v)) + '"' + dis + ">" + v + "</button>";
      }).join("") + '</div><div class="spread small muted"><span>1 = ' + esc(q.scale_min_label || "terendah") + "</span><span>5 = " + esc(q.scale_max_label || "tertinggi") + "</span></div>";
    } else if (q.type === "long_text") {
      body = '<textarea id="f-text" maxlength="10000" placeholder="Tulis jawaban Anda di sini…"' + dis + ">" + esc(a.text) + "</textarea>";
    } else {
      body = '<input type="text" id="f-text" maxlength="500" placeholder="Tulis jawaban Anda…" autocomplete="off" value="' + esc(a.text) + '"' + dis + ">";
    }
    var last = i === n - 1;
    return '<div class="stack tight"><div class="spread"><div class="small muted num">Pertanyaan ' + (i + 1) + " dari " + n + "</div>" +
        (lim && !S.timeUp ? '<div class="timer' + (lim - a.spent <= 30 ? " low" : "") + '" id="qtimer" aria-label="Sisa waktu">' + mmss(lim - a.spent) + "</div>" : "") +
      '</div><div class="bar"><i style="width:' + Math.round(i / n * 100) + '%"></i></div></div>' +
      "<h2>" + esc(q.question) + (q.is_required ? "" : ' <span class="badge">opsional</span>') + "</h2>" +
      (q.help_text ? '<p class="small muted">' + esc(q.help_text) + "</p>" : "") +
      (S.timeUp ? '<div class="note warn">Waktu untuk pertanyaan ini sudah habis.</div>' : "") + body +
      '<div class="row nowrap">' + (iv.allow_back && i > 0 && !S.fix ? '<button data-act="back" aria-label="Pertanyaan sebelumnya">←</button>' : "") +
        '<button class="primary block" data-act="next">' + (S.fix ? "Simpan &amp; kembali" : last ? "Selesai, periksa &amp; kirim →" : "Lanjut →") + "</button></div>" +
      '<p class="small muted center"><span id="sync">' + syncText() + "</span>" +
        (iv.allow_back || S.fix ? "" : " Setelah lanjut, Anda tidak dapat kembali ke pertanyaan ini.") + "</p>";
  }
  function vSend() {
    var list = qs(), n = list.length, miss = missingList(), pend = pendingUploads(), dirty = dirtyCount();
    var done = list.filter(filled).length, failed = list.filter(function (q) { var u = S.up[q.id]; return u && u.state === "failed"; });
    var why = miss.length ? "Lengkapi dulu pertanyaan wajib di atas."
      : pend.length ? "Tombol kirim aktif setelah semua rekaman selesai diunggah."
      : dirty ? (S.syncRetry ? "Jawaban belum tersimpan. Mencoba lagi saat koneksi kembali…" : "Menyimpan jawaban…") : "";
    var num = function (q) { return list.indexOf(q) + 1; };
    return "<h2>Periksa dan kirim</h2>" +
      '<p class="small muted num">' + done + " dari " + n + " pertanyaan terjawab.</p>" +
      (miss.length ? '<div class="stack tight"><h3>Pertanyaan wajib yang belum lengkap</h3><ul class="list">' + miss.map(function (q) {
        return "<li><span>Pertanyaan " + num(q) + (isRec(q) && !A(q).fallback ? " · rekaman belum ada" : " · belum dijawab") + '</span><button class="sm" data-act="fix" data-v="' + list.indexOf(q) + '">Lengkapi</button></li>';
      }).join("") + "</ul></div>" : "") +
      (pend.length ? '<div class="stack tight"><h3>Rekaman sedang diunggah</h3><ul class="list">' + pend.map(function (q) {
        var u = S.up[q.id];
        return "<li><span>Pertanyaan " + num(q) + '</span><span class="num muted">' + (u.state === "wait" ? "menunggu sinyal…" : '<span id="up-' + q.id + '">' + u.pct + "%</span>") + "</span></li>";
      }).join("") + '</ul><p class="small muted">Jangan tutup halaman ini. Bila sinyal lemah, unggahan dicoba ulang otomatis. <button class="link" data-act="up-all">Coba sekarang</button></p></div>' : "") +
      (failed.length && !miss.length ? '<div class="note err">Ada rekaman yang gagal diunggah.</div>' : "") +
      '<div class="note">Setelah dikirim, jawaban tidak dapat diubah dan link ini tidak dapat dipakai lagi.</div>' +
      '<button class="primary block" data-act="submit"' + (why || S.busy ? " disabled" : "") + ">" + (S.busy ? "Mengirim…" : "Kirim jawaban") + "</button>" +
      (why ? '<p class="small muted center">' + why + "</p>" : "") +
      (S.session.interview.allow_back ? '<button class="block" data-act="review">← Kembali ke pertanyaan</button>' : "");
  }
  function vDone() {
    var n = S.session ? qs().length : 0, r = 0, total = 0;
    if (S.session) qs().forEach(function (q) { var a = A(q); total += a.spent; if (isRec(q) && !a.fallback && a.hasRec) r++; });
    return '<div class="mark ok" aria-hidden="true">✓</div><h2 class="center">Jawaban Anda sudah terkirim</h2>' +
      '<p class="small muted center">Terima kasih' + (S.name.trim() ? ", " + esc(S.name.trim()) : "") + ". Tim rekrutmen PT Mitra Prodin akan meninjau jawaban Anda dan menghubungi Anda melalui kontak yang Anda berikan.</p>" +
      (n ? '<p class="small muted center num">' + n + " pertanyaan · " + r + " rekaman · waktu pengerjaan " + mmss(total) + "</p>" : "") +
      '<p class="small muted center">Anda boleh menutup halaman ini.</p>';
  }
  var BLOCK = {
    not_found: ["?", "", "Link tidak ditemukan", "Periksa kembali link pada pesan undangan Anda. Pastikan link disalin utuh, atau hubungi recruiter Anda."],
    submitted: ["✓", "ok", "Jawaban sudah dikirim", "Link ini hanya dapat dipakai satu kali. Tim rekrutmen PT Mitra Prodin akan menghubungi Anda."],
    expired: ["!", "warn", "Tenggat sudah lewat", "Bila Anda masih ingin mengikuti wawancara awal, mintalah link baru kepada recruiter Anda."],
    closed: ["!", "warn", "Link sudah tidak digunakan", "Bila ada pertanyaan, silakan hubungi recruiter Anda."],
  };
  function vBlocked() {
    var b = S.blocked || {}, t = BLOCK[b.code] || BLOCK.not_found;
    return '<div class="mark ' + t[1] + '" aria-hidden="true">' + t[0] + '</div><h2 class="center">' + t[2] + "</h2>" +
      '<p class="center">' + esc(b.message || "") + '</p><p class="small muted center">' + t[3] + "</p>";
  }
  function vError() {
    return '<div class="mark warn" aria-hidden="true">!</div><h2 class="center">Halaman belum dapat dimuat</h2>' +
      '<p class="small muted center">Periksa koneksi internet Anda, lalu coba lagi. Jawaban yang sudah tersimpan tidak hilang.</p>' +
      '<button class="primary block" data-act="reload">Coba lagi</button>';
  }
  function render() {
    var v = S.step === "cover" ? vCover() : S.step === "q" ? vQuestion() : S.step === "send" ? vSend()
      : S.step === "done" ? vDone() : S.step === "blocked" ? vBlocked() : S.step === "error" ? vError()
      : '<p class="muted center pad">Memuat…</p>';
    $("#app").innerHTML = v;
    chip();
    var live = $("#live");
    if (live && R.stream) { live.muted = true; live.srcObject = R.stream; var p = live.play(); if (p && p.catch) p.catch(function () { /* abaikan */ }); }
  }

  /* ============ Peristiwa ============ */
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-act]"); if (!b || b.disabled) return;
    var act = b.getAttribute("data-act"), q, a;
    if (act === "reload") return load();
    if (act === "start") return start();
    if (!S.session) return;
    if (act === "submit") return submit();
    if (act === "up-all") { pendingUploads().forEach(runUpload); return; }
    if (act === "fix") { S.fix = true; S.step = "q"; S.idx = Number(b.getAttribute("data-v")) || 0; return enter(); }
    if (act === "review") { S.step = "q"; S.idx = qs().length - 1; return enter(); }
    if (S.step !== "q") return;
    q = cur(); a = A(q);
    switch (act) {
      case "next": return next(false);
      case "back": return back();
      case "scale": if (S.timeUp) return; a.text = b.getAttribute("data-v"); a.seen = true; markDirty(q); render(); return;
      case "cam": case "retake": return camOn();
      case "cancel-retake": stopMedia(); R.state = "done"; render(); return;
      case "rec": return recStart();
      case "stop": return recStop();
      case "up-now": return runUpload(q);
      case "fallback": stopMedia(); dropUpload(q.id); a.fallback = true; a.hasRec = false; a.file = null; R.state = "idle"; markDirty(q); render(); return;
      case "record-again": a.fallback = false; R.state = "idle"; markDirty(q); render(); return;
    }
  });
  function onField(e) {
    var el = e.target, q, a;
    if (el.id === "f-name") { S.name = el.value; return; }
    if (el.id === "f-contact") { S.contact = el.value; return; }
    if (el.id === "f-consent") { S.consent = el.checked; return; }
    if (S.step !== "q" || S.timeUp) return;
    q = cur(); a = A(q);
    if (el.id === "f-text") { a.text = el.value; a.seen = true; touch(q); var s = $("#sync"); if (s) s.textContent = "Menyimpan…"; return; }
    if (el.name === "opt" && e.type === "change") { a.text = el.value; a.seen = true; markDirty(q); render(); }
  }
  document.addEventListener("input", onField);
  document.addEventListener("change", onField);
  document.addEventListener("paste", function (e) {
    if (S.step === "q" && S.session.interview.track_paste && e.target && e.target.id === "f-text") A(cur()).paste++;
  });
  window.addEventListener("beforeunload", function (e) {
    if (!S.session || S.step === "done" || S.step === "blocked") return;
    if (S.step === "q") { A(cur()).spent = curSpent(); }
    persist();
    if (R.state === "rec" || pendingUploads().length) { e.preventDefault(); e.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", function () { if (S.session && document.hidden) persist(); });

  load();
})();
