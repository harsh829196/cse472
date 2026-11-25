"""ProctorLite - AI-assisted exam proctoring (Flask backend).

The computer vision runs in the student's browser (static/proctor.js).
This backend only stores small event records (type + timestamp + duration),
never video or images, and serves the invigilator dashboard and reports.
"""
import os
import sqlite3
import sys
import time
import uuid
import base64
import importlib
from functools import wraps

from flask import (Flask, abort, jsonify, redirect, render_template, request,
                   session, url_for)

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "proctor-lite-secure-dev-key-2026")
DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proctor.db")

AI_CAMERA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "ai_exam_camera"))
AI_MODEL_PATH = os.path.join(AI_CAMERA_DIR, "exam_proctor_model.pth")
AI_ENGINE = None

# Retention policy shown on the consent page
RETENTION_DAYS = 30
MAX_WARNINGS_LIMIT = 5

# Weights for the suspicion score. Tune these. The score only ranks sessions
# for human review; it never penalizes anyone automatically.
WEIGHTS = {
    "MULTIPLE_FACES": 5,
    "NO_FACE": 3,
    "HEAD_TURN": 2,
    "HEAD_DOWN": 2,
    "HEAD_UP": 2,
    "GAZE_AWAY": 1,
    "TAB_SWITCH": 3,
    "FOCUS_LOSS": 2,
    "FULLSCREEN_EXIT": 2,
    "WINDOW_SLIDE": 3,
    "WINDOW_RESIZE": 2,
    "WARNING_STRIKE": 4,
    "AUTO_SUBMIT_VIOLATIONS": 10,
    "CLIPBOARD_ATTEMPT": 1,
    "CAMERA_ERROR": 2,
    "PHONE_VISIBLE": 5,
}

# Simulated exam questions.
QUESTIONS = [
    {
        "id": 1,
        "q": "What is the time complexity of searching in a balanced Binary Search Tree (BST)?",
        "options": ["O(n)", "O(log n)", "O(n log n)", "O(1)"],
        "answer": "O(log n)"
    },
    {
        "id": 2,
        "q": "Which of the following is a supervised machine learning algorithm?",
        "options": ["K-Means Clustering", "Principal Component Analysis (PCA)", "Linear Regression", "DBSCAN"],
        "answer": "Linear Regression"
    },
    {
        "id": 3,
        "q": "Which HTTP method is defined as idempotent according to the RFC specification?",
        "options": ["POST", "PUT", "PATCH (non-standard)", "CONNECT"],
        "answer": "PUT"
    },
    {
        "id": 4,
        "q": "In relational database queries, what is the primary role of the GROUP BY clause?",
        "options": ["Sorts output rows", "Aggregates rows sharing common values into summary rows", "Performs outer joins", "Deletes redundant records"],
        "answer": "Aggregates rows sharing common values into summary rows"
    },
    {
        "id": 5,
        "q": "Which fundamental data structure operates strictly under First-In, First-Out (FIFO) ordering?",
        "options": ["Stack", "Queue", "Binary Heap", "Trie"],
        "answer": "Queue"
    },
]


