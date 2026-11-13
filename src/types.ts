/** Bentuk data sesuai docs/phone-screening-api.md di web rekrutmen. */

export interface Env {
  ASSETS: Fetcher;
  RECORDINGS: R2Bucket;
  RECRUITMENT_API_URL?: string;
  PHONE_SCREENING_API_KEY?: string;
  MOCK_API?: string;
  MAX_UPLOAD_MB?: string;
}

export type QuestionType = "short_text" | "long_text" | "choice" | "scale" | "recording";

export interface SavedAnswer {
  answer_text: string | null;
  has_recording: boolean;
  recording_seconds: number | null;
  retake_count: number;
  is_text_fallback: boolean;
  time_spent_seconds: number;
}

export interface Question {
  id: number;
  question: string;
  type: QuestionType;
  media: "audio" | "video" | null;
  time_limit_minutes: number;
  max_retakes: number;
  is_required: boolean;
  help_text: string | null;
  options: string[];
  scale_min_label: string | null;
  scale_max_label: string | null;
  answer: SavedAnswer | null;
}

export interface Session {
  status: string;
  expired_at: string;
  started: boolean;
  upload_prefix: string;
  candidate: { name: string | null; contact: string | null };
  interview: {
    company: string;
    position: string | null;
    location: string | null;
    interviewer: string | null;
    opening_text: string | null;
    allow_back: boolean;
    use_time_limit: boolean;
    track_paste: boolean;
    allow_text_fallback: boolean;
    estimated_minutes: number;
  };
  questions: Question[];
}

/** Jawaban dari web rekrutmen (atau tiruannya) yang diteruskan apa adanya ke browser. */
export interface ApiResult {
  status: number;
  body: unknown;
}

export type Action = "session" | "start" | "answer" | "submit";
