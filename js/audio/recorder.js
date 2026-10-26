// js/audio/recorder.js
//
// Owns: the mic (step 5c) — opening it, recording one take with
// MediaRecorder, and closing it again. No DOM and no storage: main.js
// decides when (the hold, the countdown) and stores the file. Unit-
// tested with a fake mic and MediaRecorder (tests/unit/recorder.test.js).
//
// The rules (PROJECT_NOTES.md, 5c):
//   - The mic is opened for each hold and closed after the take (or
//     when the hold is let go early): a stream kept open shows iOS's mic
//     dot and can switch its audio to call mode.
//   - Echo cancellation is off, so her voice sounds natural. Recording
//     over music needs headphones (main.js says so). Automatic gain is
//     asked for (her first takes were very quiet without it); Safari
//     may tie it to echo cancellation and ignore it — micSettings()
//     says what was applied, for the log. Takes are leveled afterwards
//     either way (clip.js takeGain).
//   - The file is MediaRecorder's default (AAC in MP4 on her iPad),
//     never re-encoded. `start` resolves with when recording began
//     (MediaRecorder's start event, on `now`'s clock), which main.js
//     uses to cut the lead-in before the first frame.

// What getUserMedia is asked for.
export const MIC_CONSTRAINTS = Object.freeze({
  audio: { echoCancellation: false, autoGainControl: true },
});

// What the browser actually applied to a stream from open(), for the
// log: { echo, agc, noise, rate } (missing ones are '?').
export function micSettings(stream) {
  const track = stream?.getAudioTracks?.()[0] ?? stream?.getTracks?.()[0];
  const settings = track?.getSettings?.() ?? {};
  const show = (v) => (typeof v === 'boolean' || typeof v === 'number' ? v : '?');
  return {
    echo: show(settings.echoCancellation),
    agc: show(settings.autoGainControl),
    noise: show(settings.noiseSuppression),
    rate: show(settings.sampleRate),
  };
}

// If MediaRecorder never fires `start`, carry on after this long.
export const START_EVENT_TIMEOUT_MS = 1000;

// Why the mic couldn't open: 'denied' (she said no, or it's blocked) |
// 'no-mic' | 'failed'.
export function micError(err) {
  const name = err?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no-mic';
  return 'failed';
}

export function createRecorder({
  mediaDevices = globalThis.navigator?.mediaDevices ?? null,
  MediaRecorderCtor = globalThis.MediaRecorder ?? null,
  now = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let take = null; // { recorder, stream, chunks, stopped: Promise<Blob|null> }

  function close(stream) {
    for (const track of stream?.getTracks?.() ?? []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
  }

  return {
    // Whether this browser can record at all (the mic button hides
    // otherwise).
    get supported() {
      return Boolean(mediaDevices?.getUserMedia && MediaRecorderCtor);
    },

    // Opens the mic. The first time, iOS asks her — that rejects with
    // a NotAllowedError if she says no (see micError).
    open() {
      if (!this.supported) return Promise.reject(Object.assign(new Error('Recording is not available'), { name: 'NotSupportedError' }));
      return mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    },

    // Closes a stream from open() that won't be recorded (the hold was
    // let go during the countdown).
    close,

    // Starts recording `stream`. Resolves with { startedAt } once the
    // recorder says it has started (or after START_EVENT_TIMEOUT_MS).
    start(stream) {
      if (take) return Promise.reject(new Error('Already recording'));
      const recorder = new MediaRecorderCtor(stream);
      const chunks = [];
      let resolveStopped;
      const stopped = new Promise((resolve) => { resolveStopped = resolve; });
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        close(stream);
        const type = recorder.mimeType || chunks[0]?.type || 'audio/mp4';
        resolveStopped(chunks.length > 0 ? new Blob(chunks, { type }) : null);
      };
      take = { recorder, stream, stopped, giveUp: () => { close(stream); resolveStopped(null); } };
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimer(timer);
          resolve({ startedAt: now() });
        };
        const timer = setTimer(finish, START_EVENT_TIMEOUT_MS);
        recorder.onstart = finish;
        recorder.onerror = (event) => {
          if (done) return;
          done = true;
          clearTimer(timer);
          take = null;
          close(stream);
          reject(event?.error ?? new Error('Recording failed'));
        };
        try {
          recorder.start();
        } catch (err) {
          done = true;
          clearTimer(timer);
          take = null;
          close(stream);
          reject(err);
        }
      });
    },

    // Stops the take. Resolves with its file (a Blob of the recorder's
    // type), or null if nothing was recorded. The mic is closed.
    stop() {
      const current = take;
      take = null;
      if (!current) return Promise.resolve(null);
      try {
        if (current.recorder.state !== 'inactive') current.recorder.stop();
        else current.giveUp(); // never started: no stop event will come
      } catch {
        current.giveUp();
      }
      return current.stopped;
    },

    get recording() {
      return take !== null;
    },
  };
}
