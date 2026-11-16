"""ProctorLite - AI-assisted exam proctoring (Flask backend).

The computer vision runs in the student's browser (static/proctor.js).
This backend only stores small event records (type + timestamp + duration),
never video or images, and serves the invigilator dashboard and reports.
"""
import os
import sqlite3
import time
import uuid

from flask import (Flask, abort, jsonify, redirect, render_template, request,
                   session, url_for)

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-change-me")
DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proctor.db")

# Retention policy shown on the consent page (TODO: actually enforce it).
RETENTION_DAYS = 30

# Weights for the suspicion score. Tune these. The score only ranks sessions
# for human review; it never penalizes anyone automatically.
WEIGHTS = {
    "MULTIPLE_FACES": 5,
    "NO_FACE": 3,
    "HEAD_TURN": 1,
    "GAZE_AWAY": 1,
    "TAB_SWITCH": 3,
    "FOCUS_LOSS": 2,
    "FULLSCREEN_EXIT": 2,
    "CLIPBOARD_ATTEMPT": 1,
}

# Simulated exam. Replace with your own questions or load from a JSON file.
QUESTIONS = [
    {"id": 1, "q": "What is the time complexity of binary search?",
     "options": ["O(n)", "O(log n)", "O(n log n)", "O(1)"]},
    {"id": 2, "q": "Which of these is a supervised learning algorithm?",
     "options": ["K-means", "PCA", "Linear regression", "DBSCAN"]},
    {"id": 3, "q": "Which HTTP method is idempotent?",
     "options": ["POST", "PUT", "PATCH (always)", "None"]},
    {"id": 4, "q": "What does SQL's GROUP BY do?",
     "options": ["Sorts rows", "Aggregates rows by key", "Joins tables", "Deletes rows"]},
    {"id": 5, "q": "Which data structure uses FIFO ordering?",
     "options": ["Stack", "Queue", "Tree", "Heap"]},
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
            ended_at REAL
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
        """)


init_db()


def suspicion_score(events):
    return sum(WEIGHTS.get(e["event_type"], 1) for e in events)


def fmt_time(ts):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) if ts else "-"


app.jinja_env.filters["fmt_time"] = fmt_time


# ----------------------------------------------------------- student side
@app.route("/")
def consent():
    return render_template("consent.html", retention_days=RETENTION_DAYS)


@app.route("/consent", methods=["POST"])
def consent_submit():
    student_id = request.form.get("student_id", "").strip()
    if not student_id or request.form.get("agree") != "on":
        return redirect(url_for("consent"))
    sid = uuid.uuid4().hex[:12]
    with db() as c:
        c.execute("INSERT INTO sessions(session_id, student_id, consent_at) VALUES(?,?,?)",
                  (sid, student_id, time.time()))
    session["session_id"] = sid
    session["student_id"] = student_id
    return redirect(url_for("exam"))


@app.route("/exam")
def exam():
    if "session_id" not in session:
        return redirect(url_for("consent"))
    return render_template("exam.html", questions=QUESTIONS,
                           session_id=session["session_id"],
                           student_id=session["student_id"])


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
                 e.get("duration", 0), str(e.get("details", ""))[:200]))
    return jsonify(ok=True, stored=len(events))


@app.route("/api/end", methods=["POST"])
def end_exam():
    sid = session.get("session_id")
    if not sid:
        abort(403)
    with db() as c:
        c.execute("UPDATE sessions SET ended_at=? WHERE session_id=?", (time.time(), sid))
    return jsonify(ok=True)


@app.route("/done")
def done():
    session.clear()
    return render_template("done.html")


# ------------------------------------------------------ invigilator side
# TODO: protect these routes (simple password login via env var is enough).
@app.route("/dashboard")
def dashboard():
    rows = []
    with db() as c:
        for s in c.execute("SELECT * FROM sessions ORDER BY consent_at DESC"):
            evs = c.execute("SELECT * FROM events WHERE session_id=?", (s["session_id"],)).fetchall()
            rev = c.execute("SELECT * FROM reviews WHERE session_id=?", (s["session_id"],)).fetchone()
            rows.append({"s": s, "n": len(evs), "score": suspicion_score(evs),
                         "decision": rev["decision"] if rev else "Pending"})
    rows.sort(key=lambda r: r["score"], reverse=True)
    return render_template("dashboard.html", rows=rows)


def load_session(sid):
    with db() as c:
        s = c.execute("SELECT * FROM sessions WHERE session_id=?", (sid,)).fetchone()
        if not s:
            abort(404)
        evs = c.execute("SELECT * FROM events WHERE session_id=? ORDER BY ts", (sid,)).fetchall()
        rev = c.execute("SELECT * FROM reviews WHERE session_id=?", (sid,)).fetchone()
    counts = {}
    for e in evs:
        counts[e["event_type"]] = counts.get(e["event_type"], 0) + 1
    return s, evs, rev, counts


@app.route("/session/<sid>")
def session_detail(sid):
    s, evs, rev, counts = load_session(sid)
    return render_template("session.html", s=s, events=evs, review=rev,
                           counts=counts, score=suspicion_score(evs))


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
    s, evs, rev, counts = load_session(sid)
    return render_template("report.html", s=s, events=evs, review=rev,
                           counts=counts, score=suspicion_score(evs))


@app.route("/report")
def class_report():
    """TODO: class-level summary for the examination cell (table + charts)."""
    return redirect(url_for("dashboard"))


if __name__ == "__main__":
    # Webcam access needs localhost or HTTPS. localhost works fine for the demo.
    app.run(debug=True, port=5000)
