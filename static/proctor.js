// ProctorGuard AI - Real-time Browser Proctoring & Integrity Engine
// Features: MediaPipe FaceLandmarker, Head Movement Detection, Gaze Tracking,
// Window Sliding / Resizing / Blur Monitoring, Audio-Visual Warning System (5 Strikes),
// and Real-time Futuristic Canvas HUD Overlay.

import { FaceLandmarker, FilesetResolver } from
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

// ---- Configuration Thresholds & Limits ------------------------------------
const CFG = {
  MAX_WARNINGS: 5,
  MULTI_FACE_SEC: 1.6,       // Multiple faces sustained duration
  NO_FACE_SEC: 2.2,          // Face absence sustained duration
  YAW_LOW: 0.28,             // Looking significantly left
  YAW_HIGH: 0.72,            // Looking significantly right
  PITCH_LOW: 0.26,           // Looking up
  PITCH_HIGH: 0.65,          // Looking DOWN (cheating: phone, lap, notes)
  HEAD_TURN_SEC: 1.8,        // Sustained abnormal head orientation
  GAZE_LOW: 0.32,            // Iris left
  GAZE_HIGH: 0.68,           // Iris right
  GAZE_AWAY_SEC: 2.0,        // Sustained sideways gaze
  WARNING_COOLDOWN_SEC: 3.5, // Min gap between consecutive warning strikes
  EVENT_COOLDOWN_SEC: 3.0,   // Min gap between general telemetry events
};

// ---- State Management -----------------------------------------------------
let warningsCount = 0;
const warningHistory = [];
const eventQueue = [];
const lastEventFired = {};
let lastWarningTime = 0;
let isExamTerminated = false;
let audioCtx = null;

// Initial window dimensions to track sliding/resizing/split-screen
let baseInnerWidth = window.innerWidth;
let baseInnerHeight = window.innerHeight;

// ---- Web Audio API Synthesizer (Zero External Dependencies) ---------------
function getAudioContext() {
  if (!audioCtx) {
    const AudiocontextClass = window.AudioContext || window.webkitAudioContext;
    if (AudiocontextClass) {
      audioCtx = new AudiocontextClass();
    }
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

function playTone(freq, duration, type = "sine", delay = 0) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    setTimeout(() => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    }, delay * 1000);
  } catch (e) {
    console.warn("Audio alert failed:", e);
  }
}

function playWarningSound() {
  // High-pitch urgent double-beep
  playTone(880, 0.15, "triangle", 0);
  playTone(660, 0.25, "triangle", 0.18);
}

function playCriticalTerminationSound() {
  // Urgent descending alarm tones
  playTone(520, 0.25, "sawtooth", 0);
  playTone(390, 0.25, "sawtooth", 0.25);
  playTone(260, 0.50, "sawtooth", 0.50);
}

// Unlock audio on any initial interaction
["click", "keydown", "touchstart"].forEach((evt) => {
  window.addEventListener(evt, () => getAudioContext(), { once: true });
});

// ---- Event Queue & Server Sync --------------------------------------------
function logEvent(type, duration = 0, details = "") {
  const now = Date.now() / 1000;
  if (lastEventFired[type] && now - lastEventFired[type] < CFG.EVENT_COOLDOWN_SEC) {
    return;
  }
  lastEventFired[type] = now;
  eventQueue.push({ ts: now, event_type: type, duration, details });
}

async function flushEvents() {
  if (!eventQueue.length) return;
  const batch = eventQueue.splice(0);
  try {
    await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
  } catch (err) {
    // Re-queue on network error
    eventQueue.unshift(...batch);
  }
}
setInterval(flushEvents, 3000);

// ---- Core Warning System (5 Strikes Rule) ---------------------------------
const warningModal = document.getElementById("warning-modal");
const warningTitle = document.getElementById("warning-modal-title");
const warningDesc = document.getElementById("warning-modal-desc");
const warningStrikeText = document.getElementById("warning-strike-text");
const warningDismissBtn = document.getElementById("warning-dismiss-btn");
const warningHistoryList = document.getElementById("strike-history-list");
const strikeBadges = document.querySelectorAll(".strike-indicator");
const warningSummaryBar = document.getElementById("warning-summary-text");
let warningModalTimeout = null;

