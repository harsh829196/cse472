
const form = document.getElementById("feedbackForm");

form.addEventListener("submit", async function(event) {

    event.preventDefault();

    const data = {
        name: document.getElementById("name").value.trim(),
        register: document.getElementById("register").value.trim(),
        subject: document.getElementById("subject").value.trim(),
        feedback: document.getElementById("feedback").value.trim()
    };

    try {
        const response = await fetch("/submit", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        document.getElementById("message").textContent = result.message;

        document.getElementById("message").style.color =
            response.ok ? "green" : "red";

        if (response.ok) {
            form.reset();
        }

    } catch (error) {
        document.getElementById("message").textContent =
            "Something went wrong!";
    }
});
