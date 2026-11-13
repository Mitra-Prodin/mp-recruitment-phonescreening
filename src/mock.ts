/**
 * Data tiruan untuk pengembangan lokal (MOCK_API=1), meniru perilaku
 * app/Http/Controllers/API/PhoneScreeningController.php: bentuk JSON, kode galat, dan validasinya.
 * Data hanya hidup di memori proses `wrangler dev` dan hilang saat server dihentikan.
 *
 * Token yang tersedia:
 *   singkat, singkat-<apa saja>   6 pertanyaan, semua tipe jawaban, boleh kembali
 *   demo, demo-<apa saja>         11 pertanyaan bawaan (Lampiran A BRD), tidak bisa kembali
 *   kaku, kaku-<apa saja>         seperti "singkat" tetapi tanpa jawaban ketik cadangan dan tanpa rekam ulang
 *   kedaluwarsa | terkirim | ditutup   link yang tidak dapat dipakai (410)
 *   token lain                    404
 */
import type { Action, ApiResult, Question, QuestionType, Session } from "./types";

interface MockAnswer {
  answer_text: string | null;
  file_key: string | null;
  file_mime: string | null;
  file_size_bytes: number | null;
  recording_seconds: number | null;
  retake_count: number;
  paste_count: number;
  is_text_fallback: boolean;
  time_spent_seconds: number;
}

interface MockInvitation {
  id: number;
  status: string;
  expired_at: Date;
  opened: boolean;
  started: boolean;
  consent: boolean;
  submitted: boolean;
  closed: boolean;
  candidate_name: string;
  candidate_contact: string;
  device_info: string | null;
  total_duration_seconds: number | null;
  interview: Session["interview"];
  questions: Omit<Question, "answer">[];
  answers: Map<number, MockAnswer>;
}

const store = new Map<string, MockInvitation>();
let nextId = 9001;

function q(
  id: number,
  type: QuestionType,
  question: string,
  extra: Partial<Omit<Question, "answer">> = {},
): Omit<Question, "answer"> {
  return {
    id,
    question,
    type,
    media: type === "recording" ? "video" : null,
    time_limit_minutes: type === "recording" ? 2 : 1,
    max_retakes: type === "recording" ? 2 : 0,
    is_required: true,
    help_text: null,
    options: [],
    scale_min_label: null,
    scale_max_label: null,
    ...extra,
  };
}

function shortSet(): Omit<Question, "answer">[] {
  return [
    q(101, "choice", "Apakah benar Anda melamar untuk posisi ini di PT Mitra Prodin?", { options: ["Ya", "Tidak"] }),
    q(102, "short_text", "Berapa ekspektasi gaji Anda per bulan (gross)?", {
      help_text: "Boleh ditulis sebagai rentang, contoh: Rp 5.500.000 – Rp 6.500.000.",
    }),
    q(103, "recording", "Apa yang membuat Anda tertarik melamar pada posisi ini?", { time_limit_minutes: 1 }),
    q(104, "recording", "Ceritakan singkat pengalaman kerja Anda yang paling relevan.", {
      media: "audio",
      time_limit_minutes: 1,
      max_retakes: 1,
    }),
    q(105, "scale", "Seberapa siap Anda bekerja dengan jadwal shift?", {
      scale_min_label: "Tidak siap",
      scale_max_label: "Sangat siap",
    }),
    q(106, "long_text", "Ada hal lain yang ingin Anda sampaikan atau tanyakan kepada kami?", {
      is_required: false,
      time_limit_minutes: 2,
      help_text: "Boleh dikosongkan.",
    }),
  ];
}