function updateStrikeUI() {
  strikeBadges.forEach((badge, idx) => {
    if (idx < warningsCount) {
      badge.classList.add("strike-active");
      badge.innerHTML = `<span class="strike-dot active">⚠️ ${idx + 1}</span>`;
    } else {
      badge.classList.remove("strike-active");
      badge.innerHTML = `<span class="strike-dot">${idx + 1}</span>`;
    }
  });

  if (warningSummaryBar) {
    warningSummaryBar.textContent = `${warningsCount} / ${CFG.MAX_WARNINGS} Warnings`;
    if (warningsCount >= 4) {
      warningSummaryBar.className = "warning-badge badge-critical";
    } else if (warningsCount >= 1) {
      warningSummaryBar.className = "warning-badge badge-elevated";
    } else {
      warningSummaryBar.className = "warning-badge badge-clean";
    }
  }

  // Update HUD status text
  const proctorStatus = document.getElementById("proctor-status-pill");
  if (proctorStatus) {
    if (warningsCount >= CFG.MAX_WARNINGS) {
      proctorStatus.className = "status-pill status-danger";
      proctorStatus.innerHTML = `<span class="pulse-dot red"></span> EXAM TERMINATED`;
    } else if (warningsCount >= 3) {
      proctorStatus.className = "status-pill status-danger";
      proctorStatus.innerHTML = `<span class="pulse-dot red"></span> HIGH RISK (${warningsCount}/${CFG.MAX_WARNINGS})`;
    } else if (warningsCount >= 1) {
      proctorStatus.className = "status-pill status-warning";
      proctorStatus.innerHTML = `<span class="pulse-dot amber"></span> WARNING (${warningsCount}/${CFG.MAX_WARNINGS})`;
    } else {
      proctorStatus.className = "status-pill status-ok";
      proctorStatus.innerHTML = `<span class="pulse-dot green"></span> MONITORING ACTIVE`;
    }
  }
}

function triggerWarning(category, reason, details = "") {
  if (isExamTerminated) return;

  const now = Date.now() / 1000;
  // Enforce cooldown so multiple detections in 1 second count as one strike
  if (now - lastWarningTime < CFG.WARNING_COOLDOWN_SEC) {
    logEvent(category, 0, `Suppressed by cooldown: ${details}`);
    return;
  }
  lastWarningTime = now;

  warningsCount += 1;
  const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  warningHistory.push({ strike: warningsCount, category, reason, details, time: timeStr });

  // Log to server as a WARNING_STRIKE event
  logEvent("WARNING_STRIKE", 0, `[Strike ${warningsCount}/${CFG.MAX_WARNINGS}] ${category}: ${reason} - ${details}`);
  logEvent(category, 0, details);

  // Play audio alert
  playWarningSound();

  // Screen flash animation
  document.body.classList.add("screen-flash-warning");
  setTimeout(() => document.body.classList.remove("screen-flash-warning"), 900);

  // Add to strike history in sidebar
  if (warningHistoryList) {
    const emptyNotice = warningHistoryList.querySelector(".empty-strikes");
    if (emptyNotice) emptyNotice.remove();
    const li = document.createElement("li");
    li.className = "strike-item";
    li.innerHTML = `
      <div class="strike-header">
        <span class="strike-tag">Warning #${warningsCount}</span>
        <span class="strike-time">${timeStr}</span>
      </div>
      <div class="strike-reason">${reason}</div>
    `;
    warningHistoryList.prepend(li);
  }

  updateStrikeUI();

  // Display Warning Popup Modal
  if (warningModal) {
    warningTitle.textContent = `INTEGRITY WARNING [Strike ${warningsCount} of ${CFG.MAX_WARNINGS}]`;
    warningStrikeText.textContent = `${warningsCount} / ${CFG.MAX_WARNINGS} STRIKES`;
    warningDesc.innerHTML = `<strong>${reason}</strong><br><span class="desc-sub">${details}</span><br><br><span class="warning-policy">Policy reminder: Reaching 5 warnings will cause your test to be <strong>immediately and automatically submitted</strong>.</span>`;
    warningModal.classList.add("modal-active");

    clearTimeout(warningModalTimeout);
    // Auto-dismiss after 4.5 seconds if not terminated
    if (warningsCount < CFG.MAX_WARNINGS) {
      warningModalTimeout = setTimeout(() => {
        warningModal.classList.remove("modal-active");
      }, 4500);
    }
  }

  // Check if threshold exceeded (5 warnings reached)
  if (warningsCount >= CFG.MAX_WARNINGS) {
    executeAutoSubmission(`Auto-submitted: Exceeded maximum 5 warnings (${category}: ${reason})`);
  }
}

