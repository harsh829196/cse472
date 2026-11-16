# ProctorLite

AI-assisted exam proctoring (Flask + MediaPipe). Flags suspicious events for
**human review**; never auto-penalises.

## Run
```
pip install -r requirements.txt
python app.py
```
Open http://localhost:5000 (webcam needs localhost or HTTPS). Invigilator view: `/dashboard`.

## Structure
```
app.py                 Flask backend, SQLite, dashboard, reports
templates/             consent, exam, done, dashboard, session, report
static/proctor.js      Browser CV (MediaPipe) + tab/focus monitoring
static/style.css
evaluation/evaluate.py Precision / recall / F1 from ground_truth.csv
```

## Privacy design
- Face analysis runs in the browser; no video/images are uploaded.
- Only event type, timestamp, duration and a short detail string are stored.
- Consent is required before the exam; the monitored items are listed up front.

## TODO (your improvements)
- [ ] Enforce RETENTION_DAYS (delete old sessions)
- [ ] Invigilator login (env-var password)
- [ ] Calibrate head-pose / gaze thresholds on real recordings
- [ ] Proper PDF report + class-level summary (`/report`)
- [ ] False-positive rate and threshold sweep in evaluation
- [ ] Architecture diagram, technical docs, demo video
