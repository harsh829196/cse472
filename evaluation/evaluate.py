"""Evaluation stub: precision / recall / F1 / false-positive rate per event type.

Workflow
1. Run scripted test sessions. While performing each action, note the time and
   write it to ground_truth.csv:  session_id,start_ts,end_ts,event_type
   (leave out rows for "normal behaviour" periods; those count as negatives.)
2. Run:  python evaluation/evaluate.py
   It reads detected events from proctor.db and compares them to the labels.

A detected event counts as a true positive if a labelled event of the same type
overlaps it within +/- TOLERANCE seconds.
"""
import csv
import os
import sqlite3
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "..", "proctor.db")
TRUTH = os.path.join(HERE, "ground_truth.csv")
TOLERANCE = 3.0

TYPES = ["MULTIPLE_FACES", "NO_FACE", "HEAD_TURN", "GAZE_AWAY",
         "TAB_SWITCH", "FOCUS_LOSS", "FULLSCREEN_EXIT"]


def load_truth():
    truth = defaultdict(list)  # (session, type) -> [(start, end)]
    with open(TRUTH, newline="") as f:
        for r in csv.DictReader(f):
            truth[(r["session_id"], r["event_type"])].append(
                (float(r["start_ts"]), float(r["end_ts"])))
    return truth


def load_detected():
    det = defaultdict(list)  # (session, type) -> [ts]
    with sqlite3.connect(DB) as c:
        for sid, ts, et in c.execute("SELECT session_id, ts, event_type FROM events"):
            det[(sid, et)].append(ts)
    return det


def main():
    truth, det = load_truth(), load_detected()
    sessions = {s for s, _ in truth} | {s for s, _ in det}
    print(f"{'event type':<16}{'TP':>4}{'FP':>4}{'FN':>4}{'prec':>7}{'recall':>8}{'F1':>6}")
    for et in TYPES:
        tp = fp = fn = 0
        for sid in sessions:
            labels = truth.get((sid, et), [])
            events = det.get((sid, et), [])
            matched = set()
            for ts in events:
                hit = next((i for i, (a, b) in enumerate(labels)
                            if a - TOLERANCE <= ts <= b + TOLERANCE), None)
                if hit is None:
                    fp += 1
                else:
                    tp += 1
                    matched.add(hit)
            fn += len(labels) - len(matched)
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        print(f"{et:<16}{tp:>4}{fp:>4}{fn:>4}{prec:>7.2f}{rec:>8.2f}{f1:>6.2f}")
    # TODO: false-positive rate = FP per hour of *normal* behaviour. Record how
    # many minutes of clean behaviour each session contains and divide.
    # TODO: threshold sweep - rerun with different CFG values in proctor.js.


if __name__ == "__main__":
    main()