if (warningDismissBtn) {
  warningDismissBtn.addEventListener("click", () => {
    if (warningModal && warningsCount < CFG.MAX_WARNINGS) {
      warningModal.classList.remove("modal-active");
    }
  });
}

// ---- Automatic Exam Submission Handler ------------------------------------
async function executeAutoSubmission(reason = "Auto-submitted: Exceeded 5 integrity warnings") {
  if (isExamTerminated) return;
  isExamTerminated = true;

  playCriticalTerminationSound();
  logEvent("AUTO_SUBMIT_VIOLATIONS", 0, reason);

  // Show full-screen emergency lockdown screen
  const lockdownEl = document.getElementById("termination-lockdown");
  if (lockdownEl) {
    lockdownEl.classList.add("active");
  }

  // Gather current selected answers
  const form = document.getElementById("exam-form");
  const answers = {};
  if (form) {
    const formData = new FormData(form);
    for (const [key, value] of formData.entries()) {
      answers[key] = value;
    }
  }

  // Final flush to database
  await flushEvents();
  try {
    await fetch("/api/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: reason,
        warnings: warningsCount,
        answers: answers,
      }),
    });
  } catch (e) {
    console.error("End exam POST failed:", e);
  }

  setTimeout(() => {
    window.location.href = `/done?reason=warnings_exceeded&strikes=${warningsCount}`;
  }, 1800);
}

// Normal student submission
async function submitNormalExam() {
  if (isExamTerminated) return;
  isExamTerminated = true;

  const form = document.getElementById("exam-form");
  const answers = {};
  if (form) {
    const formData = new FormData(form);
    for (const [key, value] of formData.entries()) {
      answers[key] = value;
    }
  }

  await flushEvents();
  try {
    await fetch("/api/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "Completed normally by student",
        warnings: warningsCount,
        answers: answers,
      }),
    });
  } catch (e) {
    console.error("Submission failed:", e);
  }
  window.location.href = "/done";
}

// ---- Application & Window Activity Tracking (Sliding / Blur / Tab) -------
// 1. Sliding / Resizing / Split-Screen Detection
let resizeDebounceTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(() => {
    const currentW = window.innerWidth;
    const currentH = window.innerHeight;
    const widthChange = Math.abs(currentW - baseInnerWidth) / baseInnerWidth;
    const heightChange = Math.abs(currentH - baseInnerHeight) / baseInnerHeight;

    // If candidate slid window to side (e.g. split screen) or shrank it by >18%
    if (widthChange > 0.18 || heightChange > 0.18 || currentW < 800) {
      triggerWarning(
        "WINDOW_SLIDE",
        "Window Slid or Resized (Split-screen suspected)",
        `Window dimensions changed: ${currentW}x${currentH} (Started: ${baseInnerWidth}x${baseInnerHeight})`
      );
    }
  }, 600);
});

// 2. Tab Switching & Browser Minimizing
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    triggerWarning(
      "TAB_SWITCH",
      "Tab Switched or Browser Minimized",
      "Candidate switched away from the active exam tab."
    );
  }
});

// 3. Window Blur (Lost focus / Clicked another window / Sliding app on top)
window.addEventListener("blur", () => {
  triggerWarning(
    "FOCUS_LOSS",
    "Window Focus Lost",
    "Window lost focus. Candidate clicked another application or window."
  );
});

// 4. Exiting Fullscreen Mode
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) {
    triggerWarning(
      "FULLSCREEN_EXIT",
      "Exited Fullscreen Exam Mode",
      "Fullscreen mode was exited during examination."
    );
  }
});

