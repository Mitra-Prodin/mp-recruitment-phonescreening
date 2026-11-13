/**
 * Aplikasi kandidat Phone Screening PT Mitra Prodin.
 *
 *   GET  /s/{token}                       halaman kandidat (aset statis)
 *   GET  /api/session/{token}             -> web rekrutmen: ambil sesi
 *   POST /api/session/{token}/start       -> web rekrutmen: mulai
 *   POST /api/session/{token}/answer      -> web rekrutmen: autosave satu jawaban
 *   POST /api/session/{token}/submit      -> web rekrutmen: kirim
 *   PUT  /api/session/{token}/upload      unggah satu rekaman ke R2
 *
 * Browser kandidat hanya berbicara dengan Worker ini. Kunci X-Phone-Screening-Key
 * ditambahkan di sini dan tidak pernah dikirim ke browser.
 */
import { mockApi, mockState } from "./mock";
import type { Action, ApiResult, Env, Session } from "./types";

const TOKEN = /^[A-Za-z0-9_-]{4,128}$/;
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_JSON_BYTES = 64 * 1024;
const MB = 1024 * 1024;

/** Format rekaman yang diterima dan ekstensi berkasnya. */
const MIME_EXT: Record<string, string> = {
  "video/webm": "webm",
  "video/mp4": "mp4",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
};

/** Field yang boleh diteruskan ke web rekrutmen untuk tiap aksi. */
const FIELDS: Record<Exclude<Action, "session">, string[]> = {
  start: ["candidate_name", "candidate_contact", "consent", "device_info"],
  answer: [
    "question_id", "answer_text", "file_key", "file_mime", "file_size_bytes", "recording_seconds",
    "time_spent_seconds", "retake_count", "paste_count", "is_text_fallback",
  ],
  submit: ["total_duration_seconds", "device_info"],
};

const SERVICE_DOWN: ApiResult = {
  status: 502,
  body: { code: "service_unavailable", message: "Layanan sedang bermasalah. Mohon coba lagi beberapa saat lagi." },
};

const isMock = (env: Env) => env.MOCK_API === "1";

function json(result: ApiResult, env: Env): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (isMock(env)) headers["x-mock-api"] = "1";
  return new Response(JSON.stringify(result.body), { status: result.status, headers });
}

const fail = (status: number, message: string, code = "bad_request"): ApiResult => ({ status, body: { code, message } });

/** Memanggil web rekrutmen (atau tiruannya) dan mengembalikan status + JSON-nya. */
async function callApi(env: Env, action: Action, token: string, data: Record<string, unknown> = {}): Promise<ApiResult> {
  if (isMock(env)) return mockApi(action, token, data);

  const base = (env.RECRUITMENT_API_URL ?? "").trim().replace(/\/+$/, "");
  const key = env.PHONE_SCREENING_API_KEY ?? "";
  if (!/^https?:\/\//.test(base) || !key) {
    console.error("Konfigurasi belum lengkap: RECRUITMENT_API_URL atau PHONE_SCREENING_API_KEY kosong.");
    return SERVICE_DOWN;
  }

  const url = `${base}/api/phone-screening/session/${token}${action === "session" ? "" : `/${action}`}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: action === "session" ? "GET" : "POST",
      headers: {
        "X-Phone-Screening-Key": key,
        Accept: "application/json",
        ...(action === "session" ? {} : { "Content-Type": "application/json" }),
      },
      body: action === "session" ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Web rekrutmen tidak dapat dihubungi (${action})`, err);
    return SERVICE_DOWN;
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const isObject = typeof body === "object" && body !== null;
  const hasCode = isObject && "code" in (body as object);

  // Hanya jawaban yang dikenal kontrak yang diteruskan. 401 (kunci salah), 429, 5xx, atau
  // halaman non-JSON adalah masalah di sisi kita, bukan sesuatu yang perlu dilihat kandidat.
  if (res.status === 200 && isObject) return { status: 200, body };
  if ((res.status === 404 || res.status === 410) && hasCode) return { status: res.status, body };
  if ((res.status === 409 || res.status === 422) && isObject) return { status: res.status, body };

  console.error(`Jawaban tak terduga dari web rekrutmen (${action}): HTTP ${res.status}`);
  return SERVICE_DOWN;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_JSON_BYTES) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_JSON_BYTES) return null;
    const data: unknown = text ? JSON.parse(text) : {};
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pick(data: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (data[f] !== undefined) out[f] = data[f];
  return out;
}

/**
 * Unggah satu rekaman. Kunci objek ditentukan di sini, bukan oleh browser:
 * <upload_prefix><question_id>-<retake_count>.<ekstensi>
 */