# ---------------------------------------------------------------- database
def db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS sessions(
            session_id TEXT PRIMARY KEY,
            student_id TEXT NOT NULL,
            consent_at REAL NOT NULL,
            ended_at REAL,
            ended_reason TEXT DEFAULT 'Submitted normally',
            warnings_count INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS events(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            ts REAL NOT NULL,
            event_type TEXT NOT NULL,
            duration REAL DEFAULT 0,
            details TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS reviews(
            session_id TEXT PRIMARY KEY,
            decision TEXT,
            notes TEXT,
            reviewed_at REAL
        );
        CREATE TABLE IF NOT EXISTS answers(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            question_id INTEGER NOT NULL,
            selected_option TEXT
        );
        """)
        # Backward-compatible table migrations
        try:
            c.execute("ALTER TABLE sessions ADD COLUMN ended_reason TEXT DEFAULT 'Submitted normally'")
        except sqlite3.OperationalError:
            pass
        try:
            c.execute("ALTER TABLE sessions ADD COLUMN warnings_count INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass


init_db()


def suspicion_score(events):
    return sum(WEIGHTS.get(e["event_type"], 1) for e in events)


def fmt_time(ts):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) if ts else "-"


def fmt_duration(seconds):
    if not seconds:
        return "-"
    m, s = divmod(int(seconds), 60)
    return f"{m}m {s}s"


app.jinja_env.filters["fmt_time"] = fmt_time
app.jinja_env.filters["fmt_duration"] = fmt_duration


# ----------------------------------------------------------- student side
@app.route("/")
def consent():
    return render_template("consent.html", retention_days=RETENTION_DAYS, max_warnings=MAX_WARNINGS_LIMIT)


@app.route("/consent", methods=["POST"])
def consent_submit():
    student_id = request.form.get("student_id", "").strip()
    if not student_id or request.form.get("agree") != "on":
        return redirect(url_for("consent"))
    sid = uuid.uuid4().hex[:12]
    with db() as c:
        c.execute("INSERT INTO sessions(session_id, student_id, consent_at, ended_reason, warnings_count) VALUES(?,?,?,?,?)",
                  (sid, student_id, time.time(), "In progress", 0))
    session["session_id"] = sid
    session["student_id"] = student_id
    return redirect(url_for("exam"))


@app.route("/exam")
def exam():
    if "session_id" not in session:
        return redirect(url_for("consent"))
    return render_template("exam.html",
                           questions=QUESTIONS,
                           session_id=session["session_id"],
                           student_id=session["student_id"],
                           max_warnings=MAX_WARNINGS_LIMIT)


@app.route("/api/events", methods=["POST"])
def add_events():
    sid = session.get("session_id")
    if not sid:
        abort(403)
    events = request.get_json(silent=True) or []
    with db() as c:
        for e in events:
            c.execute(
                "INSERT INTO events(session_id, ts, event_type, duration, details) VALUES(?,?,?,?,?)",
                (sid, e.get("ts", time.time()), e["event_type"],
                 e.get("duration", 0), str(e.get("details", ""))[:250]))
    return jsonify(ok=True, stored=len(events))


@app.route("/api/end", methods=["POST"])
def end_exam():
    sid = session.get("session_id")
    if not sid:
        abort(403)
    data = request.get_json(silent=True) or {}
    reason = data.get("reason", "Submitted normally")
    warnings = int(data.get("warnings", 0))
    answers = data.get("answers", {})

    with db() as c:
        c.execute(
            "UPDATE sessions SET ended_at=?, ended_reason=?, warnings_count=? WHERE session_id=?",
            (time.time(), reason, warnings, sid)
        )
        if answers and isinstance(answers, dict):
            for q_key, opt in answers.items():
                try:
                    q_id = int(str(q_key).replace("q", ""))
                    c.execute(
                        "INSERT INTO answers(session_id, question_id, selected_option) VALUES(?,?,?)",
                        (sid, q_id, str(opt))
                    )
                except Exception:
                    pass
    return jsonify(ok=True)


@app.route("/done")
def done():
    sid = session.get("session_id")
    s_info = None
    strikes = 0
    if sid:
        with db() as c:
            s_info = c.execute("SELECT * FROM sessions WHERE session_id=?", (sid,)).fetchone()
            if s_info:
                strikes = s_info["warnings_count"] or 0
    reason_param = request.args.get("reason", "")
    session.clear()
    return render_template("done.html", s=s_info, strikes=strikes, reason_param=reason_param)


# ------------------------------------------------------ invigilator side
@app.route("/dashboard")
def dashboard():
    rows = []
    total_sessions = 0
    clean_sessions = 0
    flagged_sessions = 0
    auto_terminated_sessions = 0

    with db() as c:
        sessions_list = c.execute("SELECT * FROM sessions ORDER BY consent_at DESC").fetchall()
        for s in sessions_list:
            evs = c.execute("SELECT * FROM events WHERE session_id=?", (s["session_id"],)).fetchall()
            rev = c.execute("SELECT * FROM reviews WHERE session_id=?", (s["session_id"],)).fetchone()
            score = suspicion_score(evs)
            warnings = s["warnings_count"] or 0
            is_terminated = warnings >= MAX_WARNINGS_LIMIT or "5 warnings" in (s["ended_reason"] or "").lower()

            # Severity tier
            if is_terminated:
                risk_tier = "CRITICAL"
                badge_class = "badge-danger"
            elif score >= 10 or warnings >= 3:
                risk_tier = "HIGH"
                badge_class = "badge-danger"
            elif score >= 4 or warnings >= 1:
                risk_tier = "MEDIUM"
                badge_class = "badge-warning"
            else:
                risk_tier = "LOW"
                badge_class = "badge-success"

            total_sessions += 1
            if is_terminated:
                auto_terminated_sessions += 1
            if score >= 6 or warnings >= 2:
                flagged_sessions += 1
            else:
                clean_sessions += 1

            rows.append({
                "s": s,
                "n": len(evs),
                "score": score,
                "warnings": warnings,
                "decision": rev["decision"] if rev else "Pending",
                "risk_tier": risk_tier,
                "badge_class": badge_class,
                "is_terminated": is_terminated,
            })

    rows.sort(key=lambda r: (1 if r["is_terminated"] else 0, r["score"]), reverse=True)
    return render_template("dashboard.html",
                           rows=rows,
                           stats={
                               "total": total_sessions,
                               "clean": clean_sessions,
                               "flagged": flagged_sessions,
                               "terminated": auto_terminated_sessions,
                           })


def load_session(sid):
    with db() as c:
        s = c.execute("SELECT * FROM sessions WHERE session_id=?", (sid,)).fetchone()
        if not s:
            abort(404)
        evs = c.execute("SELECT * FROM events WHERE session_id=? ORDER BY ts", (sid,)).fetchall()
        rev = c.execute("SELECT * FROM reviews WHERE session_id=?", (sid,)).fetchone()
        ans_rows = c.execute("SELECT * FROM answers WHERE session_id=? ORDER BY question_id", (sid,)).fetchall()

    counts = {}
    warning_events = []
    for e in evs:
        counts[e["event_type"]] = counts.get(e["event_type"], 0) + 1
        if "WARNING" in e["event_type"] or "STRIKE" in e["event_type"]:
            warning_events.append(e)

    duration = 0
    if s["ended_at"] and s["consent_at"]:
        duration = s["ended_at"] - s["consent_at"]

    answers = {a["question_id"]: a["selected_option"] for a in ans_rows}
    return s, evs, rev, counts, warning_events, duration, answers


@app.route("/session/<sid>")
def session_detail(sid):
    s, evs, rev, counts, warning_events, duration, answers = load_session(sid)
    score = suspicion_score(evs)
    warnings = s["warnings_count"] or 0
    is_terminated = warnings >= MAX_WARNINGS_LIMIT or "5 warnings" in (s["ended_reason"] or "").lower()

    return render_template("session.html",
                           s=s,
                           events=evs,
                           review=rev,
                           counts=counts,
                           warning_events=warning_events,
                           score=score,
                           warnings=warnings,
                           duration=duration,
                           answers=answers,
                           questions=QUESTIONS,
                           is_terminated=is_terminated,
                           max_warnings=MAX_WARNINGS_LIMIT)


@app.route("/session/<sid>/review", methods=["POST"])
def review_submit(sid):
    decision = request.form.get("decision", "Needs follow-up")
    notes = request.form.get("notes", "")[:1000]
    with db() as c:
        c.execute("""INSERT INTO reviews(session_id, decision, notes, reviewed_at)
                     VALUES(?,?,?,?)
                     ON CONFLICT(session_id) DO UPDATE SET
                     decision=excluded.decision, notes=excluded.notes,
                     reviewed_at=excluded.reviewed_at""",
                  (sid, decision, notes, time.time()))
    return redirect(url_for("session_detail", sid=sid))


@app.route("/report/<sid>")
def report(sid):
    s, evs, rev, counts, warning_events, duration, answers = load_session(sid)
    score = suspicion_score(evs)
    warnings = s["warnings_count"] or 0
    is_terminated = warnings >= MAX_WARNINGS_LIMIT or "5 warnings" in (s["ended_reason"] or "").lower()

    return render_template("report.html",
                           s=s,
                           events=evs,
                           review=rev,
                           counts=counts,
                           warning_events=warning_events,
                           score=score,
                           warnings=warnings,
                           duration=duration,
                           answers=answers,
                           questions=QUESTIONS,
                           is_terminated=is_terminated)


@app.route("/report")
def class_report():
    """Class-level summary for the examination cell (table + aggregated metrics)."""
    with db() as c:
        sessions_list = c.execute("SELECT * FROM sessions ORDER BY consent_at DESC").fetchall()
        all_events = c.execute("SELECT * FROM events").fetchall()
        reviews = {r["session_id"]: r for r in c.execute("SELECT * FROM reviews").fetchall()}

    event_totals = {}
    for e in all_events:
        event_totals[e["event_type"]] = event_totals.get(e["event_type"], 0) + 1

    session_rows = []
    total_score = 0
    flagged_count = 0
    auto_terminated_count = 0

    for s in sessions_list:
        evs = [e for e in all_events if e["session_id"] == s["session_id"]]
        score = suspicion_score(evs)
        total_score += score
        warnings = s["warnings_count"] or 0
        is_term = warnings >= MAX_WARNINGS_LIMIT or "5 warnings" in (s["ended_reason"] or "").lower()
        if is_term:
            auto_terminated_count += 1
        if score >= 6 or warnings >= 2:
            flagged_count += 1

        rev = reviews.get(s["session_id"])
        session_rows.append({
            "s": s,
            "event_count": len(evs),
            "score": score,
            "warnings": warnings,
            "is_terminated": is_term,
            "decision": rev["decision"] if rev else "Pending",
        })

    total_sessions = len(sessions_list)
    avg_score = round(total_score / total_sessions, 1) if total_sessions else 0
    compliance_rate = round(((total_sessions - flagged_count) / total_sessions) * 100, 1) if total_sessions else 100

    return render_template("report_class.html",
                           total_sessions=total_sessions,
                           flagged_count=flagged_count,
                           auto_terminated_count=auto_terminated_count,
                           avg_score=avg_score,
                           compliance_rate=compliance_rate,
                           event_totals=event_totals,
                           rows=session_rows)


def get_ai_engine():
    """Lazy-load the trained exam behavior classifier from ai_exam_camera."""
    global AI_ENGINE
    if AI_ENGINE is not None:
        return AI_ENGINE

    if not os.path.exists(AI_MODEL_PATH):
        return None

    try:
        if AI_CAMERA_DIR not in sys.path:
            sys.path.insert(0, AI_CAMERA_DIR)
        engine_module = importlib.import_module("proctor_engine")

        AI_ENGINE = engine_module.ExamProctorEngine(model_path=AI_MODEL_PATH, smoothing_window=15, min_confidence=0.55)
        return AI_ENGINE
    except Exception as exc:
        app.logger.warning("AI camera engine unavailable: %s", exc)
        return None


@app.route("/api/ai/frame", methods=["POST"])
def analyze_ai_frame():
    """Analyze one browser-captured frame with the trained ai_exam_camera model."""
    sid = session.get("session_id")
    if not sid:
        abort(403)

    data = request.get_json(silent=True) or {}
    image_b64 = data.get("image", "")
    if not image_b64:
        return jsonify(ok=False, error="No image frame provided"), 400

    engine = get_ai_engine()
    if engine is None:
        return jsonify(ok=False, unavailable=True, error="AI model runtime unavailable")

    try:
        import cv2
        import numpy as np

        payload = image_b64.split(",", 1)[-1]
        encoded = base64.b64decode(payload)
        frame = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return jsonify(ok=False, error="Could not decode frame"), 400

        result = engine.process_frame(frame, draw_overlay=False)
        result_payload = result.to_dict()

        event_type = None
        behavior = result.behavior
        if result.violation_code == "NO_CANDIDATE_DETECTED":
            event_type = "NO_FACE"
        elif result.violation_code == "MULTIPLE_PEOPLE":
            event_type = "MULTIPLE_FACES"
        elif behavior == "phone_visible":
            event_type = "PHONE_VISIBLE"

        if event_type and result.is_suspicious:
            with db() as c:
                c.execute(
                    "INSERT INTO events(session_id, ts, event_type, duration, details) VALUES(?,?,?,?,?)",
                    (sid, time.time(), event_type, 0,
                     f"ai_exam_camera: {result.alert_message} ({result.confidence:.2f})")
                )

        return jsonify(ok=True, ai=result_payload,
                       suspicious=bool(result.is_suspicious), event_type=event_type)
    except Exception as exc:
        app.logger.exception("AI frame analysis failed")
        return jsonify(ok=False, error=str(exc)[:200]), 500


if __name__ == "__main__":
    # Webcam access needs localhost or HTTPS. localhost works fine for the demo.
    app.run(debug=True, port=5000)