// 5. Clipboard and Context Menu Protection
["copy", "paste", "cut", "contextmenu"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    logEvent("CLIPBOARD_ATTEMPT", 0, `Blocked ${ev} attempt`);
  })
);

// Fullscreen toggle button
const fsBtn = document.getElementById("fs-btn");
if (fsBtn) {
  fsBtn.onclick = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch((err) => {
        console.warn("Fullscreen request error:", err);
      });
    } else {
      document.exitFullscreen?.();
    }
  };
}

// ---- Exam Timer & Form Controls -------------------------------------------
const timerEl = document.getElementById("timer");
let examMinutes = typeof EXAM_MINUTES !== "undefined" ? EXAM_MINUTES : 10;
let endAt = Date.now() + examMinutes * 60 * 1000;

setInterval(() => {
  if (isExamTerminated) return;
  const left = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, "0");
  if (timerEl) {
    timerEl.textContent = `${m}:${s}`;
    if (left < 120) {
      timerEl.classList.add("timer-urgent");
    }
  }
  if (left === 0) {
    executeAutoSubmission("Exam time expired");
  }
}, 500);

const examForm = document.getElementById("exam-form");
if (examForm) {
  examForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (confirm("Are you sure you want to finalize and submit your exam?")) {
      submitNormalExam();
    }
  });
}

// Question navigation & progress tracker
const questionCards = document.querySelectorAll(".question-block");
const navPills = document.querySelectorAll(".q-nav-pill");
const progressFill = document.getElementById("exam-progress-fill");
const answeredCountEl = document.getElementById("answered-count");

function updateExamProgress() {
  let answered = 0;
  questionCards.forEach((card, index) => {
    const radio = card.querySelector("input[type=radio]:checked");
    const pill = navPills[index];
    if (radio) {
      answered++;
      if (pill) pill.classList.add("answered");
    } else {
      if (pill) pill.classList.remove("answered");
    }
  });
  if (answeredCountEl) answeredCountEl.textContent = answered;
  if (progressFill) progressFill.style.width = `${(answered / questionCards.length) * 100}%`;
}

document.querySelectorAll("input[type=radio]").forEach((input) => {
  input.addEventListener("change", updateExamProgress);
});
updateExamProgress();

// Question pagination pills
navPills.forEach((pill) => {
  pill.addEventListener("click", () => {
    const targetId = pill.dataset.target;
    const targetCard = document.getElementById(targetId);
    if (targetCard) {
      targetCard.scrollIntoView({ behavior: "smooth", block: "center" });
      navPills.forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
    }
  });
});

// ---- Sustained Condition Tracker ------------------------------------------
class SustainedDetector {
  constructor(category, minSec, onTrigger) {
    this.category = category;
    this.minSec = minSec;
    this.onTrigger = onTrigger;
    this.start = null;
    this.triggered = false;
  }

  update(active, reason, details = "") {
    const now = Date.now() / 1000;
    if (active) {
      if (this.start === null) this.start = now;
      const duration = now - this.start;
      if (!this.triggered && duration >= this.minSec) {
        this.triggered = true;
        this.onTrigger(this.category, reason, details);
      }
    } else {
      this.start = null;
      this.triggered = false;
    }
  }
}

// Sustained condition detectors
const multiFaceDetector = new SustainedDetector("MULTIPLE_FACES", CFG.MULTI_FACE_SEC, triggerWarning);
const noFaceDetector = new SustainedDetector("NO_FACE", CFG.NO_FACE_SEC, triggerWarning);
const headTurnDetector = new SustainedDetector("HEAD_TURN", CFG.HEAD_TURN_SEC, triggerWarning);
const headPitchDetector = new SustainedDetector("HEAD_PITCH", CFG.HEAD_TURN_SEC, triggerWarning);
const gazeDetector = new SustainedDetector("GAZE_AWAY", CFG.GAZE_AWAY_SEC, triggerWarning);

// ---- Geometry & Pose Estimation Helpers -----------------------------------
const ratio = (v, a, b) => (v - a) / (b - a || 1e-6);

