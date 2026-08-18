export interface SttAudio {
  audio: Uint8Array;
  mimeType: string;
  filename: string;
}

export interface SttStatus {
  available: boolean;
  reason?: string;
}

export interface SttProvider {
  readonly id: string;
  status(): Promise<SttStatus>;
  transcribe(input: SttAudio): Promise<{ text: string }>;
  close(): void;
}
