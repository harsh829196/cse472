
from flask import Flask, request, jsonify, send_file
import csv
import os

app = Flask(__name__)

CSV_FILE = "feedback.csv"

if not os.path.exists(CSV_FILE):
    with open(CSV_FILE, "w", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["Name", "Register Number", "Subject", "Feedback"])


@app.route("/")
def home():
    return send_file("index.html")


@app.route("/style.css")
def css():
    return send_file("style.css", mimetype="text/css")


@app.route("/script.js")
def javascript():
    return send_file("script.js", mimetype="application/javascript")


@app.route("/submit", methods=["POST"])
def submit():

    data = request.get_json()

    name = data.get("name", "").strip()
    register = data.get("register", "").strip()
    subject = data.get("subject", "").strip()
    feedback = data.get("feedback", "").strip()

    if not all([name, register, subject, feedback]):
        return jsonify({"message": "All fields are required!"}), 400

    with open(CSV_FILE, "a", newline="") as file:
        writer = csv.writer(file)
        writer.writerow([name, register, subject, feedback])

    return jsonify({"message": "Feedback submitted successfully!"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