function calculateHeadPose(lm) {
  // lm[1]: Nose tip, lm[234]: Left cheek, lm[454]: Right cheek
  // lm[33]: Left eye inner, lm[263]: Right eye inner, lm[152]: Chin
  const nose = lm[1];
  const leftCheek = lm[234];
  const rightCheek = lm[454];
  const eyeMidY = (lm[33].y + lm[263].y) / 2;
  const chin = lm[152];

  const yaw = ratio(nose.x, leftCheek.x, rightCheek.x); // 0.5 is centered
  const pitch = ratio(nose.y, eyeMidY, chin.y);         // ~0.45 is centered

  return { yaw, pitch, nose, leftCheek, rightCheek, chin, eyeMidY };
}

function calculateGaze(lm) {
  if (lm.length < 478) return null;
  // Iris landmarks: 468 (left iris center), 473 (right iris center)
  const l = ratio(lm[468].x, lm[33].x, lm[133].x);
  const r = ratio(lm[473].x, lm[362].x, lm[263].x);
  return (l + r) / 2;
}

// ---- Canvas HUD Overlay Renderer ------------------------------------------
const canvas = document.getElementById("cam-overlay");
const ctx = canvas ? canvas.getContext("2d") : null;

function drawHUD(faces, pose, gazeStatus, violationState) {
  if (!ctx || !canvas) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // If no face
  if (!faces || faces.length === 0) {
    ctx.fillStyle = "rgba(239, 68, 68, 0.85)";
    ctx.font = "bold 13px system-ui";
    ctx.fillText("⚠️ NO CANDIDATE DETECTED", 14, 26);
    return;
  }

  // If multiple faces
  if (faces.length > 1) {
    ctx.fillStyle = "rgba(239, 68, 68, 0.9)";
    ctx.font = "bold 13px system-ui";
    ctx.fillText(`🚨 MULTIPLE FACES (${faces.length})`, 14, 26);
  }

  // Draw HUD bounding box & corner brackets around primary face
  const lm = faces[0];
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (let i = 0; i < lm.length; i += 8) {
    const pt = lm[i];
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  // Add padding
  const padX = (maxX - minX) * 0.15;
  const padY = (maxY - minY) * 0.15;
  const bx = Math.max(0, (minX - padX) * w);
  const by = Math.max(0, (minY - padY) * h);
  const bw = Math.min(w - bx, (maxX - minX + padX * 2) * w);
  const bh = Math.min(h - by, (maxY - minY + padY * 2) * h);

  const bracketColor = violationState ? "#ef4444" : "#10b981";
  ctx.strokeStyle = bracketColor;
  ctx.lineWidth = 2.5;

  // Modern cyber reticle brackets
  const cornerLen = 14;
  // Top-left
  ctx.beginPath();
  ctx.moveTo(bx, by + cornerLen);
  ctx.lineTo(bx, by);
  ctx.lineTo(bx + cornerLen, by);
  ctx.stroke();

  // Top-right
  ctx.beginPath();
  ctx.moveTo(bx + bw - cornerLen, by);
  ctx.lineTo(bx + bw, by);
  ctx.lineTo(bx + bw, by + cornerLen);
  ctx.stroke();

  // Bottom-left
  ctx.beginPath();
  ctx.moveTo(bx, by + bh - cornerLen);
  ctx.lineTo(bx, by + bh);
  ctx.lineTo(bx + cornerLen, by + bh);
  ctx.stroke();

  // Bottom-right
  ctx.beginPath();
  ctx.moveTo(bx + bw - cornerLen, by + bh);
  ctx.lineTo(bx + bw, by + bh);
  ctx.lineTo(bx + bw, by + bh - cornerLen);
  ctx.stroke();

  // Target label
  ctx.fillStyle = bracketColor;
  ctx.font = "bold 10px monospace";
  const hudLabel = violationState ? "⚠️ INTEGRITY ALERT" : "● TARGET LOCKED [OK]";
  ctx.fillText(hudLabel, bx + 4, by - 6);

  // Nose crosshair
  if (pose && pose.nose) {
    const nx = pose.nose.x * w;
    const ny = pose.nose.y * h;
    ctx.strokeStyle = violationState ? "rgba(239, 68, 68, 0.7)" : "rgba(16, 185, 129, 0.6)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(nx - 6, ny);
    ctx.lineTo(nx + 6, ny);
    ctx.moveTo(nx, ny - 6);
    ctx.lineTo(nx, ny + 6);
    ctx.stroke();
  }
}

// ---- Main Computer Vision & Proctor Loop ----------------------------------
const video = document.getElementById("cam");
const statusEl = document.getElementById("cv-status");
const telemetryYaw = document.getElementById("tel-yaw");
const telemetryPitch = document.getElementById("tel-pitch");
const telemetryGaze = document.getElementById("tel-gaze");
const telemetryFaces = document.getElementById("tel-faces");

async function initProctoring() {
  let landmarker;
  try {
    if (statusEl) statusEl.textContent = "Loading MediaPipe AI Vision...";
    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      },
      runningMode: "VIDEO",
      numFaces: 3,
    });

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    // Match canvas dimensions to video
    if (canvas) {
      canvas.width = video.videoWidth || 320;
      canvas.height = video.videoHeight || 240;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = "Camera / AI Vision Offline";
    logEvent("CAMERA_ERROR", 0, String(err).slice(0, 150));
    console.error("Proctoring initialization failed:", err);
    return;
  }

  if (statusEl) statusEl.textContent = "AI Vision Active";
  updateStrikeUI();

  // Animation frame loop
  function tick() {
    if (isExamTerminated) return;

    if (video.readyState >= 2) {
      if (canvas && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      const res = landmarker.detectForVideo(video, performance.now());
      const faces = res.faceLandmarks || [];
      let isViolating = false;
      let pose = null;

      // 1. Multiple Faces
      if (faces.length > 1) {
        isViolating = true;
        multiFaceDetector.update(
          true,
          "Multiple Faces Detected",
          `Another person detected in view (${faces.length} faces visible).`
        );
      } else {
        multiFaceDetector.update(false);
      }

      // 2. Face Absence
      if (faces.length === 0) {
        isViolating = true;
        noFaceDetector.update(
          true,
          "Face Not Visible in Camera",
          "Candidate has moved out of camera frame."
        );
      } else {
        noFaceDetector.update(false);
      }

      // 3. Single Face: Pose & Gaze Analysis
      if (faces.length === 1) {
        pose = calculateHeadPose(faces[0]);
        const { yaw, pitch } = pose;

        // Yaw check: Looking left or right
        const isTurning = yaw < CFG.YAW_LOW || yaw > CFG.YAW_HIGH;
        const turnDirection = yaw < CFG.YAW_LOW ? "Looking Left" : "Looking Right";
        if (isTurning) {
          isViolating = true;
          headTurnDetector.update(
            true,
            `Suspicious Head Turn (${turnDirection})`,
            `Head turned away from screen. Yaw ratio: ${yaw.toFixed(2)}.`
          );
        } else {
          headTurnDetector.update(false);
        }

        // Pitch check: Looking down (notes/phone) or looking up
        const isPitchOff = pitch < CFG.PITCH_LOW || pitch > CFG.PITCH_HIGH;
        const pitchDirection = pitch > CFG.PITCH_HIGH ? "Looking Down at Desk/Phone" : "Looking Up";
        if (isPitchOff) {
          isViolating = true;
          headPitchDetector.update(
            true,
            `Suspicious Head Posture (${pitchDirection})`,
            `Head angled away from screen. Pitch ratio: ${pitch.toFixed(2)}.`
          );
        } else {
          headPitchDetector.update(false);
        }

        // Gaze check: Iris sideways
        const gaze = calculateGaze(faces[0]);
        const isGazeAway = gaze !== null && (gaze < CFG.GAZE_LOW || gaze > CFG.GAZE_HIGH);
        if (isGazeAway) {
          isViolating = true;
          gazeDetector.update(
            true,
            "Sideways Eye Gaze Detected",
            `Eyes looking away from screen. Gaze ratio: ${gaze.toFixed(2)}.`
          );
        } else {
          gazeDetector.update(false);
        }

        // Update real-time telemetry meters in sidebar
        if (telemetryYaw) {
          const yawDeg = Math.round((yaw - 0.5) * 80);
          telemetryYaw.textContent = `${yawDeg > 0 ? "+" : ""}${yawDeg}° ${isTurning ? "⚠️" : "✓"}`;
          telemetryYaw.className = isTurning ? "tel-value tel-warn" : "tel-value tel-good";
        }
        if (telemetryPitch) {
          const pitchDeg = Math.round((pitch - 0.46) * 80);
          telemetryPitch.textContent = `${pitchDeg > 0 ? "+" : ""}${pitchDeg}° ${isPitchOff ? "⚠️" : "✓"}`;
          telemetryPitch.className = isPitchOff ? "tel-value tel-warn" : "tel-value tel-good";
        }
        if (telemetryGaze) {
          telemetryGaze.textContent = isGazeAway ? "Looking Away ⚠️" : "Screen Centered ✓";
          telemetryGaze.className = isGazeAway ? "tel-value tel-warn" : "tel-value tel-good";
        }
        if (telemetryFaces) {
          telemetryFaces.textContent = "1 Candidate ✓";
          telemetryFaces.className = "tel-value tel-good";
        }
      } else {
        headTurnDetector.update(false);
        headPitchDetector.update(false);
        gazeDetector.update(false);
        if (telemetryFaces) {
          telemetryFaces.textContent = `${faces.length} Faces ⚠️`;
          telemetryFaces.className = "tel-value tel-warn";
        }
      }

      // Draw canvas HUD overlays
      drawHUD(faces, pose, null, isViolating);
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// ---- ai_exam_camera Trained Model Sampling -------------------------------
// Sends periodic JPEG snapshots to the Flask server for trained-CNN inference.
// The underlying live video stream is never streamed or recorded.
let aiFrameInFlight = false;
let aiSuspiciousStreak = 0;
let lastAIWarningTime = 0;

async function submitAIFrame() {
  if (isExamTerminated || aiFrameInFlight || !video || video.readyState < 2) return;
  aiFrameInFlight = true;

  try {
    const snapshot = document.createElement("canvas");
    snapshot.width = 320;
    snapshot.height = 240;
    snapshot.getContext("2d").drawImage(video, 0, 0, snapshot.width, snapshot.height);

    const response = await fetch("/api/ai/frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: snapshot.toDataURL("image/jpeg", 0.7) }),
    });
    const payload = await response.json();

    if (payload.ok) {
      if (statusEl) statusEl.textContent = `AI Model: ${payload.ai.behavior}`;

      if (payload.suspicious && payload.event_type) {
        aiSuspiciousStreak += 1;
        const labels = {
          NO_FACE: ["Candidate Absent", "ai_exam_camera detected that no candidate is visible."],
          MULTIPLE_FACES: ["Multiple People Detected", "ai_exam_camera detected more than one person."],
          HEAD_TURN: ["Suspicious Head Turn", "ai_exam_camera classified the candidate as looking sideways."],
          HEAD_DOWN: ["Looking Down", "ai_exam_camera detected a down-facing posture."],
          HEAD_UP: ["Looking Up", "ai_exam_camera detected an unusual up-facing posture."],
          PHONE_VISIBLE: ["Unauthorized Phone", "ai_exam_camera detected a visible phone or device."],
        };
        const label = labels[payload.event_type];
        if (label) {
          const now = Date.now() / 1000;
          const aiConfidence = payload.ai?.confidence || 0;
          const requiredStreak = payload.event_type === "PHONE_VISIBLE" ? 2 : 3;
          const confidenceAccepted = payload.event_type !== "PHONE_VISIBLE" || aiConfidence >= 0.60;
          if (confidenceAccepted && aiSuspiciousStreak >= requiredStreak && now - lastAIWarningTime > 12) {
            lastAIWarningTime = now;
            aiSuspiciousStreak = 0;
            triggerWarning(payload.event_type, label[0], label[1]);
          }
        }
      } else {
        aiSuspiciousStreak = 0;
      }
    } else if (payload.unavailable) {
      if (statusEl) statusEl.textContent = "Browser AI Active (Trained server model unavailable)";
    }
  } catch (err) {
    console.warn("ai_exam_camera frame analysis failed:", err);
  } finally {
    aiFrameInFlight = false;
  }
}

// Start proctoring engine
initProctoring();
setInterval(submitAIFrame, 4000);
