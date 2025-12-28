# ADABRA

ADABRA is a real-time, buzzer-based quiz game designed for classrooms, workshops, and live knowledge competitions.

Inspired by the classic “Brain Ring” format, ADABRA allows a presenter to host a game session where teams compete by pressing a buzzer to earn the right to answer questions. The system enforces fair play through server-side timing, lockout rules, and real-time synchronization.

---

## 🚀 Features

- Real-time buzzer system (first press gets chance to answer)
- Server-authoritative logic (fair and deterministic)
- Instant synchronization across all connected players
- Simple host-controlled game flow
- No client-side cheating (clients only send events)
- Lightweight and fast - works well on classroom networks

---

## 🧠 Game Rules (Core Logic)

1. The presenter starts a question.
2. Teams wait for the buzzer to be armed.
3. The first team to press the buzzer gains the right to answer.
4. While a team is answering:
   - All other buzzers are locked.
5. If the answer is incorrect:
   - The timer resumes.
   - The answering team is locked out for that question.
6. If no team buzzes before time expires:
   - The question ends with no points awarded.
7. Scores are controlled by the presenter.

All timing and lockout logic is enforced by the server to ensure fairness.

---

## 🛠 Tech Stack (Current Phase)

- **Node.js**
- **Express**
- **Socket.IO**
- **Vanilla HTML / CSS / JavaScript**

The project intentionally starts with a minimal stack to focus on correctness, clarity, and reliability of the real-time game logic.

---

## 📦 Installation & Running Locally

```bash
npm install
npm start