function defaultSet(): Omit<Question, "answer">[] {
  const rec = (id: number, text: string, required = true, help: string | null = null) =>
    q(id, "recording", text, { is_required: required, help_text: help });
  return [
    q(201, "choice", "Apakah benar Anda melamar untuk posisi ini di PT Mitra Prodin?", { options: ["Ya", "Tidak"] }),
    q(202, "choice", "Dari mana Anda mengetahui lowongan ini?", {
      options: ["JobStreet", "Instagram / media sosial", "Referensi teman atau karyawan", "Datang langsung / walk-in", "Lainnya"],
    }),
    q(203, "choice", "Status pekerjaan Anda saat ini?", {
      options: ["Masih bekerja", "Sudah resign", "Belum pernah bekerja / fresh graduate"],
    }),
    rec(204, "Apa saja tanggung jawab Anda pada pekerjaan saat ini atau sebelumnya?", true,
      "Belum pernah bekerja? Ceritakan pengalaman magang, organisasi, atau tugas akhir."),
    rec(205, "Apa yang membuat Anda ingin meninggalkan pekerjaan Anda?", false, "Lewati bila Anda belum pernah bekerja."),
    rec(206, "Apa yang membuat Anda tertarik melamar pada posisi ini?"),
    rec(207, "Apa saja pengalaman yang Anda miliki berkaitan dengan posisi ini?"),
    rec(208, "Bagaimana tipe lingkungan kerja yang Anda senangi?", true,
      "Misalnya jam kerja fleksibel atau tetap, bekerja dalam tim atau mandiri."),
    q(209, "choice", "Apabila kita cocok, berapa lama waktu yang Anda perlukan untuk bergabung?", {
      options: ["Bisa segera", "± 2 minggu", "± 1 bulan", "± 2 bulan", "Lebih dari 2 bulan"],
    }),
    q(210, "short_text", "Berapa ekspektasi gaji Anda per bulan (gross)?", {
      time_limit_minutes: 2,
      help_text: "Boleh ditulis sebagai rentang, contoh: Rp 5.500.000 – Rp 6.500.000.",
    }),
    q(211, "long_text", "Ada hal lain yang ingin Anda sampaikan atau tanyakan kepada kami?", {
      is_required: false,
      time_limit_minutes: 2,
      help_text: "Boleh dikosongkan.",
    }),
  ];
}

function create(token: string): MockInvitation | null {
  const kind = token.split("-")[0] ?? "";
  const days = (n: number) => new Date(Date.now() + n * 86_400_000);
  const base = {
    id: nextId++,
    status: "sent",
    expired_at: days(3),
    opened: false,
    started: false,
    consent: false,
    submitted: false,
    closed: false,
    candidate_name: "Dewi Kartika Sari",
    candidate_contact: "081234567890",
    device_info: null,
    total_duration_seconds: null,
    answers: new Map<number, MockAnswer>(),
  };
  const interview = (allowBack: boolean, fallback: boolean, questions: Omit<Question, "answer">[]) => ({
    company: "PT Mitra Prodin",
    position: "Staff Accounting",
    location: "Denpasar, Bali",
    interviewer: "Seizhar Hadi Putera",
    opening_text:
      "Terima kasih atas lamaran Anda. Ini adalah wawancara awal yang dilakukan secara online, sehingga Anda bisa mengerjakannya kapan saja sebelum tenggat. Jawab santai saja, seperti sedang ditelepon.",
    allow_back: allowBack,
    use_time_limit: true,
    track_paste: true,
    allow_text_fallback: fallback,
    estimated_minutes: questions.reduce((n, x) => n + x.time_limit_minutes, 0),
  });

  if (kind === "singkat") {
    const questions = shortSet();
    return { ...base, interview: interview(true, true, questions), questions };
  }
  if (kind === "kaku") {
    const questions = shortSet().map((x) => ({ ...x, max_retakes: 0 }));
    return { ...base, interview: interview(false, false, questions), questions };
  }
  if (kind === "demo") {
    const questions = defaultSet();
    return { ...base, interview: interview(false, true, questions), questions };
  }
  if (token === "kedaluwarsa" || token === "terkirim" || token === "ditutup") {
    const questions = shortSet();
    return {
      ...base,
      expired_at: token === "kedaluwarsa" ? days(-1) : days(3),
      submitted: token === "terkirim",
      closed: token === "ditutup",
      interview: interview(true, true, questions),
      questions,
    };
  }
  return null;
}

