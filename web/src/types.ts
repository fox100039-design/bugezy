export interface Report {
  report_id: string;
  url: string;
  title: string;
  browser: string;
  screen_size: string;
  consoleLogs: { level: string; message: string; timestamp: number }[];
  networkErrors: {
    method: string;
    url: string;
    status: number;
    responseBody?: string;
    timestamp: number;
    duration?: number;
  }[];
  voiceTranscript: { text: string; timestamp: number; isFinal: boolean }[];
  screenshots: { dataUrl: string; timestamp: number }[];
  description: string;
  rrwebEvents: unknown[];
  created_at: string;
}