async function upload(request: Request, env: Env, token: string, url: URL): Promise<ApiResult> {
  const questionId = Number(url.searchParams.get("question_id"));
  const retake = Number(url.searchParams.get("retake") ?? "0");
  if (!Number.isInteger(questionId) || !Number.isInteger(retake) || retake < 0 || retake > 50) {
    return fail(400, "Permintaan unggah tidak valid.");
  }

  const mime = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) return fail(415, "Format rekaman tidak didukung.", "unsupported_media");

  const size = Number(request.headers.get("content-length"));
  if (!Number.isInteger(size) || size <= 0 || !request.body) return fail(411, "Ukuran berkas tidak diketahui.");

  // Validasi token: sesi harus masih berlaku. Jawaban 404/410 diteruskan apa adanya.
  const result = await callApi(env, "session", token);
  if (result.status !== 200) return result;
  const session = result.body as Session;

  const question = session.questions.find((q) => q.id === questionId);
  if (!question || question.type !== "recording") return fail(422, "Pertanyaan ini tidak menerima rekaman.");
  if (!session.started) return fail(409, "Persetujuan perekaman belum diberikan.");
  if (retake > question.max_retakes) return fail(422, "Kesempatan merekam ulang sudah habis.");
  if (question.answer?.has_recording && retake <= question.answer.retake_count) {
    return fail(409, "Rekaman untuk percobaan ini sudah tersimpan.", "already_uploaded");
  }
  if (mime.startsWith("video/") && question.media !== "video") return fail(415, "Pertanyaan ini hanya menerima rekaman suara.", "unsupported_media");

  const cap = Math.max(1, Number(env.MAX_UPLOAD_MB) || 60);
  const limit = Math.min(cap, question.time_limit_minutes * 10 + 5) * MB;
  if (size > limit) return fail(413, "Ukuran rekaman terlalu besar. Mohon rekam ulang dengan durasi lebih singkat.", "too_large");

  const prefix = session.upload_prefix;
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\/$/.test(prefix)) {
    console.error("upload_prefix dari web rekrutmen tidak valid:", prefix);
    return SERVICE_DOWN;
  }
  const key = `${prefix}${questionId}-${retake}.${ext}`;
  if (!key.startsWith(prefix)) return SERVICE_DOWN;

  try {
    const object = await env.RECORDINGS.put(key, request.body, {
      httpMetadata: { contentType: mime },
      customMetadata: { question_id: String(questionId), retake_count: String(retake) },
    });
    if (object.size !== size) {
      await env.RECORDINGS.delete(key);
      return fail(400, "Unggahan terputus. Mencoba lagi.", "incomplete");
    }
  } catch (err) {
    console.error("Gagal menulis ke R2", err);
    return SERVICE_DOWN;
  }

  return { status: 200, body: { file_key: key, file_mime: mime, file_size_bytes: size } };
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  // Hanya halaman kandidat di domain ini yang boleh memanggil.
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json(fail(403, "Asal permintaan tidak diizinkan."), env);

  if (isMock(env)) {
    const peek = /^\/api\/_mock\/([^/]+)$/.exec(url.pathname);
    if (peek && request.method === "GET") {
      const list = await env.RECORDINGS.list({ prefix: "phone-screening/" });
      return json({
        status: 200,
        body: { state: mockState(peek[1]!), r2_objects: list.objects.map((o) => ({ key: o.key, size: o.size })) },
      }, env);
    }
  }

  const match = /^\/api\/session\/([^/]+)(?:\/(start|answer|submit|upload))?$/.exec(url.pathname);
  if (!match) return json(fail(404, "Tidak ditemukan.", "not_found"), env);
  const token = match[1]!;
  const action = match[2];
  if (!TOKEN.test(token)) return json({ status: 404, body: { code: "not_found", message: "Link tidak ditemukan." } }, env);

  if (!action) {
    if (request.method !== "GET") return json(fail(405, "Metode tidak diizinkan."), env);
    return json(await callApi(env, "session", token), env);
  }
  if (action === "upload") {
    if (request.method !== "PUT") return json(fail(405, "Metode tidak diizinkan."), env);
    return json(await upload(request, env, token, url), env);
  }
  if (request.method !== "POST") return json(fail(405, "Metode tidak diizinkan."), env);
  const data = await readJson(request);
  if (!data) return json(fail(400, "Data tidak valid."), env);
  const act = action as Exclude<Action, "session">;
  return json(await callApi(env, act, token, pick(data, FIELDS[act])), env);
}

/** Halaman kandidat: berdiri sendiri (tidak boleh di dalam iframe) dan token tidak bocor lewat Referer. */
async function page(request: Request, env: Env, url: URL): Promise<Response> {
  const asset = await env.ASSETS.fetch(new Request(new URL("/", url), { method: "GET", headers: request.headers }));
  const res = new Response(asset.body, asset);
  res.headers.set("cache-control", "no-store");
  res.headers.set("x-frame-options", "DENY");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("x-robots-tag", "noindex, nofollow");
  res.headers.set("permissions-policy", "camera=(self), microphone=(self), geolocation=()");
  res.headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  return res;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    if (url.pathname === "/" || url.pathname.startsWith("/s/")) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      return page(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