function find(token: string): MockInvitation | null {
  let inv = store.get(token) ?? null;
  if (!inv) {
    inv = create(token);
    if (inv) store.set(token, inv);
  }
  return inv;
}

function blocked(inv: MockInvitation | null): ApiResult | null {
  if (!inv) return { status: 404, body: { code: "not_found", message: "Link tidak ditemukan." } };
  if (inv.submitted) return { status: 410, body: { code: "submitted", message: "Jawaban untuk link ini sudah dikirim." } };
  if (inv.closed) return { status: 410, body: { code: "closed", message: "Link ini sudah tidak digunakan." } };
  if (inv.expired_at.getTime() < Date.now()) {
    inv.status = "expired";
    return {
      status: 410,
      body: { code: "expired", message: "Tenggat pengisian sudah lewat. Silakan hubungi recruiter Anda." },
    };
  }
  return null;
}

const prefixOf = (inv: MockInvitation) => `phone-screening/${inv.id}/`;

/** Galat validasi dengan bentuk yang sama seperti Laravel. */
function invalid(field: string, message: string): ApiResult {
  return { status: 422, body: { message, errors: { [field]: [message] } } };
}

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);

function session(inv: MockInvitation): ApiResult {
  if (!inv.opened) {
    inv.opened = true;
    if (inv.status === "created" || inv.status === "sent") inv.status = "opened";
  }
  const body: Session = {
    status: inv.status,
    expired_at: inv.expired_at.toISOString(),
    started: inv.started,
    upload_prefix: prefixOf(inv),
    candidate: { name: inv.candidate_name, contact: inv.candidate_contact },
    interview: inv.interview,
    questions: inv.questions.map((x) => {
      const a = inv.answers.get(x.id);
      return {
        ...x,
        answer: a
          ? {
              answer_text: a.answer_text,
              has_recording: Boolean(a.file_key),
              recording_seconds: a.recording_seconds,
              retake_count: a.retake_count,
              is_text_fallback: a.is_text_fallback,
              time_spent_seconds: a.time_spent_seconds,
            }
          : null,
      };
    }),
  };
  return { status: 200, body };
}

function start(inv: MockInvitation, data: Body): ApiResult {
  const name = str(data.candidate_name)?.trim();
  const contact = str(data.candidate_contact)?.trim();
  if (!name) return invalid("candidate_name", "The candidate name field is required.");
  if (name.length > 150) return invalid("candidate_name", "The candidate name field must not be greater than 150 characters.");
  if (!contact) return invalid("candidate_contact", "The candidate contact field is required.");
  if (contact.length > 150) return invalid("candidate_contact", "The candidate contact field must not be greater than 150 characters.");
  if (data.consent !== true) return invalid("consent", "The consent field must be accepted.");
  const device = str(data.device_info);
  if (device && device.length > 255) return invalid("device_info", "The device info field must not be greater than 255 characters.");

  inv.candidate_name = name;
  inv.candidate_contact = contact;
  inv.device_info = device ?? inv.device_info;
  inv.consent = true;
  inv.started = true;
  inv.status = "in_progress";
  return { status: 200, body: { status: inv.status } };
}

