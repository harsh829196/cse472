// ProctorLite browser monitor: face/gaze/absence (MediaPipe) + tab/focus events.
// All video processing stays in the browser. Only event records are sent.
import { FaceLandmarker, FilesetResolver } from
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

// ---- Tunable thresholds (document and justify these in your report) -------
const CFG = {
  MULTI_FACE_SEC: 2,     // >1 face for this long -> MULTIPLE_FACES
  NO_FACE_SEC: 3,        // 0 faces for this long -> NO_FACE
  YAW_LOW: 0.30,         // nose position ratio between cheeks (0.5 = centered)
  YAW_HIGH: 0.70,
  PITCH_LOW: 0.30,       // TODO calibrate: nose between eye line and chin
  PITCH_HIGH: 0.62,
  HEAD_TURN_SEC: 2,
  GAZE_LOW: 0.35,        // iris position within eye (0.5 = centered)
  GAZE_HIGH: 0.65,
  GAZE_AWAY_SEC: 2,
  COOLDOWN_SEC: 5,       // min gap between events of the same type
};

// ---- Event queue ----------------------------------------------------------
const queue = [];
const lastFired = {};
function logEvent(type, duration = 0, details = "") {
  const now = Date.now() / 1000;
  if (lastFired[type] && now - lastFired[type] < CFG.COOLDOWN_SEC) return;
  lastFired[type] = now;
  queue.push({ ts: now, event_type: type, duration, details });
}
async function flush() {
  if (!queue.length) return;
  const batch = queue.splice(0);
  try {
    await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
  } catch (e) { queue.unshift(...batch); }  // retry next tick
}
setInterval(flush, 3000);

// ---- Application-level monitoring ----------------------------------------
document.addEventListener("visibilitychange", () => {
  if (document.hidden) logEvent("TAB_SWITCH");
});
window.addEventListener("blur", () => logEvent("FOCUS_LOSS"));
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) logEvent("FULLSCREEN_EXIT");
});
["copy", "paste", "cut", "contextmenu"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    logEvent("CLIPBOARD_ATTEMPT", 0, ev);
  })
);
document.getElementById("fs-btn").onclick = () =>
  document.documentElement.requestFullscreen?.();

// ---- Timer + submit -------------------------------------------------------
let endAt = Date.now() + EXAM_MINUTES * 60 * 1000;
const timerEl = document.getElementById("timer");
async function finish() {
  await flush();
  await fetch("/api/end", { method: "POST" });
  window.location = "/done";
}
setInterval(() => {
  const left = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  timerEl.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  if (left === 0) finish();
}, 500);
document.getElementById("exam-form").addEventListener("submit", (e) => {
  e.preventDefault();
  finish();
});

// ---- Condition tracker: fires once a condition lasts long enough ----------
class Sustained {
  constructor(type, minSec) { this.type = type; this.minSec = minSec; this.start = null; this.fired = false; }
  update(active, details = "") {
    const now = Date.now() / 1000;
    if (active) {
      if (this.start === null) this.start = now;
      if (!this.fired && now - this.start >= this.minSec) {
        this.fired = true;
        logEvent(this.type, now - this.start, details);
      }
    } else {
      this.start = null;
      this.fired = false;
    }
  }
}
const multiFace = new Sustained("MULTIPLE_FACES", CFG.MULTI_FACE_SEC);
const noFace = new Sustained("NO_FACE", CFG.NO_FACE_SEC);
const headTurn = new Sustained("HEAD_TURN", CFG.HEAD_TURN_SEC);
const gazeAway = new Sustained("GAZE_AWAY", CFG.GAZE_AWAY_SEC);

// ---- Landmark geometry ----------------------------------------------------
const ratio = (v, a, b) => (v - a) / (b - a || 1e-6);

function headPose(lm) {
  const nose = lm[1], leftCheek = lm[234], rightCheek = lm[454];
  const eyeY = (lm[33].y + lm[263].y) / 2, chin = lm[152];
  return {
    yaw: ratio(nose.x, leftCheek.x, rightCheek.x),   // 0.5 centered
    pitch: ratio(nose.y, eyeY, chin.y),
  };
}

function gazeRatio(lm) {
  // Needs iris landmarks (468-477), included in the face_landmarker model.
  if (lm.length < 478) return null;
  const l = ratio(lm[468].x, lm[33].x, lm[133].x);
  const r = ratio(lm[473].x, lm[362].x, lm[263].x);
  return (l + r) / 2;
}

// ---- Main CV loop ---------------------------------------------------------
const video = document.getElementById("cam");
const statusEl = document.getElementById("cv-status");

async function start() {
  let landmarker;
  try {
    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      },
      runningMode: "VIDEO",
      numFaces: 3,
    });
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: true });
    await video.play();
  } catch (err) {
    statusEl.textContent = "camera/model unavailable";
    logEvent("CAMERA_ERROR", 0, String(err).slice(0, 100));
    return;
  }
  statusEl.textContent = "camera ready";

  function tick() {
    if (video.readyState >= 2) {
      const res = landmarker.detectForVideo(video, performance.now());
      const faces = res.faceLandmarks || [];
      multiFace.update(faces.length > 1, `${faces.length} faces`);
      noFace.update(faces.length === 0);

      if (faces.length >= 1) {
        const { yaw, pitch } = headPose(faces[0]);
        headTurn.update(
          yaw < CFG.YAW_LOW || yaw > CFG.YAW_HIGH ||
          pitch < CFG.PITCH_LOW || pitch > CFG.PITCH_HIGH,
          `yaw=${yaw.toFixed(2)} pitch=${pitch.toFixed(2)}`);
        const g = gazeRatio(faces[0]);
        gazeAway.update(g !== null && (g < CFG.GAZE_LOW || g > CFG.GAZE_HIGH),
          g !== null ? `gaze=${g.toFixed(2)}` : "");
      } else {
        headTurn.update(false);
        gazeAway.update(false);
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
start();
