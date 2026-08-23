// A MediaRecorder jsdom does not have.
//
// jsdom ships no `MediaRecorder`, no `navigator.mediaDevices` and no `isSecureContext` — which is
// three of the exact conditions the record button gates on, so a test cannot even ask the question
// without standing them up. This is the smallest fake that answers the parts hooks/use-stt-recorder.ts
// actually uses: a state machine, `isTypeSupported`, and the three events it listens for.
//
// Deliberately manual. The recorder is driven from the test (`emit` a chunk, `finish` the clip), so a
// case can put a byte count or an error exactly where it wants one, and no timer decides when audio
// exists.

/** The `dataavailable` event's shape. jsdom has no `BlobEvent`, so this is it. */
class FakeBlobEvent extends Event {
  readonly data: Blob;
  constructor(type: string, data: Blob) {
    super(type);
    this.data = data;
  }
}

interface FakeTrack {
  stop: () => void;
}

/** What {@link installFakeMediaRecorder} hands back — a named owner contract, not an inline shape. */
export interface FakeMicrophone {
  /** Every track `getUserMedia` handed out, so a case can assert the microphone was released. */
  tracks: FakeTrack[];
}

export class FakeMediaRecorder extends EventTarget {
  /** Every recorder constructed since the last {@link installFakeMediaRecorder}. */
  static instances: FakeMediaRecorder[] = [];
  /** Containers this fake browser claims. Overwrite in a case that needs a different answer. */
  static supported: readonly string[] = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.includes(type);
  }

  state: "inactive" | "recording" | "paused" = "inactive";
  readonly mimeType: string;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }

  /** Hand the hook one chunk of audio, as the browser would on its timeslice. */
  emit(bytes: number): void {
    this.dispatchEvent(new FakeBlobEvent("dataavailable", new Blob([new Uint8Array(bytes)])));
  }

  /** One chunk, then the stop event — the whole life of a clip in one call. */
  finish(bytes = 1024): void {
    this.emit(bytes);
    this.stop();
  }
}

/**
 * Put a microphone on this jsdom: a secure context, a `getUserMedia` that answers, and the recorder
 * above. Returns the tracks it handed out so a case can assert the microphone was released.
 */
export function installFakeMediaRecorder(): FakeMicrophone {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supported = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  const tracks: FakeTrack[] = [];
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    writable: true,
    value: FakeMediaRecorder,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => {
        const track: FakeTrack = { stop: () => {} };
        tracks.push(track);
        return Promise.resolve({ getTracks: () => [track] });
      },
    },
  });
  return { tracks };
}

/** Take it away again — an insecure origin, which is the "no button at all" case. */
export function uninstallFakeMediaRecorder(): void {
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: false });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  Reflect.deleteProperty(globalThis, "MediaRecorder");
  FakeMediaRecorder.instances = [];
}