function answer(inv: MockInvitation, data: Body): ApiResult {
  if (!inv.consent) return { status: 409, body: { message: "Persetujuan perekaman belum diberikan." } };

  const questionId = int(data.question_id);
  if (questionId === null) return invalid("question_id", "The question id field is required.");
  const text = str(data.answer_text);
  if (text && text.length > 10000) return invalid("answer_text", "The answer text field must not be greater than 10000 characters.");
  const mime = str(data.file_mime);
  if (mime && mime.length > 50) return invalid("file_mime", "The file mime field must not be greater than 50 characters.");
  const seconds = int(data.recording_seconds);
  if (seconds !== null && (seconds < 0 || seconds > 3600)) return invalid("recording_seconds", "The recording seconds field must not be greater than 3600.");

  const question = inv.questions.find((x) => x.id === questionId);
  if (!question) return { status: 422, body: { message: "Pertanyaan tidak termasuk dalam sesi ini." } };

  const fileKey = str(data.file_key);
  if (fileKey && !fileKey.startsWith(prefixOf(inv))) return { status: 422, body: { message: "Lokasi berkas rekaman tidak valid." } };
  if (question.type === "choice" && text && !question.options.includes(text)) {
    return { status: 422, body: { message: "Pilihan jawaban tidak dikenal." } };
  }
  const isRecording = question.type === "recording";
  const retakes = int(data.retake_count) ?? 0;
  if (isRecording && retakes > question.max_retakes) return { status: 422, body: { message: "Kesempatan merekam ulang sudah habis." } };

  const prev = inv.answers.get(question.id);
  const next: MockAnswer = {
    answer_text: text,
    file_key: prev?.file_key ?? null,
    file_mime: prev?.file_mime ?? null,
    file_size_bytes: prev?.file_size_bytes ?? null,
    recording_seconds: prev?.recording_seconds ?? null,
    retake_count: retakes,
    paste_count: int(data.paste_count) ?? prev?.paste_count ?? 0,
    is_text_fallback: isRecording && data.is_text_fallback === true,
    time_spent_seconds: int(data.time_spent_seconds) ?? prev?.time_spent_seconds ?? 0,
  };
  if (isRecording && fileKey) {
    next.file_key = fileKey;
    next.file_mime = mime;
    next.file_size_bytes = int(data.file_size_bytes);
    next.recording_seconds = seconds;
  } else if (next.is_text_fallback) {
    next.file_key = next.file_mime = null;
    next.file_size_bytes = next.recording_seconds = null;
  }
  inv.answers.set(question.id, next);
  return { status: 200, body: { saved: true, question_id: question.id } };
}

function submit(inv: MockInvitation, data: Body): ApiResult {
  const missing: number[] = [];
  for (const question of inv.questions) {
    if (!question.is_required) continue;
    const a = inv.answers.get(question.id);
    const filled =
      a !== undefined &&
      (question.type === "recording" && !a.is_text_fallback ? Boolean(a.file_key) : (a.answer_text ?? "").trim().length > 0);
    if (!filled) missing.push(question.id);
  }
  if (missing.length) {
    return {
      status: 422,
      body: {
        message: "Masih ada pertanyaan wajib yang belum dijawab atau rekaman yang belum terunggah.",
        missing_question_ids: missing,
      },
    };
  }
  let sum = 0;
  for (const a of inv.answers.values()) sum += a.time_spent_seconds;
  inv.submitted = true;
  inv.status = "completed";
  inv.total_duration_seconds = int(data.total_duration_seconds) ?? sum;
  inv.device_info = str(data.device_info) ?? inv.device_info;
  return { status: 200, body: { status: inv.status } };
}

export function mockApi(action: Action, token: string, data: Body): ApiResult {
  const inv = find(token);
  const stop = blocked(inv);
  if (stop || !inv) return stop ?? { status: 404, body: { code: "not_found", message: "Link tidak ditemukan." } };
  switch (action) {
    case "session":
      return session(inv);
    case "start":
      return start(inv, data);
    case "answer":
      return answer(inv, data);
    case "submit":
      return submit(inv, data);
  }
}

/** Isi tersimpan sebuah undangan tiruan, untuk diperiksa saat pengembangan. */
export function mockState(token: string): unknown {
  const inv = store.get(token);
  if (!inv) return null;
  return { ...inv, answers: Object.fromEntries(inv.answers) };
}
